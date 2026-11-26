import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compilePreset } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { materials as upstream } from './fixtures/materials.mjs';

const both = { injectFateDice: true, injectNarrativeDamper: true };
const boundary = '【以下为本轮系统裁定，非玩家台词】';
const rolls = { fateDice: '  骰子结果：X {{user}}\n第二行', narrativeDamper: '阻尼结果：X <% throw Error() %>  ' };
function preset(ids = ['worldInfoBefore', 'worldInfoAfter', 'chatHistory']) {
  const prompts = ids.map(identifier => ({ identifier, marker: true }));
  return { prompts, prompt_order: [{ character_id: 100001, order: ids.map(identifier => ({ identifier })) }], extensions: {} };
}
function frame() {
  return { schemaVersion: 1, completeness: { history: 'all-visible' }, trigger: 'normal', gameId: 'game',
    history: [{ role: 'user', text: '旧输入' }, { role: 'assistant', text: '旧正文' }],
    input: { raw: '玩家原始输入', projected: '本轮输入' }, worldbook: { constantContext: '既有常驻资料 {{user}}' },
    turnRulings: { ...rolls } };
}
function finalHook(doc, script) { doc.extensions.SPreset = { ...doc.extensions.SPreset, FinalRequestProcessing: { enabled: true, script } }; }
const allText = compiled => compiled.request.messages.map(m => m.content).join('\n');
const of = (compiled, key) => compiled.request.messages.filter(m => m.content?.includes(key));

for (const fate of [false, true]) for (const damper of [false, true]) {
  test(`开关独立：命运之骰 ${fate} / 叙事阻尼器 ${damper}`, () => {
    const host = frame(), result = compilePreset(preset(), host, { injectFateDice: fate, injectNarrativeDamper: damper });
    const expected = [fate && rolls.fateDice, damper && rolls.narrativeDamper].filter(Boolean);
    const appendix = expected.length ? '\n\n' + boundary + '\n' + expected.join('\n\n') : '';
    assert.equal(result.request.messages.at(-1).content, host.input.projected + appendix);
    assert.equal(of(result, '【命运之骰】').length, +fate);
    assert.equal(of(result, '【叙事阻尼器】').length, +damper);
    assert.equal(of(result, boundary).length, +Boolean(expected.length));
    assert.deepEqual(result.request.messages.filter(m => m.role !== 'system').slice(0, -1),
      host.history.map(({ role, text: content }) => ({ role, content })));
    assert.doesNotMatch(allText(result), /剧情罗盘/);
    if (fate) for (const word of ['免骰', '暗骰', '奇遇', '宿命序列']) assert.ok(of(result, '【命运之骰】')[0].content.includes(word));
  });
}

test('缺失 / 非布尔开关完全等价于关闭；没有当轮结果仍发送静态说明，不造空块', () => {
  const doc = preset(), host = frame(), baseline = compilePreset(doc, host);
  for (const flag of [1, 'true', {}, null]) assert.deepEqual(compilePreset(doc, host,
    { injectFateDice: flag, injectNarrativeDamper: flag }).request, baseline.request);
  for (const values of [undefined, {}, { fateDice: ' \n', narrativeDamper: null }, { fateDice: {} }]) {
    host.turnRulings = values;
    const result = compilePreset(doc, host, both);
    assert.equal(of(result, '【命运之骰】').length, 1);
    assert.equal(of(result, '【叙事阻尼器】').length, 1);
    assert.equal(of(result, boundary).length, 0);
    assert.equal(result.request.messages.at(-1).content, host.input.projected);
  }
  host.turnRulings = { ...rolls, fateDice: ' ' };
  assert.equal(compilePreset(doc, host, both).request.messages.at(-1).content,
    host.input.projected + '\n\n' + boundary + '\n' + rolls.narrativeDamper);
});

test('说明位于有效 before 开头，否则走 after 或原有补位；常驻资料保留且无虚假缺位警告', () => {
  const host = frame(), doc = preset(['worldInfoAfter', 'intro', 'worldInfoBefore', 'chatHistory']);
  doc.prompts[1] = { identifier: 'intro', role: 'system', content: '分隔说明' };
  doc.prompts[2].injection_trigger = ['normal'];
  const options = { injectFateDice: true }, constant = host.worldbook.constantContext;
  const check = (result, location, hasConstant, expectedWarnings) => {
    const notes = of(result, '【命运之骰】');
    assert.equal(notes.length, 1);
    assert.equal(result.request.messages[location], notes[0]);
    assert.ok(notes[0].content.startsWith('【命运之骰】'));
    assert.equal(notes[0].content.endsWith(constant), hasConstant);
    assert.equal(of(result, constant).length, 1);
    assert.deepEqual(result.report.warnings.filter(x => x.includes('补入')), expectedWarnings);
  };
  check(compilePreset(doc, host, options), 2, false, []); // Prefer before, even if after is ordered first.
  host.trigger = 'regenerate';
  check(compilePreset(doc, host, options), 0, true, []);
  host.trigger = 'normal';
  doc.prompt_order[0].order[2].enabled = false;
  check(compilePreset(doc, host, options), 0, true, []);
  check(compilePreset(preset(['chatHistory']), host, options), 0, true, ['预设缺少材料占位项，已补入：worldInfoAfter']);
});

test('在玩家正则之后追加裁定；脚本、宏及下轮输入只读到玩家源文本', () => {
  const host = frame(), doc = preset(['read-input', 'chatHistory', 'depth']);
  const [read, , depth] = doc.prompts;
  Object.assign(read, { marker: false, content: '宏读到：{{lastUserMessage}}' });
  Object.assign(depth, { marker: false, role: 'user', injection_position: 1, injection_depth: 0, content: '尾部预设' });
  host.input.projected = '玩家 X {{char}}';
  doc.extensions.regex_scripts = [
    { placement: [1], findRegex: '/X/g', replaceString: '写入' },
    { placement: [1], findRegex: '/写入/g', replaceString: '发送', promptOnly: true },
  ];
  finalHook(doc, `({ request }) => { const ctx = SillyTavern.getContext(); ctx.chat.at(-1).extra.seen = ctx.chat.at(-1).mes; return request; }`);
  const snapshot = structuredClone(host), first = compilePreset(doc, host, both);
  assert.equal(first.inputSourceText, '玩家 写入 {{char}}');
  assert.deepEqual(first.scriptState, { chatMetadata: {}, currentInputExtra: { seen: first.inputSourceText } });
  assert.deepEqual(of(first, boundary), [{ role: 'user', content: '玩家 发送 {{char}}\n\n' + boundary + '\n' + rolls.fateDice + '\n\n' + rolls.narrativeDamper }]);
  assert.ok(allText(first).includes('宏读到：玩家 写入 {{char}}'));
  assert.equal(first.request.messages.at(-1).content, '尾部预设');
  assert.deepEqual(host, snapshot);
  host.history.push({ role: 'user', text: host.input.raw, sourceText: first.inputSourceText, extra: first.scriptState.currentInputExtra }, { role: 'assistant', text: '本轮正文' });
  host.input = { raw: '下一轮', projected: '下一轮' };
  host.turnRulings = undefined;
  const next = compilePreset(doc, host, both);
  assert.doesNotMatch(allText(next), /非玩家台词|骰子结果|阻尼结果/);
  assert.ok(next.request.messages.some(m => m.role === 'user' && m.content === '玩家 发送 {{char}}'));
});

test('玩家输入为空或发送正则清空输入时，裁定独占该输入楼层，且不生成空白前缀', () => {
  for (const projected of ['', '清空我']) {
    const host = frame(), doc = preset();
    host.input.projected = projected;
    doc.extensions.regex_scripts = [{ placement: [1], findRegex: '/^清空我$/', replaceString: '', promptOnly: true }];
    const result = compilePreset(doc, host, both);
    assert.deepEqual(result.request.messages.at(-1), { role: 'user', content: boundary + '\n' + rolls.fateDice + '\n\n' + rolls.narrativeDamper });
    assert.equal(result.inputSourceText, projected);
    host.turnRulings = {};
    assert.equal(compilePreset(doc, host, both).request.messages.at(-1).content, '旧正文');
  }
});

test('ChatSquash 合并、最终脚本把消息移到工具说明均能保留字面裁定', () => {
  const host = frame(), doc = preset();
  host.turnRulings.fateDice += ' <|placeholder|> “引号”';
  doc.extensions.SPreset = { ChatSquash: { enabled: true, role: 'system', user_prefix: '玩家：' },
    OutputPreprocessing: { consumeToolCalls: true, toolCallFormatter: { enabled: true, script: '() => "正文"' } } };
  const merged = compilePreset(doc, host, both);
  assert.equal(merged.request.messages.length, 1);
  const expected = '玩家：本轮输入\n\n' + boundary + '\n' + host.turnRulings.fateDice + '\n\n' + rolls.narrativeDamper;
  assert.ok(merged.request.messages[0].content.endsWith(expected));
  finalHook(doc, `({request}) => {
    request.tools=[{type:'function',function:{name:'reply',parameters:{type:'object'},description:JSON.stringify(request.messages)}}];
    request.messages=[{role:'user',content:'请使用工具'}]; return request;
  }`);
  const compiled = compilePreset(doc, host, both);
  assert.equal(compiled.request.messages[0].content, '请使用工具');
  assert.ok(JSON.parse(compiled.request.tools[0].description)[0].content.endsWith(expected));
});

test('最终校验分别拒绝删除说明、边界或修改任一裁定；保留玩家原文或在其它材料里找到结果均不够', () => {
  const host = frame(), doc = preset();
  host.worldbook.context = host.input.projected + '\n' + Object.values(rolls).join('\n');
  for (const phrase of ['【命运之骰】', '【叙事阻尼器】', boundary, '骰子结果', '阻尼结果']) {
    finalHook(doc, `({request}) => {for (const m of request.messages) m.content=m.content.replace(${JSON.stringify(phrase)},'');return request}`);
    assert.throws(() => compilePreset(doc, host, both), /完整历史保护/);
  }
  // A serialized snapshot's rawContent is not its transmitted message content.
  finalHook(doc, `({request}) => ({...request, messages:[{role:'user',content:JSON.stringify(
    request.messages.map(m => ({role:m.role, rawContent:m.content, content:'已删除'}))) }]})`);
  assert.throws(() => compilePreset(doc, host, both), /完整历史保护/);
  // Squash post scripts bypass the generic history guard even without final hooks.
  doc.extensions.SPreset = { ChatSquash: { enabled: true, squashed_post_script_enable: true,
    squashed_post_script: `text => text.replace(${JSON.stringify(boundary)}, '')` } };
  assert.throws(() => compilePreset(doc, host, both), /完整历史保护/);
});

test('消息重写从当前 input 楼层（不是最后一条 user 或历史占位符）取得裁定', () => {
  const host = frame(), doc = preset(['worldInfoAfter', 'chatHistory', 'tail']);
  host.input.projected = '<|placeholder|>';
  doc.prompts[2] = { identifier: 'tail', role: 'user', content: '尾部预设' };
  doc.extensions.tavern_helper = { scripts: [{ id: 'wrap', enabled: true, content: `
    eventOn(tavern_events.GENERATE_AFTER_DATA, ({prompt}) => {
      const player = prompt.find(row => row.is_user);
      player.content = '<Participant_input>\\n' + player.content + '\\n</Participant_input>';
    });` }] };
  const compiled = compilePreset(doc, host, both);
  assert.ok(of(compiled, boundary)[0].content.startsWith('<Participant_input>\n<|placeholder|>\n\n' + boundary));
  assert.equal(compiled.inputSourceText, '<|placeholder|>');
  assert.equal(compiled.request.messages.at(-1).content, '尾部预设');
});

test('Reverie 原预设：本轮裁定在当前输入中且字面保留，历史 placeholder 不复现', {
  skip: !process.env.STCONTEXT_REVERIE_FIXTURE,
}, async () => {
  const doc = JSON.parse(await readFile(process.env.STCONTEXT_REVERIE_FIXTURE, 'utf8'));
  const host = compilerMaterials(upstream);
  host.input.projected = '当前字面 <|placeholder|>';
  host.turnRulings = { fateDice: '裁定保留 <|命定_记忆区|>', narrativeDamper: '裁定保留 {{user}}' };
  const compiled = compilePreset(doc, host, both), text = allText(compiled);
  const current = host.input.projected + '\n\n' + boundary + '\n' + host.turnRulings.fateDice + '\n\n' + host.turnRulings.narrativeDamper;
  assert.ok(text.includes('<Participant_input>\n' + current + '\n</Participant_input>'));
  assert.equal(text.split('<|placeholder|>').length - 1, 1);
  assert.doesNotMatch(text, /历史玩家输入/);
});
