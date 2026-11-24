import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerWorkbench } from '../lib/workbench.mjs';
import { createPresetStore } from '../lib/store.mjs';
import { digest } from '../lib/preset.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sharedId = 'presets/test.json';
const name = '同名.json';
const text = JSON.stringify({ prompts: [{ identifier: 'intro', role: 'system', content: 'Hello {{incompatible}}' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'intro', enabled: true }] }], notes: 'preserve' });
const exec = { agent: { session: { id: 'workbench', preset: 'tavern' } }, callId: 'test' };
async function setup(privateText = text) {
  const tools = new Map(), modes = new Map(), skills = new Map(), calls = [];
  let data, skillRoot, dispose, approval, sharedText = text;
  const tavern = { capabilities: { generationPresets: 1 }, readPluginData: async () => structuredClone(data),
    savePluginData: async ({ data: value }) => { data = structuredClone(value); },
    listGenerationPresets: async () => [{ id: sharedId, name }], readGenerationPreset: async input => {
      calls.push(input); assert.ok(input.id === sharedId || input.gameId === 'source-game');
      return { id: sharedId, name, revision: digest(sharedText), text: sharedText };
    }, toolModes: v => modes.set(v.name, v.modes), toolSkills: v => skills.set(v.name, v.skills), skillSource: ({ dir }) => { skillRoot = dir; } };
  const store = createPresetStore(tavern);
  const { id: upload } = await store.begin({ name, size: privateText.length });
  store.chunk({ id: upload, index: 0, text: privateText });
  const { activeId: privateId } = await store.finish({ id: upload });
  const ready = registerWorkbench({ inject(keys, install) {
    install({ tavern, tools: { register: (def, { when }) => tools.set(def.name, { ...def, when }) },
      agentPresets: { presetForSession: session => session.preset }, effect: install => { dispose = install(); }, get: key => key === 'approval' ? approval : null });
  } }, store);
  const run = (name, args, execution = exec) => tools.get('stcontext_' + name).execute(args, execution);
  return { store, privateId, tavern, tools, modes, skills, skillRoot, ready, dispose, run, calls,
    setApproval(request) { approval = { request }; }, getShared: () => sharedText, setShared: value => { sharedText = value; } };
}

test('workbench discovery distinguishes same-name libraries, current game and private IDs; no settings or prompt dumps', async () => {
  const s = await setup();
  assert.ok(s.ready()); assert.equal(s.tools.size, 4);
  assert.match(await readFile(resolve(s.skillRoot, 'stcontext-preset/SKILL.md'), 'utf8'), /name: stcontext-preset/);
  for (const [name, def] of s.tools) {
    assert.deepEqual(s.modes.get(name), ['card']); assert.ok(s.skills.get(name).includes('debug-card'));
    assert.equal(def.when(exec), true); assert.equal(def.when({ agent: { session: { preset: 'other' } } }), false);
    await assert.rejects(def.execute({}, {}), /工作台/);
  }
  await s.store.select({ hostPreset: 'current' });
  const privateList = await s.run('list_presets', { source: 'private' });
  assert.deepEqual(privateList.selection, { source: 'shared', followGame: true });
  assert.deepEqual(privateList.presets, [{ id: s.privateId, name }]);
  assert.deepEqual((await s.run('list_presets', { source: 'shared' })).presets, [{ id: sharedId, name }]);
  await assert.rejects(s.run('inspect_preset', { source: 'shared', gameId: 'workbench' }), /来源游玩|关联游玩/);
  await assert.rejects(s.run('inspect_preset', { source: 'private', id: sharedId }), /不存在/);
  assert.deepEqual(s.calls, []);
  const result = await s.run('inspect_preset', { source: 'shared', gameId: 'source-game', trigger: 'normal' });
  assert.equal(result.id, sharedId); assert.deepEqual(s.calls, [{ gameId: 'source-game' }]);
  assert.equal(result.report.blockerCount, 1); assert.equal(result.report.issues[0].pointer, '/prompts/0/content');
  assert.doesNotMatch(JSON.stringify(result), /Hello|preserve/);
  s.tavern.capabilities.generationPresets = 0;
  await assert.rejects(s.run('inspect_preset', { source: 'shared', id: sharedId }), /不支持/);
  assert.equal((await s.run('inspect_preset', { source: 'private', id: s.privateId })).report.blockerCount, 1);
  s.dispose(); assert.equal(s.ready(), false);
});

test('private repair: read -> preview -> human approval -> replace -> re-inspect, never change the selected source', async () => {
  const s = await setup(), id = s.privateId;
  await s.store.select({ hostPreset: sharedId });
  const before = await s.run('inspect_preset', { source: 'private', id });
  const pointer = before.report.issues[0].pointer;
  const field = await s.run('read_private_preset', { id, pointer });
  assert.equal(field.revision, before.revision); assert.equal(JSON.parse(field.text), 'Hello {{incompatible}}');
  const patch = { id, expectedRevision: field.revision, operations: [{ op: 'set', path: pointer, value: 'Hello {{user}}' }] };
  const preview = await s.run('patch_private_preset', patch);
  assert.equal(preview.saved, false); assert.equal(preview.report.blockerCount, 0);
  await assert.rejects(s.run('patch_private_preset', { ...patch, save: true }), /未保存/);
  for (const [outcome, hint] of [['rejected', /自动拒绝/], ['cancelled', /取消或超时/], ['unavailable', /界面不可用/]]) {
    s.setApproval(() => outcome); await assert.rejects(s.run('patch_private_preset', { ...patch, save: true }), hint);
  }
  assert.equal((await s.store.export({ id })).text, text);
  s.setApproval(request => { assert.match(request.reason, /Hello \{\{user\}\}/); assert.ok(request.reason.includes(id)); return 'allowed-once'; });
  const saved = await s.run('patch_private_preset', { ...patch, save: true });
  assert.equal(saved.saved, true); assert.notEqual(saved.revision, field.revision);
  assert.equal((await s.run('inspect_preset', { source: 'private', id })).report.blockerCount, 0);
  assert.equal((await s.store.list()).hostPreset, sharedId); assert.equal(s.getShared(), text);
});

test('inspection honors hidden sampling overrides and warns against lossy shared edits without exposing settings', async () => {
  const unsafe = text.replace('{', '{"number":9007199254740993,"temperature":3,');
  const s = await setup(unsafe); s.setShared(unsafe);
  const targets = [{ source: 'private', id: s.privateId }, { source: 'shared', id: sharedId }];
  for (const target of targets) {
    const value = await s.run('inspect_preset', target);
    assert.ok(value.report.issues.some(issue => issue.pointer === '/temperature'));
    assert.equal(!!value.sharedWriteWarning, target.source === 'shared');
  }
  await s.store.settings({ temperature: 0, personaDescription: 'PRIVATE PERSONA' });
  for (const target of targets) {
    const value = await s.run('inspect_preset', target);
    assert.ok(!value.report.issues.some(issue => issue.pointer === '/temperature'));
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE PERSONA|9007199254740993/);
  }
});

test('private draft inspection pages the candidate under the requested trigger without saving', async () => {
  const doc = JSON.parse(text);
  doc.prompts[0].injection_trigger = ['normal'];
  doc.prompts.push({ identifier: 'redo', injection_trigger: ['regenerate'], content: '{{before}}' });
  doc.prompt_order[0].order.push({ identifier: 'redo', enabled: true });
  const s = await setup(JSON.stringify(doc)), id = s.privateId;
  const { revision: expectedRevision } = await s.store.workbenchSource({ id });
  const args = { id, expectedRevision, trigger: 'regenerate', limit: 1,
    operations: [{ op: 'set', path: '/prompts/1/content', value: '{{user}}' }, { op: 'set', path: '/assistant_prefill', value: 'unsupported' }, { op: 'set', path: '/request_images', value: true }] };
  const first = await s.run('patch_private_preset', args);
  assert.equal(first.trigger, 'regenerate'); assert.equal(first.report.blockerCount, 2);
  const next = await s.run('patch_private_preset', { ...args, offset: first.report.nextOffset });
  assert.equal(next.report.offset, 1); assert.equal(next.report.nextOffset, null); assert.notDeepEqual(first.report.issues, next.report.issues);
  assert.equal((await s.store.workbenchSource({ id })).text, JSON.stringify(doc));
});

test('if the panel saves while approval is open, the approved stale patch cannot overwrite it', async () => {
  const s = await setup(), id = s.privateId;
  const { revision } = await s.store.workbenchSource({ id });
  const other = text.replace('Hello', 'From panel');
  s.setApproval(async () => {
    const session = await s.store.begin({ name, size: other.length, operation: 'replace', presetId: id, revision });
    s.store.chunk({ ...session, text: other, index: 0 }); await s.store.finish(session);
    return 'allowed-once';
  });
  await assert.rejects(s.run('patch_private_preset', { id, expectedRevision: revision, save: true,
    operations: [{ op: 'set', path: '/prompts/0/content', value: 'do not save' }] }), /已在其他窗口修改/);
  assert.equal((await s.store.export({ id })).text, other);
});

test('shared repair through the upstream preset editor clears the blocker and preserves private data', { skip: !process.env.STCONTEXT_HOST_REPO }, async () => {
  const s = await setup();
  const { createPresetEditor } = await import(pathToFileURL(resolve(process.env.STCONTEXT_HOST_REPO, 'tavern-plugin/lib/domain/preset-editor.js')).href);
  const editor = createPresetEditor({ normalizePath: p => { assert.equal(p, sharedId); return p; }, readText: s.getShared, writeText: (_path, value) => s.setShared(value) });
  const inspect = () => s.run('inspect_preset', { source: 'shared', id: sharedId });
  const before = await inspect(), pointer = before.report.issues[0].pointer;
  assert.equal(JSON.parse((await editor.read(before.id, { pointer })).text), 'Hello {{incompatible}}');
  await editor.update(before.id, [{ op: 'set', path: pointer, value: 'Hello {{user}}' }]);
  const after = await inspect(); assert.notEqual(before.revision, after.revision); assert.equal(after.report.blockerCount, 0);
  assert.equal(JSON.parse(s.getShared()).notes, 'preserve'); assert.equal((await s.store.export({ id: s.privateId })).text, text);
});
