import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreset, inspectPreset, processOutput } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { materials, preset } from './fixtures/materials.mjs';

function fixture(content) {
  const doc = structuredClone(preset);
  doc.prompts[1].content = content;
  return doc;
}
const compile = (doc, frame = compilerMaterials(materials)) => compilePreset(doc, frame, {}).request.messages;

test('active EJS prompts implement the upstream README getvar/if example, escaped output, print and whitespace', () => {
  const doc = fixture([
    '当前好感度：<%- getvar("好感度") %>',
    '<% if (getvar("好感度", { defaults: 0 }) > 50) { -%>',
    '<%= userName %>；<% print(assistantName, "：", getMessageVar("buffs[0].name")) %>',
    '<% } %><%# 不输出 %>',
  ].join('\n'));
  const frame = compilerMaterials(materials);
  frame.persona.name = '<A & B>';
  frame.beforeState.variables = { 好感度: 60, buffs: [] };
  frame.beforeState.messageVariables = { buffs: [{ name: '放松' }] };
  assert.deepEqual(inspectPreset(doc).blockers, []);
  assert.ok(compile(doc, frame).some(m => m.content === '当前好感度：60\n&lt;A &amp; B&gt;；测试角色：放松\n'));
});

test('EJS compiles only literal preset blocks, preserving code and macros in captured inputs', () => {
  const frame = compilerMaterials(materials);
  frame.input.projected = '<% throw Error("history ran") %> {{user}}';
  frame.persona.name = '<% throw Error("name ran") %>';
  const doc = fixture('当前人物 {{user}}。旧楼 <%- lastCharMessage %>。当前 <%- lastUserMessage %>。<% print(typeof process, "/", typeof document) %>');
  const messages = compile(doc, frame);
  assert.ok(messages.some(m => m.content.includes('当前人物 <% throw Error("name ran") %>。') &&
    m.content.includes('完整历史正文 {{不要再次展开}}') && m.content.includes(frame.input.projected + '。undefined/undefined')));
});

test('EJS sees native variables from later enabled entries at settings-ready', () => {
  const doc = fixture('<%- getLocalVar("fromLater") %>');
  doc.prompts[2].content = '{{setvar::fromLater::available}}';
  assert.ok(compile(doc).some(m => m.content === 'available'));
});

test('prompt-ready may drop or move original EJS messages; response replay reuses the evaluated request', () => {
  const doc = fixture('DROP_EJS <% throw Error("removed template ran") %>');
  doc.prompts[2].content = 'KEEP_EJS <%= getLocalVar("phase") %>';
  doc.extensions.tavern_helper = { scripts: [{ enabled: true, name: 'prepare prompt', content:
    'eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, p => { replaceVariables({phase:"after"}, {type:"chat"}); p.chat = p.chat.filter(m => !m.content.includes("DROP_EJS")).reverse(); });' }] };
  const compiled = compilePreset(doc, compilerMaterials(materials));
  assert.ok(compiled.request.messages.some(m => m.content === 'KEEP_EJS after'));
  assert.ok(!compiled.request.messages.some(m => m.content.includes('DROP_EJS')));
  assert.equal(processOutput({ document: doc, helperState: compiled.helperState, response: { text: 'story' } }).text, 'story');
});

test('ambiguous settings listeners, rebuilt unknown template sources and unordered SPreset transforms give explicit diagnostics', () => {
  const doc = fixture('<%- userName %>');
  doc.extensions.SPreset = { FinalRequestProcessing: { enabled: true, script: '({request}) => request' } };
  assert.throws(() => compile(doc), /SPreset.*EJS.*顺序/);
  delete doc.extensions.SPreset;
  const helper = { enabled: true, name: 'generation hook', content: 'eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, wire => {});' };
  doc.extensions.tavern_helper = { scripts: [helper] };
  assert.throws(() => compile(doc), /EJS.*SETTINGS_READY.*注册顺序/);
  helper.content = 'eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, p => { p.chat = [{role:"user",content:"<%= 42 %>"}]; });';
  assert.throws(() => compile(doc), /无法确认模板来源/);
});

test('unsupported or incomplete active EJS fails before sending while disabled entries do not run', () => {
  const doc = fixture('正文 <% if (true) {');
  assert.ok(inspectPreset(doc).blockers.some(s => s.includes('EJS')));
  doc.prompts[1].content = '<%= "{{user}}" %>';
  assert.ok(inspectPreset(doc).blockers.some(s => s.includes('原生宏')));
  doc.prompts[1].content = '<%- await getwi("unknown book") %>';
  assert.throws(() => compile(doc), /EJS.*getwi/);
  doc.prompt_order[0].order[0].enabled = false;
  assert.doesNotThrow(() => compile(doc));
});

test('EJS keeps variable snapshots read-only and bounds both code execution and expanded text', () => {
  assert.throws(() => compile(fixture('<% variables.hp++ %>')), /快照只读/);
  assert.throws(() => compile(fixture('<%= Function("return 4")() %>')), /EJS/);
  assert.throws(() => compile(fixture('<% while (true) {} %>')), /超时/);
  const repeated = '<% for (let i = 0; i < 1024; ++i) { %>' + 'A'.repeat(8193) + '<% } %>';
  assert.throws(() => compile(fixture(repeated)), /8 MiB/);
});
