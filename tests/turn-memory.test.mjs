import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTurnMemory } from '../lib/turn-memory.mjs';

function fixture() {
  const selected = new Map([[1, { turn: 1, textVersion: 'opening', rawText: '开场', input: '' }]]);
  const records = new Map();
  let draft, settled, changed;
  const tavern = {
    onTurnSettled(fn) { settled = fn; },
    onTimelineChanged(fn) { changed = fn; },
    async getTurn({ turn }) { return selected.get(turn) || null; },
    async getTurnState() { return [...selected.values()].at(-1); },
    async getHistory({ from }) { return selected.has(from) ? [selected.get(from)] : []; },
    async readGameData() { return structuredClone(draft); },
    async saveGameData({ data }) { draft = structuredClone(data); },
    async readTurnData({ turn }) {
      return [...selected.values()].reverse().filter(row => row.turn <= turn)
        .map(row => records.get(row.textVersion)).find(Boolean) || null;
    },
    async saveTurnData({ turn, textVersion, data }) {
      assert.equal(selected.get(turn)?.textVersion, textVersion);
      records.set(textVersion, { turn, textVersion, data: structuredClone(data) });
    },
  };
  return { tavern, selected, records, settled: row => settled({ gameId: 'g', ...row }),
    changed: (kind, fields = {}) => changed({ gameId: 'g', turn: 2, kind, ...fields }) };
}
const opening = { role: 'assistant', turn: 1, text: '开场' };
const first = { gameId: 'g', reason: 'normal', history: [opening], input: { raw: '玩家', text: '玩家' } };
const state = { chatMetadata: { ledger: '第一轮' }, currentInputExtra: { rules: ['A'] } };
const compiled = { inputSourceText: '玩家（写入）', scriptState: state, presetDigest: 'p' };
const turn = { turn: 2, textVersion: 'v2', rawText: '正文', input: '玩家' };
const next = () => ({ gameId: 'g', history: [opening, { role: 'user', text: '玩家' }, { role: 'assistant', turn: 2, text: '正文' }] });

test('only a committed version can restore script metadata and the input source after restart', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern);
  await memory.stage(first, compiled, '正文');
  assert.equal(f.records.size, 0);
  f.selected.set(2, turn);
  const reopened = createTurnMemory(f.tavern);
  const material = next();
  await reopened.restore(material, 'p');
  assert.deepEqual(material.scriptState, { chatMetadata: state.chatMetadata });
  assert.deepEqual(material.history[1].extra, state.currentInputExtra);
  assert.equal(material.history[1].sourceText, '玩家（写入）');
  const otherPreset = next();
  await reopened.restore(otherPreset, 'different');
  assert.equal(otherPreset.history[1].sourceText, '玩家（写入）');
  assert.equal(otherPreset.scriptState, undefined);
  f.selected.set(2, { ...turn, textVersion: 'edited' });
  const edited = next();
  await reopened.restore(edited, 'p');
  assert.equal(edited.scriptState, undefined);
});

test('uncommitted state is discarded on rollback and cannot attach to an unrelated identical reply', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern);
  await memory.stage(first, compiled, '正文');
  f.selected.set(2, { ...turn, input: '别的输入' });
  await f.settled(f.selected.get(2));
  assert.equal(f.records.size, 0);
  await f.changed('rollback');
  f.selected.set(2, turn);
  await f.settled(turn);
  assert.equal(f.records.size, 0);
  await memory.stage(first, { inputSourceText: first.input.text }, '普通回复');
  await f.settled(turn);
  assert.equal(f.records.size, 0);
});

test('host-selected turn can skip hidden numbers and must match the saved body', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern), visible = { ...turn, turn: 7 };
  await memory.stage(first, compiled, '正文');
  f.selected.set(7, visible);
  await f.settled(visible);
  assert.equal(f.records.get('v2').turn, 7);
  const material = next();
  material.history.at(-1).turn = 7;
  await memory.restore(material, 'p');
  assert.deepEqual(material.scriptState.chatMetadata, state.chatMetadata);
  material.history.at(-1).text = '用户已编辑的另一份正文';
  delete material.scriptState;
  delete material.history[1].extra;
  await memory.restore(material, 'p');
  assert.equal(material.scriptState, undefined);
  assert.equal(material.history[1].extra, undefined);
});

test('identical regenerated text replaces old state only after the host confirms the same version', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern);
  await memory.stage(first, compiled, '正文');
  f.selected.set(2, turn);
  await f.settled(turn);
  const revised = { ...compiled, scriptState: { ...state, chatMetadata: { ledger: '修改后的状态' } } };
  await memory.stage({ ...first, reason: 'regenerate' }, revised, '正文');
  const unconfirmed = next();
  await memory.restore(unconfirmed, 'p');
  assert.deepEqual(unconfirmed.scriptState.chatMetadata, state.chatMetadata);
  await f.changed('regenerate', { textVersion: turn.textVersion });
  const confirmed = next();
  await memory.restore(confirmed, 'p');
  assert.deepEqual(confirmed.scriptState.chatMetadata, revised.scriptState.chatMetadata);
});

test('a selected and saved floor can feed immediate continuation before settlement publishes getTurn', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern);
  await memory.stage(first, compiled, '正文');
  f.selected.set(2, turn);
  const getTurn = f.tavern.getTurn;
  f.tavern.getTurn = request => request.turn === 2 ? null : getTurn(request);
  const immediate = next();
  await memory.restore(immediate, 'p');
  assert.deepEqual(immediate.history[1].extra, state.currentInputExtra);
  assert.deepEqual(immediate.scriptState.chatMetadata, state.chatMetadata);
  assert.equal(f.records.size, 0);
  f.tavern.getTurn = getTurn;
  await f.settled(turn);
  assert.equal(f.records.size, 1);
});

test('quota and oversized records use version-checked backups without blocking subsequent turns', async () => {
  for (const oversized of [false, true]) {
    const f = fixture(), memory = createTurnMemory(f.tavern);
    f.tavern.saveTurnData = async () => {
      if (oversized) assert.fail('oversized record must bypass the host turn quota');
      throw Object.assign(Error('这一局的插件数据总量不能超过 8 MB'), { code: 'TAVERN_PLUGIN_INVALID' });
    };
    const scriptState = { ...state, ...(oversized && { chatMetadata: { values: randomBytes(70 * 1024).toString('base64') } }) };
    const staged = await memory.stage(first, { ...compiled, scriptState }, '正文');
    assert.equal(staged.length > 0, oversized);
    f.selected.set(2, turn);
    await f.settled(turn);
    assert.equal(f.records.size, 0);
    const material = next(), reopened = createTurnMemory(f.tavern);
    assert.match((await reopened.restore(material, 'p')).join(' '), /备用/);
    assert.deepEqual(material.scriptState.chatMetadata, scriptState.chatMetadata);
    f.selected.set(2, { ...turn, textVersion: 'other' });
    const other = next();
    await reopened.restore(other, 'p');
    assert.equal(other.scriptState, undefined);
  }
});

test('unreadable saved state is reported and a later valid generation still commits', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern);
  await memory.stage(first, compiled, '正文');
  f.selected.set(2, turn);
  await f.settled(turn);
  f.records.get('v2').data.payload = 'not-gzip';
  const previous = next();
  assert.match((await memory.restore(previous, 'p')).join(' '), /损坏/);
  assert.equal(previous.scriptState, undefined);
  await memory.stage({ ...first, history: previous.history }, compiled, '新正文');
  const third = { ...turn, turn: 3, textVersion: 'v3', rawText: '新正文' };
  f.selected.set(3, third);
  await f.settled(third);
  assert.ok(f.records.has('v3'));
});

test('quota fallback evicts the oldest version while retaining the latest state', async () => {
  const f = fixture(), memory = createTurnMemory(f.tavern);
  f.tavern.saveTurnData = async () => { throw Object.assign(Error('按轮数据已达上限'), { code: 'TAVERN_PLUGIN_INVALID' }); };
  const history = [opening];
  for (let n = 2; n <= 66; n++) {
    const body = '正文' + n, selected = { ...turn, turn: n, textVersion: 'v' + n, rawText: body };
    await memory.stage({ ...first, history }, { ...compiled, scriptState: { ...state, chatMetadata: { n } } }, body);
    f.selected.set(n, selected);
    await f.settled(selected);
    history.push({ role: 'user', text: '玩家' }, { role: 'assistant', turn: n, text: body });
  }
  const material = { gameId: 'g', history };
  const warnings = await memory.restore(material, 'p');
  assert.match(warnings.join(' '), /保留最近 64 条/);
  assert.equal(history[1].extra, undefined);
  assert.deepEqual(history.at(-2).extra, state.currentInputExtra);
  assert.deepEqual(material.scriptState.chatMetadata, { n: 66 });
});
