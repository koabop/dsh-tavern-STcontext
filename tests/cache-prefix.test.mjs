import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compilePreset, parsePreset } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { buildProtocolBody } from '../lib/protocol-transport.mjs';

const settings = { model: { provider: 'fixture', model: 'story' } };
const section = (id, kind, text) => ({ id, kind, text, source: 'tavern' });
function preset({ markers = true, depths = [] } = {}) {
  const prompts = [
    { identifier: 'main', role: 'system', content: '[FIXED_PROMPT]' },
    ...(markers ? ['charDescription', 'worldInfoAfter', 'chatHistory'].map(identifier => ({ identifier, marker: true, role: 'system' })) : []),
    ...depths.map(depth => ({ identifier: 'depth-' + depth, role: 'system', content: '[DEPTH_' + depth + ']', injection_position: 1, injection_depth: depth })),
  ];
  return { prompts, prompt_order: [{ character_id: 100001, order: prompts.map(({ identifier }) => ({ identifier, enabled: true })) }] };
}
function snapshot() {
  return {
    schemaVersion: 1, gameId: 'cache-prefix', operationId: 'turn-a', reason: 'normal',
    input: { raw: '[INPUT_A]', text: '[INPUT_A]' },
    history: Array.from({ length: 80 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '[HISTORY_' + index + ']' + '完整历史。'.repeat(20) })),
    context: [
      section('character', 'character', '[CHARACTER]'),
      section('persona', 'persona', '[PERSONA]'),
      // Deliberately put the dynamic section first: its position in the DTO
      // must not cause it to precede the stable history in the model request.
      section('tavern:worldbook', 'worldbook', '[LORE_A]'),
      section('tavern:constant-worldbook', 'worldbook', '[CONSTANT_LORE]'),
      section('rules', 'writing-rules', '[WRITING_RULES]'),
      section('guide', 'guide', '[GUIDE_A]'),
      section('script', 'script', '[SCRIPT_REFERENCE]'),
      section('other', 'other', '[OTHER_MATERIAL]'),
    ],
    identities: { playerName: '测试玩家', characterName: '测试角色' },
    state: { variables: { turn: 40 }, messageVariables: { count: 80 }, status: '[STATE_A]' },
    guidance: '[GUIDANCE_A]',
  };
}
function nextTurn(previous, { state = true, lore = true, guide = true } = {}) {
  const next = structuredClone(previous);
  next.operationId = 'turn-b';
  next.history.push({ role: 'user', text: previous.input.text }, { role: 'assistant', text: '[GENERATED_A]' });
  next.input = { raw: '[INPUT_B]', text: '[INPUT_B]' };
  if (state) next.state = { variables: { turn: 41 }, messageVariables: { count: 82 }, status: '[STATE_B]' };
  if (lore) next.context.find(item => item.id === 'tavern:worldbook').text = '[LORE_B]';
  if (guide) {
    next.context.find(item => item.kind === 'guide').text = '[GUIDE_B]';
    next.guidance = '[GUIDANCE_B]';
  }
  return next;
}
const compile = (host, document = preset()) => compilePreset(document, compilerMaterials(host), settings);
const messageIndex = (messages, text) => {
  const index = messages.findIndex(message => message.content?.includes(text));
  assert.ok(index >= 0, 'missing material: ' + text.slice(0, 40));
  return index;
};
const modelText = request => [...request.messages.map(message => message.content || ''), ...(request.tools || []).map(tool => tool.description)].join('\n');
function assertAllMaterials(request, host, { allowAdditional = false } = {}) {
  const expected = [...host.context.map(item => item.text), ...host.history.map(item => item.text), host.input.text, host.guidance,
    JSON.stringify({ variables: host.state.variables, messageVariables: host.state.messageVariables, posture: host.state.status })].filter(Boolean);
  const counts = new Map();
  for (const text of expected) counts.set(text, (counts.get(text) || 0) + 1);
  const sent = modelText(request);
  for (const [text, count] of counts) {
    const actual = sent.split(text).length - 1, label = 'material occurrence count: ' + text.slice(0, 40);
    if (allowAdditional) assert.ok(actual >= count, label);
    else assert.equal(actual, count, label);
  }
}

test('host constant-worldbook identity keeps only constant lore before history', () => {
  const host = snapshot(), original = structuredClone(host);
  host.context.push(section('unrecognized-worldbook-id', 'worldbook', '[UNCLASSIFIED_LORE]'));
  const messages = compile(host).request.messages;
  const firstHistory = messageIndex(messages, host.history[0].text), lastHistory = messageIndex(messages, host.history.at(-1).text);
  assert.ok(messageIndex(messages, '[CONSTANT_LORE]') < firstHistory);
  for (const text of ['[LORE_A]', '[UNCLASSIFIED_LORE]', '[WRITING_RULES]', '[GUIDE_A]', '[SCRIPT_REFERENCE]', '[OTHER_MATERIAL]', '[GUIDANCE_A]', '[STATE_A]']) {
    assert.ok(messageIndex(messages, text) > lastHistory, text + ' must follow complete history');
    assert.ok(messageIndex(messages, text) < messageIndex(messages, '[INPUT_A]'), text + ' must precede current input');
  }
  assert.deepEqual(host.history, original.history);
  assert.deepEqual(host.state, original.state);
  assert.ok(messages.slice(firstHistory).every(message => message.role !== 'system'), 'automatic current material must not be hoisted by system-message adapters');
  assertAllMaterials({ messages }, host);
});

test('adjacent turns retain the entire old history prefix when state, lore and guidance change', () => {
  const host = snapshot(), before = compile(host).request;
  const historyEnd = messageIndex(before.messages, host.history.at(-1).text) + 1;
  const prefix = before.messages.slice(0, historyEnd);
  for (const changes of [
    { state: true, lore: false, guide: false },
    { state: false, lore: true, guide: false },
    { state: false, lore: false, guide: true },
    { state: true, lore: true, guide: true },
  ]) {
    const next = nextTurn(host, changes), after = compile(next).request;
    assert.deepEqual(after.messages.slice(0, historyEnd), prefix, JSON.stringify(changes));
    assertAllMaterials(after, next);
    assert.deepEqual(after.messages.filter(message => next.history.some(row => row.text === message.content) || message.content === next.input.text),
      [...next.history.map(row => ({ role: row.role, content: row.text })), { role: 'user', content: next.input.text }]);
  }
});

test('moving dynamic material preserves duplicate text across lore, requirements and history', () => {
  const host = snapshot(), repeated = '[REPEATED_MATERIAL]';
  host.context.find(item => item.id === 'tavern:constant-worldbook').text = repeated;
  host.context.find(item => item.id === 'tavern:worldbook').text = repeated;
  host.context.find(item => item.kind === 'guide').text = repeated;
  host.history.push({ role: 'user', text: repeated }, { role: 'assistant', text: repeated });
  host.guidance = repeated;
  const result = compile(host);
  assertAllMaterials(result.request, host);
  assert.equal(result.historyMessages, host.history.length);
});

test('missing material and history markers still preserve a stable prefix and all material', () => {
  const host = snapshot(), document = preset({ markers: false }), before = compile(host, document).request;
  const historyEnd = messageIndex(before.messages, host.history.at(-1).text) + 1;
  assert.ok(messageIndex(before.messages, '[CONSTANT_LORE]') < messageIndex(before.messages, host.history[0].text));
  for (const text of ['[LORE_A]', '[GUIDE_A]', '[STATE_A]']) assert.ok(messageIndex(before.messages, text) >= historyEnd);
  const next = nextTurn(host), after = compile(next, document).request;
  assert.deepEqual(after.messages.slice(0, historyEnd), before.messages.slice(0, historyEnd));
  assertAllMaterials(before, host);
  assertAllMaterials(after, next);
});

test('empty history leaves constant lore first and current material immediately before input', () => {
  const host = snapshot(); host.history = [];
  for (const markers of [true, false]) {
    const result = compile(host, preset({ markers })), messages = result.request.messages;
    const constant = messageIndex(messages, '[CONSTANT_LORE]'), input = messageIndex(messages, '[INPUT_A]');
    for (const text of ['[LORE_A]', '[GUIDE_A]', '[STATE_A]']) {
      assert.ok(messageIndex(messages, text) > constant);
      assert.ok(messageIndex(messages, text) < input);
    }
    assert.equal(result.historyMessages, 0);
    assertAllMaterials(result.request, host);
  }
});

test('depth prompts count real history and input messages rather than appended material sections', () => {
  const host = snapshot(); host.history = host.history.slice(0, 4);
  const messages = compile(host, preset({ depths: [0, 1, 2, 100] })).request.messages;
  const at = text => messageIndex(messages, text);
  assert.ok(at('[DEPTH_100]') < at(host.history[0].text));
  assert.ok(at('[DEPTH_2]') > at(host.history.at(-2).text));
  assert.ok(at('[DEPTH_2]') < at(host.history.at(-1).text));
  assert.ok(at('[DEPTH_1]') > at(host.history.at(-1).text));
  assert.ok(at('[DEPTH_1]') < at('[LORE_A]'));
  assert.ok(at('[DEPTH_1]') < at('[STATE_A]'));
  assert.ok(at('[DEPTH_0]') > at('[INPUT_A]'));
  assertAllMaterials({ messages }, host);
});

test('OpenAI and Gemini serialized requests retain dynamic material after the stable history prefix', () => {
  const host = snapshot(), next = nextTurn(host);
  const before = compile(host).request, after = compile(next).request;
  for (const api of ['openai-completions', 'google-generative-ai']) {
    const body = request => JSON.parse(JSON.stringify(buildProtocolBody({ api }, request,
      { model: request.model.model, maxTokens: request.maxTokens, temperature: request.temperature })));
    const sections = wire => api === 'openai-completions' ? wire.messages
      : [...(wire.systemInstruction?.parts || []).map(part => ({ role: 'system', content: part.text })),
        ...wire.contents.flatMap(item => item.parts.map(part => ({ role: item.role, content: part.text })))];
    const left = sections(body(before)), right = sections(body(after));
    assertAllMaterials({ messages: left }, host);
    assertAllMaterials({ messages: right }, next);
    const historyEnd = messageIndex(left, host.history.at(-1).text) + 1;
    assert.deepEqual(right.slice(0, historyEnd), left.slice(0, historyEnd), api);
    for (const [messages, material] of [[left, host], [right, next]]) {
      const lastHistory = messageIndex(messages, material.history.at(-1).text);
      const currentInput = messageIndex(messages, material.input.text);
      for (const text of [material.state.status, material.guidance, material.context.find(item => item.id === 'tavern:worldbook').text]) {
        const index = messageIndex(messages, text);
        assert.ok(index > lastHistory && index < currentInput, api + ': dynamic material order');
        assert.notEqual(messages[index].role, 'system', api + ': dynamic material role');
      }
    }
  }
});

test('ChatSquash distinguishes automatic turn context from user-authored prompts, fixed markers and chat', () => {
  const host = snapshot(); host.history = host.history.slice(0, 4);
  const player = text => '[PLAYER_OPEN]' + text + '[PLAYER_CLOSE]';
  const assistant = text => '[ASSISTANT_OPEN]' + text + '[ASSISTANT_CLOSE]';
  for (const separate_chat_history of [false, true]) {
    const document = preset();
    for (const id of ['charDescription', 'worldInfoAfter']) document.prompts.find(prompt => prompt.identifier === id).role = 'user';
    document.prompts.push({ identifier: 'user-prompt', role: 'user', content: '[PRESET_USER]' });
    document.prompt_order[0].order.splice(1, 0, { identifier: 'user-prompt', enabled: true });
    document.extensions = { SPreset: { ChatSquash: { enabled: true, separate_chat_history, role: 'user',
      user_prefix: '[PLAYER_OPEN]', user_suffix: '[PLAYER_CLOSE]', char_prefix: '[ASSISTANT_OPEN]', char_suffix: '[ASSISTANT_CLOSE]' } } };
    const result = compile(host, document), text = modelText(result.request);
    for (const value of ['[PRESET_USER]', '[CONSTANT_LORE]', '[CHARACTER]\n\n[PERSONA]', host.input.text]) assert.ok(text.includes(player(value)), value);
    for (const row of host.history) assert.ok(text.includes((row.role === 'user' ? player : assistant)(row.text)));
    const automatic = result.logicalMessages.filter(message => message.content.startsWith('【本轮世界书参考资料】')
      || message.content.startsWith('【本轮写作要求与指导】') || message.content.startsWith('【正文生成前的权威状态】'));
    assert.equal(automatic.length, 3);
    for (const message of automatic) {
      assert.equal(message.role, 'user');
      assert.ok(text.includes(message.content), 'automatic context title and body survive squashing');
      assert.ok(!text.includes('[PLAYER_OPEN]' + message.content));
      assert.ok(!text.includes(message.content + '[PLAYER_CLOSE]'));
    }
    const playerMessages = host.history.filter(row => row.role === 'user').length + 4;
    assert.equal(text.split('[PLAYER_OPEN]').length - 1, playerMessages);
    assert.equal(text.split('[PLAYER_CLOSE]').length - 1, playerMessages);
    for (const message of [...result.logicalMessages, ...result.request.messages]) assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
    assert.doesNotMatch(JSON.stringify(result.request), /"turnMaterial"|"rawContent"|"source"/);
    assertAllMaterials(result.request, host);
  }
});

test('ChatSquash preserves repeated literal macros while hooks can rewrite surrounding prose', () => {
  const host = snapshot(), repeated = '[REPEATED_RAW]{{user}}';
  host.context.find(item => item.id === 'tavern:constant-worldbook').text = repeated;
  host.context.find(item => item.id === 'tavern:worldbook').text = repeated;
  host.context.find(item => item.kind === 'guide').text = repeated;
  host.history = [{ role: 'user', text: repeated }, { role: 'assistant', text: '[HISTORY_REPLY]' }];
  for (const separate_chat_history of [false, true]) {
    const document = preset();
    document.extensions = { SPreset: { ChatSquash: { enabled: true, separate_chat_history, role: 'user', user_prefix: '[PLAYER]', user_suffix: '[/PLAYER]' } },
      tavern_helper: { scripts: [{ id: 'rewrite', name: 'synthetic rewrite', enabled: true,
        content: 'eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, request => { for (const message of request.messages) message.content = message.content.replaceAll("[REPEATED_RAW]", "CORRUPTED"); });' }] } };
    const result = compile(host, document);
    assert.equal(modelText(result.request).split('CORRUPTED{{user}}').length - 1, 4);
    assert.doesNotMatch(modelText(result.request), /REPEATED_RAW|STCONTEXT_MATERIAL_/);
    assert.equal(host.history[0].text, repeated);
    // Test final-hook counting separately, with three identical standalone
    // materials and no nested macros or overlapping larger material strings.
    const duplicateHost = snapshot(), duplicateText = '[DUPLICATE]';
    duplicateHost.context.find(item => item.id === 'tavern:constant-worldbook').text = duplicateText;
    duplicateHost.context.find(item => item.id === 'tavern:worldbook').text = duplicateText;
    duplicateHost.history = [{ role: 'user', text: duplicateText }, { role: 'assistant', text: '[HISTORY_REPLY]' }];
    delete document.extensions.tavern_helper;
    document.extensions.SPreset.FinalRequestProcessing = { enabled: true, script: '({request}) => request' };
    assertAllMaterials(compile(duplicateHost, document).request, duplicateHost);
    document.extensions.SPreset.FinalRequestProcessing = { enabled: true,
      script: '({request}) => { const message = request.messages.find(item => item.content.includes("[DUPLICATE]")); message.content = message.content.replace("[DUPLICATE]", ""); return request; }' };
    assert.equal(modelText(compile(duplicateHost, document).request).split(duplicateText).length - 1, 2);
    assert.equal(duplicateHost.history[0].text, duplicateText);
  }
});

test('optional Meowssiah fixture carries ordered historical prose and current material in its tool protocol', { skip: !process.env.STCONTEXT_COMPAT_FIXTURE }, async () => {
  const document = parsePreset(await readFile(process.env.STCONTEXT_COMPAT_FIXTURE, 'utf8'));
  const host = snapshot(), next = nextTurn(host);
  const before = compile(host, document).request, after = compile(next, document).request;
  const contextFields = request => [
    ...request.messages.filter(message => message.role === 'tool' && message.name === 'context').map(message => message.content),
    request.tools?.find(tool => tool.name === 'context')?.description,
  ].filter(Boolean);
  for (const [request, material] of [[before, host], [after, next]]) {
    // Some releases put context in a tool description. 2.1 places the
    // assembled registry in the result of its synthetic context tool call.
    const fields = contextFields(request);
    const registry = fields.find(text => text.includes(host.history[0].text));
    assert.ok(registry, 'missing historical context payload');
    let end = 0;
    for (const row of material.history) {
      const start = registry.indexOf(row.text, end);
      assert.ok(start >= end, 'missing or reordered floor ' + row.text.slice(0, 20));
      end = start + row.text.length;
    }
    for (const text of [material.state.status, material.guidance, ...material.context.map(item => item.text)]) {
      assert.ok(fields.some(field => field.includes(text)), 'missing context material ' + text);
    }
    assert.ok(fields.some(field => field.includes(material.input.text)));
  }
});
