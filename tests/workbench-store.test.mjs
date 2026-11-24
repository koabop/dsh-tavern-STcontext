import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetStore, encodePreset } from '../lib/store.mjs';
import { inspectPreset } from '../lib/preset.mjs';
import { sharedEditRisk } from '../lib/preset-pointer.mjs';
import { MAX_PRESET_BYTES } from '../lib/limits.mjs';

const document = { prompts: [{ identifier: 'main', role: 'system', content: 'Hello' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  extensions: { other: { 'a/b': { '~': ['a', 'b', null] }, '': false } }, notes: '汉😊'.repeat(3000) };
const original = JSON.stringify(document, null, 2) + '\r\n';
const set = (path, value) => ({ op: 'set', path, value });
const del = path => ({ op: 'delete', path });
async function upload(store, text, options = {}) {
  const { id } = await store.begin({ name: 'preset.json', size: text.length, ...options });
  for (let i = 0; i * 50000 < text.length; i++) store.chunk({ id, index: i, text: text.slice(i * 50000, (i + 1) * 50000) });
  return store.finish({ id });
}
async function setup(source = original) {
  const tavern = { writes: 0, maxBytes: 8 * 1024 * 1024,
    capabilities: { generationPresets: 1 }, listGenerationPresets() { throw Error('unexpected host read'); },
    readGenerationPreset() { throw Error('unexpected host read'); },
    readPluginData() { return structuredClone(this.state); },
    savePluginData({ data }) { this.state = structuredClone(data); this.writes++; },
    getPluginDataLimits() { return { maxBytes: this.maxBytes }; } };
  const store = createPresetStore(tavern), imported = await upload(store, source), id = imported.activeId;
  return { store, tavern, id, expectedRevision: imported.presets[0].revision };
}

test('workbench source is exact and explicit; JSON Pointer reads are bounded JSON text at UTF-16 offsets', async () => {
  const { store, tavern, id, expectedRevision: revision } = await setup();
  await upload(store, JSON.stringify({ ...document, name: 'another active preset' }));
  await store.select({ hostPreset: 'current' });
  const before = tavern.readPluginData();
  assert.deepEqual(await store.workbenchSource({ id }), { id, name: 'preset.json', revision, text: original, settings: {} });
  for (const [pointer, type, node] of [['', 'object', document], ['/extensions/other/a~1b/~0', 'array', ['a', 'b', null]],
    ['/extensions/other/a~1b/~0/2', 'null', null], ['/extensions/other/', 'boolean', false], ['/notes', 'string', document.notes]]) {
    const text = JSON.stringify(node);
    const page = await store.workbenchRead({ id, pointer });
    assert.deepEqual(page, { id, name: 'preset.json', revision, pointer, type, offset: 0, total: text.length, text: text.slice(0, 2000) });
    assert.equal((await store.workbenchRead({ id, pointer, offset: text.length })).text, '');
  }
  const pointer = '/notes', text = JSON.stringify(document.notes);
  let joined = '';
  while (joined.length < text.length) joined += (await store.workbenchRead({ id, pointer, offset: joined.length, limit: 701 })).text;
  assert.equal(joined, text);
  for (const bad of [{}, { id: 'current' }, { id: '' }, { hostPreset: 'current' }, Object.create({ id })]) {
    await assert.rejects(store.workbenchSource(bad));
  }
  for (const page of [{}, { pointer: null }, { pointer: '/constructor' }, { pointer: '/notes', offset: -1 },
    { pointer: '/notes', offset: text.length + 1 }, { pointer: '/notes', offset: '0' }, { pointer: '/notes', limit: 0 },
    { pointer: '/notes', limit: 8001 }, { pointer: '/notes', limit: 1.1 }, { pointer: '', save: true }]) {
    await assert.rejects(store.workbenchRead({ id, ...page }));
  }
  assert.deepEqual(tavern.readPluginData(), before);
});

test('preview and save use the full fresh report, preserve private identity, unrelated data and the current selection', async () => {
  const { store, tavern, id, expectedRevision } = await setup();
  await upload(store, JSON.stringify({ ...document, another: true }));
  await store.settings({ maxTokens: 200 }); await store.select({ hostPreset: 'current' });
  tavern.state.presets[0].futureRecordField = { keep: true };
  const before = tavern.readPluginData(), writes = tavern.writes;
  const operations = [del('/extensions/other/a~1b/~0/0'), set('/extensions/other/a~1b/~0/1', 42), set('/seed', 123), set('/prompts/0/content', '你好')];
  const request = { id, expectedRevision, operations };
  const edited = structuredClone(document);
  edited.extensions.other['a/b']['~'] = ['b', 42]; edited.seed = 123; edited.prompts[0].content = '你好';
  const report = inspectPreset(edited);
  assert.ok(report.warnings.some(warning => warning.includes('seed')));
  assert.deepEqual(await store.workbenchPatch(request), { id, name: 'preset.json', revision: expectedRevision, saved: false, report });
  assert.equal(tavern.writes, writes);
  assert.deepEqual(tavern.readPluginData(), before);
  const result = await store.workbenchPatch({ ...request, save: true });
  assert.equal(tavern.writes, writes + 1);
  assert.notEqual(result.revision, expectedRevision);
  assert.deepEqual(result, { id, name: 'preset.json', revision: result.revision, saved: true, report });
  const after = tavern.readPluginData(), record = after.presets[0];
  assert.deepEqual(after, { ...before, presets: [record, before.presets[1]] });
  assert.equal(record.id, id); assert.equal(record.importedAt, before.presets[0].importedAt);
  assert.deepEqual(record.futureRecordField, { keep: true }); assert.deepEqual(record.report, report);
  assert.deepEqual(JSON.parse((await store.workbenchSource({ id })).text), edited);
  assert.equal((await store.workbenchRead({ id, pointer: '/seed' })).revision, result.revision);
});

test('a semantic no-op or batch cancelling out does not save, reformat the source, or advance even a legacy revision', async () => {
  const { store, tavern, id } = await setup();
  delete tavern.state.presets[0].revision;
  const expectedRevision = tavern.state.presets[0].digest, writes = tavern.writes;
  for (const operations of [[set('/prompts/0', { content: 'Hello', role: 'system', identifier: 'main' })],
    [set('/temp', 1), del('/temp')], [del('/extensions'), set('/extensions', document.extensions)]]) {
    assert.deepEqual(await store.workbenchPatch({ id, expectedRevision, operations, save: true }),
      { id, name: 'preset.json', revision: expectedRevision, saved: false, report: inspectPreset(document) });
  }
  assert.equal(tavern.writes, writes);
  assert.equal((await store.workbenchSource({ id })).text, original);
  const saved = await store.workbenchPatch({ id, expectedRevision, operations: [set('/extensions/extra', null)], save: true });
  assert.equal(saved.saved, true); assert.notEqual(saved.revision, expectedRevision);
});

test('CAS is tested inside the write lock shared by a reopened store, settings writes and panel replace', async () => {
  const { store, tavern, id, expectedRevision } = await setup(), other = createPresetStore(tavern);
  const req = { id, expectedRevision, save: true, operations: [set('/new', { value: 1 })] };
  const first = store.workbenchPatch(req);
  req.operations[0].value.value = 2; // The queued operation has already taken a request snapshot.
  const stale = other.workbenchPatch(req), settings = other.settings({ maxTokens: 300 });
  const latest = store.workbenchSource({ id });
  const [a, b] = await Promise.allSettled([first, stale]); await settings;
  assert.equal(a.status, 'fulfilled'); assert.equal(b.status, 'rejected'); assert.match(b.reason.message, /其他窗口修改/);
  assert.deepEqual(JSON.parse((await latest).text).new, { value: 1 });
  assert.equal((await store.list()).settings.maxTokens, 300);
  await assert.rejects(upload(other, original, { operation: 'replace', presetId: id, revision: expectedRevision }), /其他窗口修改/);
  const panel = await upload(other, original, { operation: 'replace', presetId: id, revision: a.value.revision });
  for (const save of [true, false]) await assert.rejects(store.workbenchPatch({ ...req, expectedRevision: a.value.revision, save }), /其他窗口修改/);
  assert.equal((await store.workbenchSource({ id })).revision, panel.presets[0].revision);
  await store.remove({ id }); await assert.rejects(other.workbenchPatch(req), /移除/);
});

test('invalid operations, protected/inherited paths, malformed values and partial batches never persist', async () => {
  const { store, tavern, id, expectedRevision } = await setup();
  const base = { id, expectedRevision, save: true }, writes = tavern.writes;
  const cycle = {}; cycle.self = cycle;
  const badPath = ['', 'notes', '/~', '/a~2b', '/x' + 'x'.repeat(1024), '/__proto__/x', '/constructor',
    '/extensions/prototype', '/toString', '/toString/foo', '/prompts/length', '/prompts/map', '/prompts/00',
    '/prompts/01', '/prompts/-1', '/prompts/-', '/prompts/1', '/prompts/9007199254740992', '/missing/path', '/notes/length'];
  for (const path of badPath) {
    for (const op of [set(path, 4), del(path)]) await assert.rejects(store.workbenchPatch({ ...base, operations: [set('/prior', 'rolled back'), op] }));
    if (path !== '') await assert.rejects(store.workbenchRead({ id, pointer: path }));
  }
  for (const value of [undefined, Infinity, NaN, Symbol('bad'), 1n, new Date(), new Array(2), { x: undefined },
    { toJSON() { return 'bad'; } }, cycle, JSON.parse('{"nested":{"__proto__":{"bad":true}}}'), { get x() { return 'bad'; } }]) {
    await assert.rejects(store.workbenchPatch({ ...base, operations: [set('/new', value)] }));
  }
  for (const operations of [undefined, null, {}, [], new Array(1), Array(17).fill(set('/a', 1)), [null], [Object.create({ op: 'delete', path: '/notes' })],
    [{ op: 'replace', path: '/notes', value: null }], [{ op: 'set', path: '/new' }], [{ op: 'delete', path: '/notes', value: 1 }],
    [{ op: 'set', path: '/new', value: null, extra: true }], [del('/missing')]]) await assert.rejects(store.workbenchPatch({ ...base, operations }));
  for (const invalid of [{ id: null }, { expectedRevision: null }, { expectedRevision: '' }, { id: 'current' }, { save: 'true' },
    { save: 1 }, { save: null }, { extra: true }]) await assert.rejects(store.workbenchPatch({ ...base, operations: [del('/notes')], ...invalid }));
  assert.equal((await store.workbenchSource({ id })).text, original); assert.equal(tavern.writes, writes);
  tavern.state.presets[0].data = encodePreset('{broken');
  await assert.rejects(store.workbenchRead({ id, pointer: '' }));
  await assert.rejects(store.workbenchPatch({ ...base, operations: [set('/new', 1)] })); assert.equal(tavern.writes, writes);
});

test('editing leaves precise numeric extension data intact, including numbers outside the JavaScript range', async () => {
  const source = original.replace('"notes":', '"ids": [9007199254740993,1e400,0.12345678901234567890123], "notes":');
  const { store, id, expectedRevision } = await setup(source);
  const number = await store.workbenchRead({ id, pointer: '/ids/0' });
  assert.equal(number.type, 'number'); assert.equal(number.text, '9007199254740993');
  await assert.rejects(store.workbenchRead({ id, pointer: '/ids/0/rawJSON' }));
  await store.workbenchPatch({ id, expectedRevision, operations: [del('/notes')], save: true });
  assert.equal((await store.workbenchRead({ id, pointer: '/ids' })).text, '[9007199254740993,1e400,0.12345678901234567890123]');
});

test('shared editor safety checks numeric round-trips, not formatting or numeric-looking strings', () => {
  const escaped = JSON.stringify({ '9007199254740993': ['1e400', 'backslash \\', 'quote: "9007199254740993"'] });
  assert.equal(sharedEditRisk(escaped), null);
  assert.equal(sharedEditRisk('[1,1.00,0.50e+1,100e-2,0.1,9007199254740992,1e+300]'), null);
  assert.equal(sharedEditRisk(original.padEnd(MAX_PRESET_BYTES - (Buffer.byteLength(original) - original.length))), null);
  for (const token of ['9007199254740993', '0.100000000000000001', '1e999', '-1e-999', '-0']) {
    const reason = sharedEditRisk(`[${escaped},{"private-key":${token}}]`);
    assert.match(reason, /宿主.*数值/);
    assert.ok(reason.length < 100 && !reason.includes(token) && !reason.includes('private-key'));
  }
});

test('shared editor safety fails closed for malformed, oversized, or unverified sources without disclosing JSON', () => {
  const tooLarge = '"' + '汉'.repeat(Math.ceil(MAX_PRESET_BYTES / 3)) + '"';
  for (const text of [null, {}, '{secret-data', '"unterminated', '[NaN]', tooLarge, '['.repeat(600) + '0' + ']'.repeat(600)]) {
    const reason = sharedEditRisk(text);
    assert.equal(typeof reason, 'string'); assert.ok(reason.length > 0 && reason.length < 100 && !reason.includes('\n') && !reason.includes('secret-data'));
  }
  assert.match(sharedEditRisk(tooLarge), /10 MiB/);
});

test('both preview and save enforce edited structure, per-preset UTF-8 cap, and aggregate quota; failures are atomic', async () => {
  const { store, tavern, id, expectedRevision } = await setup(), before = tavern.readPluginData(), writes = tavern.writes;
  async function rejects(operations, pattern) {
    for (const save of [false, true]) {
      await assert.rejects(store.workbenchPatch({ id, expectedRevision, save, operations }), pattern);
      assert.equal(tavern.writes, writes); assert.deepEqual(tavern.readPluginData(), before);
    }
  }
  await rejects([set('/temperature', 3)], /温度/);
  await rejects([del('/prompts/0/identifier')], /identifier/);
  await rejects([set('/extensions/regex_scripts', [{ findRegex: '/[/' }])], /findRegex/);
  await rejects([set('/prompt_order/0/order/0/identifier', 'absent')], /顺序/);
  tavern.maxBytes = 1;
  await rejects([set('/x', 1)], /存储上限/);
  tavern.maxBytes = undefined;
  await rejects([set('/x', 1)], /读取宿主存储额度/);
  delete tavern.getPluginDataLimits; // The legacy host's smaller per-preset limit still applies.
  await rejects([set('/notes', '中'.repeat(700000))], /2 MiB/);
});
