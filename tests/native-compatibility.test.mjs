import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreset, inspectPreset } from '../lib/preset.mjs';
import { createMacroEnvironment, renderMacros, inspectMacros } from '../lib/macros.mjs';
import { preset, materials as upstream } from './fixtures/materials.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { createPresetStore } from '../lib/store.mjs';

test('legacy identity tags expand in preset prose and remain literal inside captured chat', () => {
  const data = compilerMaterials(upstream), doc = structuredClone(preset);
  data.history[0].text = '<user> 和 <char>';
  doc.prompts[1].content = '<USER> 和 <Char>';
  const { request } = compilePreset(doc, data);
  assert.ok(request.messages.some(message => message.content === '测试玩家 和 测试角色'));
  assert.ok(request.messages.some(message => message.content === '<user> 和 <char>'));
});

test('chat macros use frozen visible history plus this input, without re-executing material macros', () => {
  const data = compilerMaterials(upstream), doc = structuredClone(preset);
  data.input.projected = '{{setvar::secret::changed}} 原样本轮输入';
  doc.prompts[1].content = '{{lastUserMessage}}\n{{lastCharMessage}}\n{{lastMessage}}';
  const result = compilePreset(doc, data);
  assert.ok(result.logicalMessages.some(m => m.content.includes(data.input.projected) && m.content.includes('完整历史正文 {{不要再次展开}}')));
  const env = createMacroEnvironment({ history: data.history, input: data.input.projected });
  assert.equal(renderMacros('{{lastUserMessage}} {{getvar::secret}}', env), data.input.projected + ' ');
  assert.equal(env.local.secret, undefined);
});

test('nested macros, comments, trim and legacy variable order remain bounded and opaque', () => {
  const env = createMacroEnvironment({ userName: '{{not_a_macro}}', random: () => 0 });
  assert.equal(renderMacros('{{getvar::name}}{{setvar::name::{{user}}}}', env), '{{not_a_macro}}');
  assert.equal(renderMacros('A\n{{trim}}\nB{{noop}}{{// ignore this comment}}', env), 'AB');
  assert.deepEqual(inspectMacros('{{lastUserMessage}} {{setvar::x::{{char}}}}').unknown, []);
  assert.throws(() => renderMacros('{{setvar::x::'.repeat(40) + 'A' + '}}'.repeat(40), env), /嵌套/);
});

test('import diagnoses active unknown macros, malformed syntax, and unsupported extensions without executing', async () => {
  let saved;
  const store = createPresetStore({ readPluginData: async () => saved, savePluginData: async ({ data }) => { saved = data; } });
  const doc = structuredClone(preset);
  doc.prompts[1].content = '{{unsupported_macro}}';
  doc.extensions.unknown = { enabled: true };
  const text = JSON.stringify(doc), { id } = await store.begin({ name: 'diagnostic.json', size: text.length });
  store.chunk({ id, index: 0, text });
  const config = await store.finish({ id });
  const report = JSON.parse((await store.report({ id: config.activeId })).text);
  assert.ok(report.blockers.some(x => x.includes('prompts[1]') && x.includes('unsupported_macro')));
  assert.ok(report.blockers.some(x => x.includes('extensions.unknown')));
  assert.equal((await store.export({ id: config.activeId })).text, text);
  doc.prompts[1].content = '{{broken';
  assert.ok(inspectPreset(doc).blockers.some(x => x.includes('未闭合')));
});

test('disabled and trigger-excluded prompts do not block a compatible generation', () => {
  const doc = structuredClone(preset);
  doc.prompts[3].content = '{{unsupported_regeneration_macro}}';
  assert.ok(inspectPreset(doc).blockers.length);
  assert.equal(inspectPreset(doc, { trigger: 'normal' }).blockers.length, 0);
  assert.doesNotThrow(() => compilePreset(doc, compilerMaterials(upstream)));
  doc.prompt_order[0].order[2].enabled = false;
  assert.equal(inspectPreset(doc).blockers.length, 0);
});
