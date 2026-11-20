import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compilePreset, inspectPreset } from '../lib/preset.mjs';
import { createMacroEnvironment, renderMacros, inspectMacros } from '../lib/macros.mjs';
import { preset, materials as upstream } from './fixtures/materials.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { createPresetStore } from '../lib/store.mjs';
import { parseEditedPreset } from '../lib/preset-edit.mjs';
import { createReverieShortMacros, reverieLiteralTags } from '../lib/reverie.mjs';
import { createMaterialProtection } from '../lib/material-protection.mjs';

test('managed story settings use the exported values and preserve quoted template syntax', () => {
  const env = createMacroEnvironment({ userName: '玩家', charName: '角色', random: () => 0 });
  const protection = createMaterialProtection(reverieLiteralTags);
  const settings = { managedValues: {
    body_language: '粤语', narration_person: 'first', length_mode: 'range', min_hanzi: '800', max_hanzi: '1200',
    user_additional_settings: [{ enabled: true, text: '<user> 说 {{trim}} 和 <|字数|>。\n<bot>回答。' },
      { enabled: false, text: '停用的设定' }],
    body_pool: { female_build: { 骨感: 0 }, male_build: { 瘦削: 0 } },
  } };
  const expand = createReverieShortMacros(settings, env, protection.tokenFor);
  assert.equal(expand('<|正文语言|> / <|人称|> / <|字数要求|>'), '粤语 / first / 800—1200');
  assert.equal(expand('<|女性体型池|> / <|男性体型池|>'), '[纤细·平坦, 纤细·平坦, 纤细·平坦] / [匀称, 匀称, 匀称]');
  const protectedSettings = expand('<|用户附加设定|>');
  assert.ok(!protectedSettings.includes('{{trim}}') && !protectedSettings.includes('<|字数|>'));
  assert.equal(protection.restoreText(protectedSettings), '- 玩家 说 {{trim}} 和 <|字数|>。\n  角色回答。');
});

test('Reverie preserves a literal placeholder as the entire input and reports unsupported enabled options', {
  skip: !process.env.STCONTEXT_REVERIE_FIXTURE,
}, async () => {
  const doc = JSON.parse(await readFile(process.env.STCONTEXT_REVERIE_FIXTURE, 'utf8'));
  const data = compilerMaterials(upstream);
  data.input.projected = '<|placeholder|>';
  const { request } = compilePreset(doc, data);
  assert.ok(request.messages.some(m => m.content.includes('<Participant_input>\n<|placeholder|>\n</Participant_input>')));

  const loader = doc.extensions.tavern_helper.scripts.find(item => item.name.endsWith('预设助手'));
  loader.data.noise_padding = { enabled: true };
  assert.ok(inspectPreset(doc).blockers.some(message => message.includes('输入噪声')));
  loader.data.noise_padding.enabled = false;

  const group = doc.prompt_order.find(item => Number(item.character_id) === 100001);
  const toolTail = doc.prompts.find(prompt => prompt.content?.includes('<|命定_工具输出|>'));
  const selection = group.order.find(item => item.identifier === toolTail.identifier);
  selection.enabled = true;
  assert.throws(() => compilePreset(doc, data), /工具尾部/);
  selection.enabled = false;

  doc.extensions.tavern_helper.scripts.find(item => item.name.endsWith('消息后处理')).enabled = false;
  assert.throws(() => compilePreset(doc, data), /助手未处理预设请求标记/);
});

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

test('scoped setters and nested conditions run in source order without evaluating the other branch', () => {
  let calls = 0;
  const env = createMacroEnvironment({ dynamicMacros: { token: () => { calls++; return '{{literal}}'; } } });
  const template = '{{setvar::flag::true}}{{if {{getvar::flag}}}}' +
    '{{#setvar answer}}\n{{#if 0}}{{unsupported}}{{token}}{{else}}{{token}}{{/if}}\n{{/setvar}}' +
    '{{else}}{{setvar::answer::wrong}}{{/if}}' +
    '{{setvar schema}}\n    <x>\n      <y/>\n    </x>\n{{/setvar}}' +
    '{{getvar::answer}}:{{getvar::schema}}';
  assert.equal(renderMacros(template, env, { opaque: s => '[' + s + ']' }), '\n[{{literal}}]\n:<x>\n  <y/>\n</x>');
  assert.equal(calls, 1);
  assert.deepEqual(inspectMacros(template, { dynamicMacros: env.dynamicMacros }).unknown, ['{{unsupported}}']);
  assert.deepEqual(inspectMacros(template, { dynamicMacros: env.dynamicMacros }).requiredUnknown, []);
  assert.equal(renderMacros('{{#if true}}leading\n{{/if}}{{trim}}\ntrailing', env), 'leadingtrailing');
  assert.throws(() => renderMacros('{{if true}}X{{else}}Y{{else}}Z{{/if}}', env), /不匹配/);
  assert.throws(() => renderMacros('{{#if true}}'.repeat(33), env), /嵌套/);
});

test('scoped branches keep frozen chat opaque and reject unhandled macros only on the chosen branch', () => {
  const doc = structuredClone(preset), data = compilerMaterials(upstream);
  data.input.projected = '字面 {{trim}} {{/if}} {{setvar::shouldNotRun::yes}}';
  doc.prompts[1].content = '{{#if false}}{{unknown}}{{else}}{{#setvar v}}{{lastUserMessage}}{{/setvar}}{{/if}}{{getvar::v}}';
  assert.deepEqual(inspectPreset(doc).blockers, []);
  assert.ok(compilePreset(doc, data).logicalMessages.some(m => m.content === data.input.projected && m.role === 'system'));
  doc.prompts[1].content = '{{#if true}}{{unknown}}{{/if}}';
  assert.throws(() => compilePreset(doc, data), /尚不支持的宏：unknown/);
});

test('signed depth injection orders survive editing and sort before the unchanged unset priority', () => {
  const doc = structuredClone(preset);
  const order = doc.prompt_order[0].order;
  for (const [name, priority] of [['unset', undefined], ['zero', 0], ['negative', -1]]) {
    doc.prompts.push({ identifier: name, content: name, role: 'system', injection_position: 1, injection_depth: 1, injection_order: priority });
    order.push({ identifier: name, enabled: true });
  }
  const edited = parseEditedPreset(JSON.stringify(doc));
  assert.equal(edited.prompts.at(-1).injection_order, -1);
  assert.deepEqual(inspectPreset(edited).blockers, []);
  const { logicalMessages } = compilePreset(edited, compilerMaterials(upstream));
  assert.deepEqual(logicalMessages.map(m => m.content).filter(s => ['negative', 'zero', 'unset'].includes(s)), ['negative', 'unset', 'zero']);
  for (const invalid of [-0.5, Number.MAX_SAFE_INTEGER + 1]) {
    doc.prompts.at(-1).injection_order = invalid;
    assert.ok(inspectPreset(doc).blockers.some(x => x.includes('injection_order')));
    assert.throws(() => parseEditedPreset(JSON.stringify(doc)), /注入顺序/);
  }
  doc.prompts.at(-1).injection_depth = -1;
  assert.ok(inspectPreset(doc).blockers.some(x => x.includes('injection_depth')));
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
