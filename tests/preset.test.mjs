import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePreset, compilePreset, processOutput, inspectPreset } from '../lib/preset.mjs';
import { createMacroEnvironment, renderMacros } from '../lib/macros.mjs';
import { runCompiler } from '../lib/worker-client.mjs';
import { displayRegexes } from '../lib/regex.mjs';

function preset(extra = {}) {
  return {
    prompts: [
      { identifier: 'system', role: 'system', content: '用中文写作。' },
      { identifier: 'charDescription', role: 'system', marker: true },
      { identifier: 'worldInfoAfter', role: 'system', marker: true },
      { identifier: 'chatHistory', role: 'system', marker: true },
    ],
    prompt_order: [{ character_id: 100001, order: ['system', 'charDescription', 'worldInfoAfter', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }],
    extensions: { regex_scripts: [] }, ...extra,
  };
}
function materials(history = [{ role: 'assistant', text: '开场白', greeting: true }]) {
  return { schemaVersion: 1, gameId: 'test', target: { turn: 2 }, card: { name: '角色' }, cardContext: '已展开人物材料',
    persona: { name: '玩家' }, worldbook: { context: '生效世界书' }, writingRequirements: [{ text: '写作要求' }],
    history, input: { raw: '本轮输入', projected: '本轮输入' }, beforeState: { posture: '起点状态', variables: { hp: 10 } }, completeness: { history: 'all-visible' } };
}
const rule = (findRegex, replaceString, extra = {}) => ({ id: 'rule', placement: [2], findRegex, replaceString, disabled: false, markdownOnly: true, promptOnly: true, ...extra });

test('import selects only the chat-completion order and rejects malformed references', () => {
  const doc = preset();
  doc.prompt_order.unshift({ character_id: 100000, order: [{ identifier: 'system', enabled: false }] });
  const parsed = parsePreset(JSON.stringify(doc));
  assert.equal(inspectPreset(parsed).enabledPrompts, 4);
  assert.equal(inspectPreset(parsed).order, 100001);
  doc.prompt_order[1].order.push({ identifier: 'missing', enabled: true });
  assert.throws(() => parsePreset(JSON.stringify(doc)), /不存在/);
});
test('disabled and unsupported display rules are preserved in the preset without blocking valid generation effects', () => {
  const doc = preset();
  const broken = rule('/[a-/', 'wrong', { promptOnly: false });
  const unsupported = rule('/{{char}}/', 'wrong', { promptOnly: false, substituteRegex: 2 });
  doc.extensions.regex_scripts = [
    { id: 'unfinished', disabled: true, placement: 'future-format' }, broken, unsupported,
    rule('/X/g', '_'),
  ];
  const loaded = parsePreset(JSON.stringify(doc));
  assert.deepEqual(loaded, doc);
  const report = compilePreset(loaded, materials()).report;
  assert.equal(report.blockers.length, 0);
  assert.equal(report.diagnostics.filter(x => x.message.includes('已跳过该规则')).length, 2);
  assert.equal(processOutput({ document: doc, response: { text: 'X' } }).text, '_');
  assert.deepEqual(displayRegexes(doc).map(x => [x.findRegex, x.markdownOnly, x.promptOnly]), [['/X/g', true, false]]);
  for (const required of [{ ...broken, markdownOnly: false }, { ...unsupported, promptOnly: true }]) {
    doc.extensions.regex_scripts = [required];
    assert.deepEqual(parsePreset(JSON.stringify(doc)), doc);
    assert.throws(() => compilePreset(doc, materials()), /findRegex|substituteRegex/);
  }
});
test('model role entries outside the selected order import without changing the source', () => {
  const doc = preset();
  doc.prompts.push({ identifier: 'unused', role: 'model', content: 'unused prompt' });
  doc.prompts.push({ identifier: 'disabled', role: 'model', content: 'disabled prompt' });
  doc.prompt_order[0].order.push({ identifier: 'disabled', enabled: false });
  const parsed = parsePreset(JSON.stringify(doc));
  assert.deepEqual(parsed, doc);
  assert.deepEqual(compilePreset(parsed, materials()).request, compilePreset(preset(), materials()).request);
  assert.ok(!inspectPreset(parsed).diagnostics.some(item => item.path.endsWith('.role')));
});

test('model roles compile as assistant for ordered, depth and material prompts', () => {
  const doc = preset();
  doc.prompts[0].role = 'model';
  doc.prompts[1].role = 'model';
  doc.prompts.push({ identifier: 'depth', role: 'model', content: 'depth prompt', injection_position: 1, injection_depth: 0 });
  doc.prompt_order[0].order.push({ identifier: 'depth', enabled: true });
  const parsed = parsePreset(JSON.stringify(doc)), before = structuredClone(parsed), data = materials();
  const result = compilePreset(parsed, data);
  for (const content of [doc.prompts[0].content, data.cardContext, 'depth prompt']) {
    assert.deepEqual(result.request.messages.find(message => message.content === content), { role: 'assistant', content });
  }
  assert.ok(!result.request.messages.some(message => message.role === 'model'));
  assert.equal(result.report.diagnostics.filter(item => item.path.endsWith('.role') && item.severity === 'warning').length, 3);
  assert.deepEqual(parsed, before);
});

test('supporting model aliases does not accept unknown or non-string prompt roles', () => {
  for (const role of ['tool', 'developer', 'unknown', null, 1, {}, []]) {
    const doc = preset(); doc.prompts[0].role = role;
    assert.throws(() => parsePreset(JSON.stringify(doc)), /不支持的消息角色/);
  }
});

test('per-turn prompt depth trims only the selected old assistant rows and leaves the source intact', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [rule('/^[\\s\\S]*$/g', '', { minDepth: 40, promptOnly: true })];
  const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '第' + i + '条 {{setvar::old::1}} 完整正文' }));
  const before = structuredClone(history);
  const result = compilePreset(doc, materials(history));
  assert.equal(result.historyMessages, 100);
  for (const [index, row] of history.entries()) {
    const shouldSend = row.role === 'user' || history.length - index < 40;
    assert.equal(result.request.messages.some(message => message.content === row.text), shouldSend, row.text);
  }
  assert.deepEqual(history, before);
  assert.equal(result.request.messages.filter(message => message.content === '本轮输入').length, 1);
  assert.ok(result.request.messages.some(message => message.content.includes('起点状态')));
  assert.throws(() => compilePreset(doc, materials([{ role: 'assistant', text: '隐藏', hidden: true }])), /隐藏/);
});
test('disabled history marker is explicitly supplemented, never silently omits history', () => {
  const doc = preset(); doc.prompt_order[0].order.at(-1).enabled = false;
  const result = compilePreset(doc, materials());
  assert.ok(result.request.messages.some(message => message.content === '开场白'));
  assert.ok(result.report.warnings.some(text => text.includes('补入完整历史')));
});

test('custom player persona fills its marker verbatim with the preset order and role', () => {
  const doc = preset(), data = materials();
  doc.prompts.push({ identifier: 'personaDescription', name: 'Persona Description', role: 'user', marker: true, content: 'unused marker content' });
  doc.prompt_order[0].order.splice(2, 0, { identifier: 'personaDescription', enabled: true });
  const personaDescription = '  玩家：旅行者\n{{user}} {{setvar::persona::changed}} <% throw Error("literal") %>\n';
  const result = compilePreset(doc, data, { personaDescription });
  const index = result.request.messages.findIndex(message => message.content === personaDescription);
  assert.equal(index, 2);
  assert.equal(result.request.messages[index].role, 'user');
  assert.equal(result.request.messages[index - 1].content, data.cardContext);
  assert.equal(result.request.messages.filter(message => message.content === personaDescription).length, 1);
  assert.ok(!result.request.messages.some(message => message.content.includes('unused marker content')));
  assert.ok(!result.report.warnings.some(text => text.includes('personaDescription')));
  assert.deepEqual(doc.prompts.at(-1).content, 'unused marker content');
});

test('custom player persona is supplemented when its marker is absent or disabled', () => {
  for (const disabled of [false, true]) {
    const doc = preset(), personaDescription = '玩家是一名旅行者。';
    if (disabled) {
      doc.prompts.push({ identifier: 'personaDescription', marker: true });
      doc.prompt_order[0].order.push({ identifier: 'personaDescription', enabled: false });
    }
    const result = compilePreset(doc, materials(), { personaDescription });
    assert.deepEqual(result.request.messages[0], { role: 'system', content: personaDescription });
    assert.equal(result.request.messages.filter(message => message.content === personaDescription).length, 1);
    assert.ok(result.report.warnings.some(text => text.includes('补入：personaDescription')));
  }
});

test('empty custom player persona keeps existing captured and legacy material behavior', () => {
  for (const captured of [true, false]) {
    const doc = preset(), data = materials();
    if (!captured) delete data.cardContext;
    data.persona.description = '宿主玩家设定';
    const original = compilePreset(doc, data).request;
    for (const personaDescription of ['', ' \n\t']) {
      assert.deepEqual(compilePreset(doc, data, { personaDescription }).request, original);
    }
  }
});
test('prompt-only input rules run in order against each turn depth', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [
    rule('/^([\\s\\S]*)$/', 'INPUT:$1', { placement: [1], markdownOnly: false, promptOnly: true }),
    rule('/^([\\s\\S]*)$/', '', { placement: [1], markdownOnly: false, promptOnly: true, minDepth: 1 }),
  ];
  const result = compilePreset(doc, materials([{ role: 'user', text: '前轮输入' }, { role: 'assistant', text: '正文' }]));
  assert.ok(!result.request.messages.some(x => x.content.includes('前轮输入')));
  assert.ok(result.request.messages.some(x => x.content === 'INPUT:本轮输入'));
  assert.deepEqual(result.report.historyProjections.map(item => [item.role, item.depth, item.beforeLength, item.afterLength, item.rules.length]),
    [['user', 2, 4, 0, 2], ['user', 0, 4, 10, 1]]);
  assert.ok(!JSON.stringify(result.report.historyProjections).includes('本轮输入'));
});
test('write, display and next-turn prompt regexes start from the ST source for each branch', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [
    rule('/X/g', 'XX'),
    rule('/Y/g', '<b>Y</b>', { markdownOnly: true, promptOnly: false }),
    rule('/X/g', 'Z', { disabled: true }),
    rule('/X/g', '', { minDepth: 1 }),
    rule('/Y/g', 'ZY', { markdownOnly: false, promptOnly: false, minDepth: 99 }),
    rule('/Z/g', 'P', { markdownOnly: false, promptOnly: true }),
  ];
  const result = processOutput({ document: doc, response: { text: 'XY' } });
  assert.equal(result.sourceText, 'XZY');
  assert.equal(result.displayText, 'XXZ<b>Y</b>');
  assert.equal(result.text, result.displayText);
  assert.equal(result.metadata.appliedRegex.write.length, 1);
  assert.equal(result.metadata.appliedRegex.display.length, 2);
  const next = compilePreset(doc, materials([{ role: 'assistant', text: result.displayText, sourceText: result.sourceText }]));
  assert.ok(next.request.messages.some(message => message.content === 'PY'));
  assert.doesNotMatch(JSON.stringify(next.request.messages), /<b>/);
});
test('user source survives non-idempotent write rules, preset changes and prompt projection', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [
    rule('/输入/g', '输入!', { placement: [1], markdownOnly: false, promptOnly: false }),
    rule('/!/', '?', { placement: [1], markdownOnly: false, promptOnly: true, maxDepth: 0 }),
  ];
  const first = compilePreset(doc, materials([]));
  assert.equal(first.inputSourceText, '本轮输入!');
  assert.equal(first.request.messages.at(-1).content, '本轮输入?');
  const next = compilePreset(doc, materials([{ role: 'user', text: '本轮输入', sourceText: first.inputSourceText }]));
  assert.ok(next.request.messages.some(message => message.content === '本轮输入!'));
  assert.doesNotMatch(JSON.stringify(next.request.messages), /输入!!/);
});
test('output replacement supports whole/numeric/named captures and trimStrings', () => {
  const doc = preset(); doc.extensions.regex_scripts = [rule('/(?<word>A)(B)/g', '$0|$1|$<word>|$$', { trimStrings: ['B'] })];
  assert.equal(processOutput({ document: doc, response: { text: 'AB' } }).text, 'A|A|A|$$');
});
test('empty processed result and malformed tool arguments cannot replace a body', () => {
  const doc = preset(); doc.extensions.regex_scripts = [rule('/.*/g', '', { markdownOnly: false, promptOnly: false })];
  assert.throws(() => processOutput({ document: doc, response: { text: '原文' } }), /正文为空/);
  assert.throws(() => processOutput({ document: doc, toolNames: ['tool'], response: { toolCalls: [{ name: 'tool', arguments: '{"body":"unfinished' }] } }), /JSON/);
  assert.throws(() => processOutput({ document: doc, toolNames: ['tool'], response: { toolCalls: [{ name: 'other', arguments: {} }] } }), /未声明/);
});
test('a fully hidden display does not discard the canonical reply', () => {
  const doc = preset(); doc.extensions.regex_scripts = [rule('/.*/g', '', { promptOnly: false })];
  const payload = { document: doc, response: { text: '存档正文' } };
  assert.equal(processOutput(payload).text, '');
  assert.equal(processOutput(payload).sourceText, '存档正文');
  const delegated = processOutput({ ...payload, projectDisplay: false });
  assert.equal(delegated.text, '存档正文');
  assert.deepEqual(delegated.metadata.appliedRegex.display, []);
});
test('macro environment is local and unsupported expressions are not executed', () => {
  const env = createMacroEnvironment({ userName: '甲', random: () => 0 });
  assert.equal(renderMacros('{{getvar::x}} {{setvar::x::值}} {{user}} {{random::A::B}} {{roll 10}}', env), '值  甲 A 1');
  assert.equal(renderMacros('{{getvar::x}}', createMacroEnvironment()), '');
  assert.throws(() => renderMacros('{{process.exit()}}', env), /不支持的宏/);
});
test('helper scripts are diagnosed statically and execute only inside the restricted compiler', () => {
  const doc = preset(); doc.extensions.tavern_helper = { scripts: [{ enabled: true, name: 'unknown', content: 'throw new Error("not executed")' }] };
  const report = inspectPreset(doc);
  assert.equal(report.protocol, 'spreset');
  assert.ok(report.warnings.some(text => text.includes('受限助手环境')));
  assert.throws(() => compilePreset(doc, materials()), /not executed/);
});
test('bounded worker cancels pathological output regex without blocking the host', async () => {
  const doc = preset(); doc.extensions.regex_scripts = [rule('/^(a+)+$/', '')];
  await assert.rejects(runCompiler('output', { document: doc, response: { text: 'a'.repeat(40) + '!' } }, { timeout: 500 }), /超时/);
  const controller = new AbortController(); controller.abort(new Error('用户取消'));
  await assert.rejects(async () => runCompiler('compile', { document: doc, materials: materials() }, { signal: controller.signal }), /用户取消/);
});
test('imported user fixture compiles without embedding its JSON in the plugin', { skip: !process.env.STCONTEXT_PRESET_FIXTURE }, async () => {
  const doc = parsePreset(await readFile(process.env.STCONTEXT_PRESET_FIXTURE, 'utf8'));
  const history = Array.from({ length: 90 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '  fixture-row-' + i + ' 完整历史 {{target_length}} 【HISTORICAL_USER_INPUT】  ' }));
  for (const i of [49, 50, 51]) history[i] = { role: 'assistant',
    text: 'fixture-row-' + i + ' "引号" \\路径 {{target_length}} <sumUp>摘要-' + i + '</sumUp><choices>选项-' + i + '</choices>' };
  const result = await runCompiler('compile', { document: doc, materials: materials(history) });
  assert.equal(result.report.order, 100001); assert.equal(result.report.protocol, 'spreset');
  assert.deepEqual(result.request.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(result.request.tools.length, 1);
  const context = result.request.tools[0].description;
  const rowsSent = [...context.matchAll(/fixture-row-(\d+) /g)].map(match => Number(match[1]));
  // Depth 80 and older disappear. The AI summary at depth 40/41 replaces
  // its original floor, whereas depth 39 keeps prose and drops the summary.
  assert.deepEqual(rowsSent, Array.from({ length: 79 }, (_, i) => i + 11).filter(i => i !== 49 && i !== 50));
  for (const i of [49, 50]) assert.ok(context.includes('摘要-' + i));
  assert.ok(!context.includes('摘要-51'));
  assert.ok(context.includes('fixture-row-51 "引号" \\路径 {{target_length}}'));
  assert.doesNotMatch(context, /选项-(49|50|51)/);
  assert.ok(context.includes('fixture-row-89 完整历史 {{target_length}}'));
  assert.ok(result.request.tools[0].description.includes('本轮输入'));
  assert.ok(result.request.tools[0].description.includes('起点状态'));
  assert.doesNotMatch(JSON.stringify(result.request), /"content":"[^"]*\{\{(?:target_length|perspective_rules|current_chapter_file)\}\}/);
  const toolNames = result.request.tools.map(t => t.name);
  const processed = await runCompiler('output', { document: doc, response: { toolCalls: [{ name: toolNames[0], arguments: JSON.stringify({ buffer_content: '<talk>过程</talk><content><hidden>极其平静的正文</hidden></content>' }) }] }, helperState: result.helperState, toolNames });
  assert.equal(processed.text, '平静的正文</content>');
  assert.equal(processed.sourceText, '<talk>过程</talk><content><hidden>极其平静的正文</hidden></content>');
  assert.ok(Array.isArray(processed.metadata.appliedRegex.display));
});

test('resolved card context contains examples once and never reintroduces raw template sources', () => {
  const doc = preset();
  doc.prompts.push({ identifier: 'dialogueExamples', marker: true, role: 'system' });
  doc.prompt_order[0].order.unshift({ identifier: 'dialogueExamples', enabled: true });
  const data = materials();
  data.cardContext = '人物材料\n【文风示例】已经解析的示例';
  data.card.mes_example = '{{raw_example}}<% script() %>';
  const result = compilePreset(doc, data);
  const sent = result.request.messages.map(item => item.content).join('\n');
  assert.equal(sent.split('已经解析的示例').length - 1, 1);
  assert.doesNotMatch(sent, /raw_example|script\(\)/);
});
test('regeneration activates only empty or regenerate prompt triggers', () => {
  const doc = preset();
  for (const [identifier, injection_trigger] of [['normal-only', ['normal']], ['regen-only', ['regenerate']], ['both', ['normal', 'regenerate']], ['empty', []], ['continue-only', ['continue']]]) {
    doc.prompts.push({ identifier, injection_trigger, role: 'system', content: 'trigger:' + identifier });
    doc.prompt_order[0].order.push({ identifier, enabled: true });
  }
  const text = compilePreset(doc, materials()).request.messages.map(message => message.content).join('\n');
  assert.doesNotMatch(text, /trigger:normal-only|trigger:continue-only/);
  for (const name of ['regen-only', 'both', 'empty']) assert.ok(text.includes('trigger:' + name));
  const current = compilePreset(doc, { ...materials(), trigger: 'normal', target: { kind: 'generate', turn: 2 } });
  const normalText = current.request.messages.map(message => message.content).join('\n');
  assert.doesNotMatch(normalText, /trigger:regen-only|trigger:continue-only/);
  for (const name of ['normal-only', 'both', 'empty']) assert.ok(normalText.includes('trigger:' + name));
  assert.equal(current.report.trigger, 'normal');
});
