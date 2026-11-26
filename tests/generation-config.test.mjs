import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freezeGenerationConfig, restoreGenerationConfig } from '../lib/generation-config.mjs';
import { encodePreset } from '../lib/store.mjs';
import { MAX_PRESET_BYTES } from '../lib/limits.mjs';
import { preset } from './fixtures/materials.mjs';

const active = () => ({ document: structuredClone(preset), settings: { model: { provider: 'p', model: 'm' } }, name: 'preset', digest: 'original-source-hash' });

test('frozen compressed configuration is self-contained and detached from mutable settings', () => {
  const original = active(), expected = structuredClone(original), config = freezeGenerationConfig(original);
  original.document.prompts[1].content = 'changed'; original.settings.model.model = 'changed';
  assert.deepEqual(restoreGenerationConfig(JSON.parse(JSON.stringify(config))), expected);
  assert.deepEqual(restoreGenerationConfig(expected), expected);
  assert.throws(() => restoreGenerationConfig({ ...config, documentDigest: 'incorrect' }), /校验失败/);
  assert.throws(() => restoreGenerationConfig({ ...config, snapshotVersion: 999 }), /冻结的预设配置/);
});

test('a frozen turn binding is detached and optional at the host size boundary', () => {
  const original = active(), binding = { gameId: 'game', turn: 5, rawDigest: 'a'.repeat(64) };
  const snapshot = JSON.parse(JSON.stringify(freezeGenerationConfig(original, binding)));
  assert.deepEqual(restoreGenerationConfig(snapshot).turnRulingBinding, binding);
  binding.turn = 9;
  assert.equal(snapshot.turnRulingBinding.turn, 5);
  const room = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(freezeGenerationConfig(original)));
  original.name += 'x'.repeat(room);
  assert.equal(freezeGenerationConfig(original, binding).turnRulingBinding, undefined);
});

test('incompressible snapshots fail before host preparation or model dispatch', () => {
  const config = active(); config.document.notes = randomBytes(2 * 1024 * 1024).toString('base64');
  assert.ok(Buffer.byteLength(JSON.stringify(config.document)) < MAX_PRESET_BYTES);
  assert.throws(() => freezeGenerationConfig(config), /可以保存.*2 MiB/);
});

test('compressed snapshots cannot expand beyond the preset limit', () => {
  const config = freezeGenerationConfig(active());
  config.documentGzip = encodePreset('a'.repeat(MAX_PRESET_BYTES + 1));
  assert.throws(() => restoreGenerationConfig(config));
});
