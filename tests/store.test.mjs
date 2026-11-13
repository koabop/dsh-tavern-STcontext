import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresetStore, encodePreset, decodePreset } from '../lib/store.mjs';
import { randomBytes } from 'node:crypto';
import { MAX_PRESET_BYTES } from '../lib/limits.mjs';
const document = { prompts: [{ identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }] };
function fakeTavern() {
  let data;
  return { readPluginData: async () => structuredClone(data), savePluginData: async input => { data = structuredClone(input.data); } };
}
async function upload(store, text, name = 'preset.json', options = {}) {
  const { id } = await store.begin({ name, size: text.length, ...options });
  for (let index = 0, offset = 0; offset < text.length; index++, offset += 50000) store.chunk({ id, index, text: text.slice(offset, offset + 50000) });
  return store.finish({ id });
}
function modernTavern(maxBytes = 256 * 1024 * 1024) {
  return Object.assign(fakeTavern(), { maxBytes, getPluginDataLimits() { return { maxBytes: this.maxBytes }; } });
}

test('player persona persists verbatim, survives unrelated saves and clears without losing settings', async () => {
  const tavern = fakeTavern(), store = createPresetStore(tavern);
  const personaDescription = '  姓名：林舟\n身份：旅行者 {{user}}\n';
  await store.settings({ personaDescription, maxTokens: 2048 });
  const reloaded = createPresetStore(tavern);
  assert.equal((await reloaded.list()).settings.personaDescription, personaDescription);
  await reloaded.settings({ temperature: .7 });
  const expected = { personaDescription, maxTokens: 2048, temperature: .7 };
  assert.deepEqual((await store.list()).settings, expected);
  for (const invalid of [42, true, {}, []]) {
    await assert.rejects(store.settings({ personaDescription: invalid, maxTokens: 1 }), /玩家设定必须是文本/);
    assert.deepEqual((await store.list()).settings, expected);
  }
  for (const empty of ['', ' \n\t', null]) {
    await store.settings({ personaDescription });
    await store.settings({ personaDescription: empty });
    assert.deepEqual((await reloaded.list()).settings, { maxTokens: 2048, temperature: .7 });
  }
});
async function readAll(store, id, first, kind = 'read') {
  let info = first || await store[kind]({ id }), text = info.text;
  while (text.length < info.total) {
    info = await store[kind]({ id, revision: info.revision, token: info.token, offset: text.length });
    text += info.text;
  }
  return text;
}

test('modern hosts import, validate, edit, copy and reload a 10 MiB UTF-8 preset losslessly', async () => {
  const tavern = modernTavern(), store = createPresetStore(tavern);
  const json = JSON.stringify({ ...document, notes: '中文😊'.repeat(200000) });
  const source = json + ' '.repeat(MAX_PRESET_BYTES - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(source), 10 * 1024 * 1024);
  const imported = await upload(store, source), id = imported.activeId;
  assert.deepEqual(imported.limits, { maxPresetBytes: 10 * 1024 * 1024, maxStoreBytes: 256 * 1024 * 1024, legacy: false });
  const options = { operation: 'validate', presetId: id, revision: imported.presets[0].revision };
  const validated = await upload(store, source, 'draft.json', options);
  assert.equal(JSON.parse(await readAll(store, id, validated.reportPart, 'report')).validation, 'static');
  const edited = await upload(store, source, 'renamed.json', { ...options, operation: 'replace' });
  assert.equal(edited.presets[0].name, 'renamed.json');
  const copied = await upload(store, source, 'copy.json', { ...options, operation: 'copy' });
  assert.equal(copied.presets.length, 2);
  const reloaded = createPresetStore(tavern);
  assert.equal(await readAll(reloaded, copied.activeId), source);
  assert.deepEqual((await reloaded.active()).document, JSON.parse(source));
  assert.equal(copied.storage.usedBytes, Buffer.byteLength(JSON.stringify(await tavern.readPluginData())));
  assert.equal(copied.storage.remainingBytes, tavern.maxBytes - copied.storage.usedBytes);
});

test('10 MiB bounds apply to assembled UTF-8 bytes and advertised upload length', async () => {
  const tavern = modernTavern(), store = createPresetStore(tavern);
  await upload(store, JSON.stringify(document));
  const before = await tavern.readPluginData();
  await assert.rejects(store.begin({ name: 'large.json', size: MAX_PRESET_BYTES + 1 }), /10 MiB/);
  const json = JSON.stringify({ ...document, notes: '中'.repeat(Math.floor(MAX_PRESET_BYTES / 3)) });
  assert.ok(json.length < MAX_PRESET_BYTES && Buffer.byteLength(json) > MAX_PRESET_BYTES);
  await assert.rejects(upload(store, json), /10 MiB/);
  const exact = JSON.stringify(document).padEnd(MAX_PRESET_BYTES, ' ');
  await assert.rejects(upload(store, exact + ' '), /10 MiB/);
  assert.deepEqual(await tavern.readPluginData(), before);
});

test('aggregate quota counts encoded data, reports and settings; failures preserve all saved data', async () => {
  const tavern = modernTavern(200 * 1024), store = createPresetStore(tavern);
  const source = JSON.stringify({ ...document, notes: randomBytes(90000).toString('base64') });
  const imported = await upload(store, source), before = await tavern.readPluginData();
  assert.ok(imported.storage.usedBytes > 100 * 1024 && imported.storage.usedBytes < tavern.maxBytes);
  await assert.rejects(upload(store, source, 'copy.json', { operation: 'copy', presetId: imported.activeId, revision: imported.presets[0].revision }), /存储上限/);
  await assert.rejects(upload(store, source.replace('notes', 'notes2')), /存储上限/);
  assert.deepEqual(await tavern.readPluginData(), before);
  tavern.maxBytes = imported.storage.usedBytes;
  assert.equal((await store.settings({})).storage.remainingBytes, 0);
  tavern.maxBytes--;
  await assert.rejects(store.settings({}), /存储上限/);
  assert.deepEqual(await tavern.readPluginData(), before);
  assert.equal((await store.remove({ id: imported.activeId })).presets.length, 0);
});

test('quota follows the host, falls back only when absent, and fails closed until a failed query recovers', async () => {
  const legacy = createPresetStore(fakeTavern());
  assert.deepEqual((await legacy.list()).limits, { maxPresetBytes: 2 * 1024 * 1024, maxStoreBytes: 250 * 1024, legacy: true });
  await assert.rejects(legacy.begin({ name: 'large.json', size: 2 * 1024 * 1024 + 1 }), /2 MiB/);
  const tavern = modernTavern(8 * 1024 * 1024), store = createPresetStore(tavern);
  await upload(store, JSON.stringify(document));
  const before = await tavern.readPluginData();
  assert.equal((await store.list()).limits.maxStoreBytes, 8 * 1024 * 1024);
  for (const value of [0, NaN, 1.5, '268435456', undefined]) {
    tavern.maxBytes = value;
    const listed = await store.list();
    assert.equal(listed.limits, null); assert.match(listed.limitsError, /重试/);
    await assert.rejects(upload(store, JSON.stringify(document)), /读取宿主存储额度/);
  }
  tavern.getPluginDataLimits = async () => { throw Error('offline'); };
  await assert.rejects(store.settings({ maxTokens: 1234 }), /offline/);
  assert.deepEqual(await tavern.readPluginData(), before);
  tavern.getPluginDataLimits = () => ({ maxBytes: 256 * 1024 * 1024 });
  assert.equal((await store.list()).limits.maxStoreBytes, 256 * 1024 * 1024);
});

test('listing avoids decompressing every preset, and chunk tokens keep a bounded consistent read snapshot', async () => {
  const tavern = modernTavern(); let time = 0, reads = 0;
  const read = tavern.readPluginData;
  tavern.readPluginData = () => { reads++; return read(); };
  const store = createPresetStore(tavern, () => time);
  const source = JSON.stringify({ ...document, notes: '😊汉字'.repeat(80000) });
  const imported = await upload(store, source), id = imported.activeId;
  const saved = await read();
  saved.presets.push({ id: 'damaged', data: 'not-gzip', report: { warnings: ['x'.repeat(5 * 1024 * 1024)] } });
  await tavern.savePluginData({ data: saved });
  const listed = await store.list();
  assert.equal(listed.presets.length, 2);
  assert.ok(JSON.stringify(listed).length < 3000);
  await store.remove({ id: 'damaged' });
  const first = await store.read({ id });
  const startReads = reads;
  assert.equal(await readAll(store, id, first), source);
  assert.equal(reads, startReads, 'continuations must not reload or decompress the library');
  const frozen = await store.read({ id });
  await upload(store, JSON.stringify(document), 'edited.json', { operation: 'replace', presetId: id, revision: frozen.revision });
  assert.equal(await readAll(store, id, frozen), source);
  await assert.rejects(store.read({ id, revision: frozen.revision }), /已修改/);
  const expired = await store.read({ id: (await upload(store, source)).activeId });
  time += 60001;
  await assert.rejects(store.read({ id: expired.id, token: expired.token, offset: expired.text.length }), /失效/);
});
test('large JSON is chunked, persisted compressed and exported byte-for-byte', async () => {
  const source = JSON.stringify({ ...document, notes: '原始预设数据'.repeat(40000) });
  assert.ok(Buffer.byteLength(source) > 256 * 1024);
  const tavern = fakeTavern(), store = createPresetStore(tavern);
  const imported = await upload(store, source);
  assert.equal(imported.presets.length, 1);
  assert.equal((await store.export({ id: imported.activeId })).text, source);
  assert.equal((await store.active()).document.notes.length, 240000);
  assert.ok(Buffer.byteLength(JSON.stringify(await tavern.readPluginData())) < 256 * 1024);
  assert.equal((await createPresetStore(tavern).list()).activeId, imported.activeId);
});

test('editing persists identity, revision, extensions and all order groups; copies stay independent', async () => {
  const tavern = fakeTavern(), store = createPresetStore(tavern);
  const original = { ...document, prompt_order: [...document.prompt_order, { character_id: 100000, order: [] }],
    extensions: { unknown: { code: 'throw Error("never execute")', value: [1, 2] } } };
  const source = JSON.stringify(original), imported = await upload(store, source), id = imported.activeId;
  const first = await store.read({ id });
  assert.equal(first.text, source);
  const edited = { ...original, temperature: 0.8 }, changedText = JSON.stringify(edited);
  const options = { operation: 'replace', presetId: id, revision: first.revision };
  const saved = await upload(store, changedText, 'edited.json', options);
  assert.equal(saved.activeId, id);
  assert.equal(saved.presets.length, 1);
  assert.notEqual(saved.presets[0].revision, first.revision);
  assert.notEqual(saved.presets[0].digest, first.digest);
  assert.deepEqual((await createPresetStore(tavern).active()).document, edited);
  assert.equal((await store.export({ id })).text, changedText);
  const beforeCopy = await store.export({ id });
  // A stale draft can be rescued as a copy, but cannot overwrite the original.
  const copied = await upload(store, source, 'copy.json', { ...options, operation: 'copy' });
  assert.notEqual(copied.activeId, id);
  assert.equal(copied.presets.length, 2);
  assert.deepEqual(await store.export({ id }), beforeCopy);
  // If the original bytes are reimported, never overwrite the edited ID.
  await store.remove({ id: copied.activeId });
  const reimported = await upload(store, source);
  assert.notEqual(reimported.activeId, id);
  assert.deepEqual(await store.export({ id }), beforeCopy);
});

test('stale edits, invalid JSON, quota errors and deleted targets leave saved data unchanged', async () => {
  const tavern = fakeTavern(), store = createPresetStore(tavern);
  const imported = await upload(store, JSON.stringify(document)), id = imported.activeId;
  const options = { operation: 'replace', presetId: id, revision: imported.presets[0].revision };
  const before = await tavern.readPluginData();
  const invalids = ['{broken', JSON.stringify({ ...document, temperature: -1 }),
    JSON.stringify({ ...document, prompt_order: [...document.prompt_order, { character_id: 100000, order: [{ identifier: 'missing' }] }] }),
    JSON.stringify({ ...document, extensions: { regex_scripts: [{ findRegex: '/[/' }] } })];
  for (const source of invalids) {
    await assert.rejects(upload(store, source, 'edited.json', options));
    assert.deepEqual(await tavern.readPluginData(), before);
  }
  await assert.rejects(upload(store, JSON.stringify({ ...document, notes: randomBytes(300000).toString('base64') }), 'large.json', options), /存储上限/);
  assert.deepEqual(await tavern.readPluginData(), before);
  await upload(store, JSON.stringify(document), 'renamed.json', options);
  const renamed = await tavern.readPluginData();
  await assert.rejects(upload(store, JSON.stringify(document), 'stale.json', options), /其他窗口修改/);
  await assert.rejects(store.read({ id, offset: 0, revision: options.revision }), /已修改/);
  assert.deepEqual(await tavern.readPluginData(), renamed);
  await store.remove({ id });
  await assert.rejects(upload(store, JSON.stringify(document), 'deleted.json', options), /已被移除/);
  assert.equal((await store.list()).presets.length, 0);
});

test('draft validation is read-only; cancellation and expiration release upload slots', async () => {
  let time = 0;
  const tavern = fakeTavern(), store = createPresetStore(tavern, () => time);
  const imported = await upload(store, JSON.stringify(document)), id = imported.activeId;
  const before = await tavern.readPluginData();
  const text = JSON.stringify({ ...document, notes: '草稿'.repeat(60000) });
  const options = { operation: 'validate', presetId: id, revision: imported.presets[0].revision };
  const result = await upload(store, text, 'draft.json', options);
  assert.equal(JSON.parse(result.reportPart.text).validation, 'static');
  assert.deepEqual(await tavern.readPluginData(), before);
  const pending = await store.begin({ name: 'draft.json', size: text.length, ...options });
  store.cancel(pending);
  assert.throws(() => store.chunk({ id: pending.id, index: 0, text: text.slice(0, 100) }), /失效/);
  const expired = await store.begin({ name: 'expired.json', size: 2 });
  store.chunk({ id: expired.id, index: 0, text: '{}' }); time += 300001;
  await assert.rejects(store.finish(expired), /失效/);
  assert.deepEqual(await tavern.readPluginData(), before);
});

test('legacy records without revision can be edited and chunked reads preserve Unicode', async () => {
  const tavern = fakeTavern(), store = createPresetStore(tavern);
  const source = JSON.stringify({ ...document, notes: '😊汉字'.repeat(40000) });
  const imported = await upload(store, source), id = imported.activeId;
  const legacy = await tavern.readPluginData(); delete legacy.presets[0].revision; await tavern.savePluginData({ data: legacy });
  let offset = 0, text = '', info;
  do { info = await store.read({ id, offset, revision: imported.presets[0].digest, token: info?.token }); text += info.text; offset += info.text.length; } while (offset < info.total);
  assert.equal(text, source);
  await upload(store, source, 'renamed.json', { operation: 'replace', presetId: id, revision: info.revision });
  assert.equal((await store.active()).name, 'renamed.json');
});
test('incomplete/out-of-order uploads never replace the active preset', async () => {
  const store = createPresetStore(fakeTavern());
  const original = await upload(store, JSON.stringify(document));
  const { id } = await store.begin({ name: 'broken.json', size: 100 });
  assert.throws(() => store.chunk({ id, index: 1, text: 'x' }), /分块/);
  await assert.rejects(store.finish({ id }), /不完整/);
  assert.equal((await store.list()).activeId, original.activeId);
});
test('preset export preserves script data without executing it; edits select/delete persist', async () => {
  const store = createPresetStore(fakeTavern());
  const source = JSON.stringify({ ...document, extensions: { tavern_helper: { scripts: [{ enabled: false, content: 'process.exit(1)' }] } } });
  const imported = await upload(store, source);
  assert.equal((await store.export({ id: imported.activeId })).text, source);
  await store.settings({ maxTokens: '1234', model: { provider: 'configured', model: 'story' }, adapter: 'st' });
  assert.equal((await store.active()).settings.maxTokens, 1234);
  await store.remove({ id: imported.activeId });
  await assert.rejects(store.active(), /先.*导入/);
});
test('compressed store rejects malformed and oversized decompressed payloads', () => {
  assert.equal(decodePreset(encodePreset('你好')), '你好');
  assert.throws(() => decodePreset('invalid'));
  assert.throws(() => decodePreset(encodePreset('a'.repeat(MAX_PRESET_BYTES + 1))));
});

test('independent model persists across reloads, validates atomically and can be cleared', async () => {
  const tavern = fakeTavern(), store = createPresetStore(tavern);
  const model = { provider: ' own-provider ', model: 'story', reasoningEffort: 'high' };
  await store.settings({ model, maxTokens: 2048 });
  const expected = { ...model, provider: 'own-provider' };
  assert.deepEqual((await createPresetStore(tavern).list()).settings.model, expected);
  model.model = 'changed-after-save';
  for (const invalid of ['foreground', 'background', {}, [], { provider: 'p', model: '' },
    { provider: 'p', model: 'm', reasoningEffort: 123 }, { provider: 'p', model: 'm', apiKey: 'never-store' }]) {
    await assert.rejects(store.settings({ model: invalid, maxTokens: 1 }), /模型选择无效/);
    assert.deepEqual((await store.list()).settings, { model: expected, maxTokens: 2048 });
  }
  await store.settings({ model: null });
  assert.deepEqual((await store.list()).settings, { maxTokens: 2048 });
});

test('legacy following settings keep presets and sampling but require an independent choice', async () => {
  for (const slot of ['foreground', 'background']) {
    const tavern = fakeTavern(), store = createPresetStore(tavern);
    const original = await upload(store, JSON.stringify(document));
    const data = await tavern.readPluginData();
    data.settings = { model: slot, maxTokens: 1234 };
    await tavern.savePluginData({ data });
    const migrated = createPresetStore(tavern);
    assert.equal((await migrated.list()).activeId, original.activeId);
    assert.deepEqual((await migrated.active()).settings, { maxTokens: 1234 });
    await migrated.settings({ temperature: .5 });
    assert.deepEqual((await tavern.readPluginData()).settings, { maxTokens: 1234, temperature: .5 });
  }
});

test('removed adapter settings migrate without losing presets, models or sampling and cannot be restored by stale clients', async () => {
  for (const adapter of ['st', 'auto', 'spreset']) {
    const tavern = fakeTavern(), store = createPresetStore(tavern);
    const original = await upload(store, JSON.stringify(document));
    const data = await tavern.readPluginData(), model = { provider: 'p', model: 'm' };
    data.settings = { adapter, model, maxTokens: 2048, temperature: 0.7 };
    await tavern.savePluginData({ data });
    const expected = { model, maxTokens: 2048, temperature: 0.7 };
    assert.deepEqual((await store.list()).settings, expected);
    assert.deepEqual((await store.active()).settings, expected);
    await store.settings({ adapter });
    assert.deepEqual((await tavern.readPluginData()).settings, expected);
    assert.equal((await store.list()).activeId, original.activeId);
    assert.equal((await store.export({ id: original.activeId })).text, JSON.stringify(document));
  }
});
