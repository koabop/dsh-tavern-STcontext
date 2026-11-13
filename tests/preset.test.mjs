import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePreset, compilePreset, processOutput, inspectPreset } from '../lib/preset.mjs';
import { createMacroEnvironment, renderMacros } from '../lib/macros.mjs';
import { runCompiler } from '../lib/worker-client.mjs';

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
test('all visible prose survives 40/80 boundaries; source macro text is never run', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [rule('/^[\\s\\S]*$/g', '', { minDepth: 40, promptOnly: true })];
  const history = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '第' + i + '条 {{setvar::old::1}} 完整正文' }));
  const result = compilePreset(doc, materials(history));
  assert.equal(result.historyMessages, 100);
  for (const row of history) assert.ok(result.request.messages.some(message => message.content === row.text), row.text);
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
test('input regex wrappers retain full inputs while destructive rules are skipped', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [
    rule('/^([\\s\\S]*)$/', 'INPUT:$1', { placement: [1], markdownOnly: false, promptOnly: true }),
    rule('/^([\\s\\S]*)$/', '', { placement: [1], markdownOnly: false, promptOnly: true, minDepth: 1 }),
  ];
  const result = compilePreset(doc, materials([{ role: 'user', text: '前轮输入' }, { role: 'assistant', text: '正文' }]));
  assert.ok(result.request.messages.some(x => x.content === 'INPUT:前轮输入'));
  assert.ok(result.request.messages.some(x => x.content === 'INPUT:本轮输入'));
  assert.ok(result.report.warnings.some(text => text.includes('跳过会删改')));
});
test('output regex uses one ordered union pass, preserves display HTML and never reprocesses', () => {
  const doc = preset();
  doc.extensions.regex_scripts = [
    rule('/X/g', 'XX'),
    rule('/Y/g', '<b>Y</b>', { markdownOnly: true, promptOnly: false }),
    rule('/X/g', 'Z', { disabled: true }),
    rule('/X/g', '', { minDepth: 1 }),
  ];
  const result = processOutput({ document: doc, response: { text: 'XY' } });
  assert.equal(result.text, 'XX<b>Y</b>');
  assert.equal(result.metadata.outputRegexPasses, 1);
  assert.equal(result.metadata.appliedRegex.length, 2);
});
test('output replacement supports whole/numeric/named captures and trimStrings', () => {
  const doc = preset(); doc.extensions.regex_scripts = [rule('/(?<word>A)(B)/g', '$0|$1|$<word>|$$', { trimStrings: ['B'] })];
  assert.equal(processOutput({ document: doc, response: { text: 'AB' } }).text, 'A|A|A|$');
});
test('empty processed result and malformed tool arguments cannot replace a body', () => {
  const doc = preset(); doc.extensions.regex_scripts = [rule('/.*/g', '')];
  assert.throws(() => processOutput({ document: doc, response: { text: '原文' } }), /正文为空/);
  assert.throws(() => processOutput({ document: doc, toolNames: ['tool'], response: { toolCalls: [{ name: 'tool', arguments: '{"body":"unfinished' }] } }), /JSON/);
  assert.throws(() => processOutput({ document: doc, toolNames: ['tool'], response: { toolCalls: [{ name: 'other', arguments: {} }] } }), /未声明/);
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
  const result = await runCompiler('compile', { document: doc, materials: materials(history) });
  assert.equal(result.report.order, 100001); assert.equal(result.report.protocol, 'spreset');
  assert.deepEqual(result.request.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(result.request.tools.length, 1);
  for (const row of history) assert.ok(result.request.tools[0].description.includes(row.text), row.text);
  assert.ok(result.request.tools[0].description.includes('本轮输入'));
  assert.ok(result.request.tools[0].description.includes('起点状态'));
  assert.doesNotMatch(JSON.stringify(result.request), /"content":"[^"]*\{\{(?:target_length|perspective_rules|current_chapter_file)\}\}/);
  const toolNames = result.request.tools.map(t => t.name);
  const processed = await runCompiler('output', { document: doc, response: { toolCalls: [{ name: toolNames[0], arguments: JSON.stringify({ buffer_content: '<talk>过程</talk><content><hidden>极其平静的正文</hidden></content>' }) }] }, helperState: result.helperState, toolNames });
  assert.equal(processed.text, '平静的正文</content>');
  assert.equal(processed.metadata.outputRegexPasses, 1);
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
