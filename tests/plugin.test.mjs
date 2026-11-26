import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apply, name } from '../index.mjs';
import { materials, preset } from './fixtures/materials.mjs';
import { restoreGenerationConfig } from '../lib/generation-config.mjs';
import { applyRegexOnce } from '../lib/regex.mjs';

function displayed(reply) {
  return applyRegexOnce(reply.text, reply.regexScripts || [], { placement: 2, depth: 0, channel: 'display' }).text;
}

test('Lyra preserves the source for display, then switches from prose to summary at the next depth', {
  skip: !process.env.STCONTEXT_LYRA_FIXTURE,
}, async () => {
  const f = fixture();
  await importPreset(f, JSON.parse(await readFile(process.env.STCONTEXT_LYRA_FIXTURE, 'utf8')));
  const config = await f.prepare();
  const story = '她推开门，把信放到桌上。', summary = '她交出了信。';
  const source = story + '\n<SUOT>向前走</SUOT>\n<scene>书房 - 清晨</scene>\n<details><summary>摘要</summary>\n' + summary + '\n</details>';
  const saved = await f.generate(() => ({ text: source }), config);
  assert.equal(saved.text, source);
  assert.match(displayed(saved), /<script\b/i);
  for (const depth of [9, 10]) {
    const history = [{ role: 'assistant', text: saved.text, turn: 1 },
      ...Array.from({ length: depth - 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '楼层 ' + i }))];
    await f.generate(request => {
      const projected = request.messages.flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.equal(projected.includes(story), depth === 9);
      assert.equal(projected.includes(summary), depth === 10);
      assert.ok(!projected.includes('<SUOT>向前走</SUOT>'));
      assert.ok(!projected.includes('<template id="raw-data">'));
      return { text: '下一条回复' };
    }, config, { ...materials, history });
    const preview = await f.call('request', { gameId: 'test' });
    assert.ok(preview.report.historyProjections.some(row => row.depth === depth && row.afterLength < row.beforeLength));
  }
});

test('older hosts keep narrative sources clean when display projection is unavailable', async () => {
  const f = fixture(1, 7, { capabilities: { bodyProjection: 0 } });
  await importPreset(f);
  assert.deepEqual(await f.generate(() => ({ text: 'X' }), await f.prepare()), { text: 'X' });
  assert.ok((await f.call('request', { gameId: 'test' })).report.warnings.some(value => value.includes('未美化')));
});

test('Reverie 1.2 imports and replays its default story pipeline with a mock model', {
  skip: !process.env.STCONTEXT_REVERIE_FIXTURE,
}, async () => {
  const f = fixture();
  const doc = JSON.parse(await readFile(process.env.STCONTEXT_REVERIE_FIXTURE, 'utf8'));
  await importPreset(f, doc);
  await f.call('settings', { model: { provider: 'deepseek-official', model: 'offline-story' } });
  const literalInput = '保留 {{user}}、<|命定_记忆区|> 和 <|placeholder|>。';
  const oldStory = '她把蓝色信封交给了我。', summary = '她递交了信件。';
  const source = '<recorder_output><recorder_thinking>模拟思考</recorder_thinking><recorder_body>' +
    '<tp>早晨</tp><gametxt>' + oldStory + '</gametxt><summary>' + summary + '</summary></recorder_body></recorder_output>';

  for (const [reason, depth] of [['normal', 10], ['regenerate', 11]]) {
    const history = [{ role: 'assistant', text: source, turn: 1 },
      ...Array.from({ length: depth - 1 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i % 2 ? '后续事件' : '旧玩家发言' }))];
    const config = await f.generator.prepare({ reason, gameId: 'test', signal: new AbortController().signal });
    const reply = await f.generate(request => {
      assert.deepEqual(request.stop, ['Participant:']);
      const text = request.messages.map(m => m.content[0].text).join('\n');
      assert.equal(text.split('<Participant_input>').length - 1, 1);
      assert.ok(text.includes('<Participant_input>\n' + literalInput + '\n</Participant_input>'));
      assert.equal(text.split('<|命定_记忆区|>').length - 1, 1);
      assert.equal(text.split('<|placeholder|>').length - 1, 1);
      assert.doesNotMatch(text, /旧玩家发言|Participant: 【本轮|<\|命定_(?:正文|历史|深度)|<\|(?:人称|字数要求|女性体型池)\|>|\{\{general_prompt_noise\}\}/);
      for (const value of ['激活世界书', '写作规范', '输入处理后的状态', '不少于1500', '简体中文', '第三人称']) assert.ok(text.includes(value), value);
      assert.equal(text.includes(oldStory), depth === 10);
      assert.equal(text.includes(summary), depth === 11);
      return { text: source };
    }, config, { ...materials, reason, input: { raw: literalInput, text: literalInput }, history });
    assert.ok(reply.text.includes(oldStory) && reply.text.includes(summary));
    assert.ok(!reply.text.includes('模拟思考'));
    assert.ok(displayed(reply).includes('<details><summary>摘要</summary>'));
  }
  assert.equal(f.requests, 2);
});

function fixture(capability = 1, apiVersion = 7, sharedPresets = {}) {
  let saved, generator, respond, requests = 0;
  const handlers = new Map();
  const tavern = {
    apiVersion, capabilities: { bodyGeneration: capability, bodyProjection: 1, ...sharedPresets.capabilities },
    ...sharedPresets.methods,
    getPluginDataLimits: () => ({ maxBytes: 256 * 1024 * 1024 }),
    readPluginData: async () => structuredClone(saved),
    savePluginData: async ({ data }) => { saved = structuredClone(data); },
    handle: (key, fn) => handlers.set(key, fn), onGameRemoved() {},
    bodyGenerator: entry => { assert.equal(generator, undefined); generator = entry; },
    get bodyRegenerator() { assert.fail('must not access fork APIs'); },
  };
  const llm = { async prepareCall(config, signal, configure) {
    const { provider, model, ...controls } = config;
    return { config: { ...configure(controls, { context: { contextWindow: 128000 } }), provider, model },
      async *stream(request) {
        requests++;
        const response = await respond(request);
        if (response.text !== undefined) yield { type: 'text-delta', index: 0, text: response.text };
        for (const [index, call] of (response.toolCalls || []).entries()) yield { type: 'block-end', index: index + 1, block: { type: 'tool-call', ...call } };
        yield { type: 'finish', reason: response.finishReason || { kind: 'stop' } };
      } };
  } };
  apply({ tavern, llm, get: key => { assert.equal(key, 'tokenMeter'); },
    get agents() { assert.fail('must not read the foreground model'); } });
  return {
    get generator() { return generator; }, get requests() { return requests; }, get saved() { return saved; }, handlers,
    call: (key, value) => handlers.get('dsh-tavern-stcontext/' + key)(value),
    prepare: () => generator.prepare({ gameId: 'test', reason: 'normal', signal: new AbortController().signal }),
    generate: (response, config, input = materials, signal = new AbortController().signal) => {
      respond = response;
      return generator.generate({ materials: input, config, signal });
    },
  };
}
async function importPreset(f, document = preset) {
  const text = JSON.stringify(document), { id } = await f.call('upload/begin', { name: 'example.json', size: text.length });
  for (let index = 0, offset = 0; offset < text.length; index++, offset += 50000) await f.call('upload/chunk', { id, index, text: text.slice(offset, offset + 50000) });
  await f.call('upload/finish', { id });
  await f.call('settings', { model: { provider: 'fixture', model: 'story', reasoningEffort: 'high' } });
}

const damper = { slot: 'currentStateProjection', origin: 'plugin', plugin: 'dsh-tavern', name: 'narrative-damper', text: '冻结裁定 D {{user}}' };
const dice = { slot: damper.slot, origin: 'plugin', plugin: 'dsh-tavern-fate-dice', name: 'tavern-plugin:dsh-tavern-fate-dice:fate-dice', text: '冻结骰面 F {{char}}' };
const both = { injectNarrativeDamper: true, injectFateDice: true };
async function rulingFixture(settings = both) {
  let observer, read, invalidate;
  const reads = [], frames = new Map();
  const f = fixture(1, 8, { methods: {
    turnSection(entry) { observer = entry.text; },
    onTimelineChanged(callback) { invalidate = callback; },
    async getRequestContext(args) { reads.push(args); return read ? read(args) : (frames.get(args.turn) ?? null); },
    getTurnState() { assert.fail('the last written story turn is not a generation target'); },
  } });
  await importPreset(f); await f.call('settings', settings);
  return { f, reads, frames, setRead(fn) { read = fn; }, invalidate() { invalidate({ gameId: 'test', kind: 'rollback' }); },
    observe(turn, input = materials.input.raw, gameId = materials.gameId) { assert.equal(observer({ gameId, turn, input }), ''); },
    async dispatch(config, dto = materials) {
      let text;
      await f.generate(request => { text = request.messages.flatMap(m => m.content).map(b => b.text).join('\n'); return { text: '正文' }; }, config, dto);
      const preview = await f.call('request', { gameId: dto.gameId });
      return { text, warnings: preview.report.warnings.filter(msg => /动态裁定|裁定段/.test(msg)) };
    },
  };
}
const frame = (turn, sections = [damper, dice]) => ({ turn, input: materials.input.text, sections });

test('normal preparation binds only turn identity; the worker receives the two exact frozen source sections', async () => {
  const h = await rulingFixture();
  h.observe(8); // host invokes turnSection before prepare and saves the frame afterwards
  const config = JSON.parse(JSON.stringify(await h.f.prepare()));
  assert.equal(config.turnRulingBinding.turn, 8);
  for (const raw of [materials.input.raw, materials.input.text, damper.text, dice.text]) assert.ok(!JSON.stringify(config).includes(raw));
  const decoy = '【命运之骰】【叙事阻尼器】其他段绝不能进入发送副本';
  h.frames.set(8, frame(8, [damper, dice, ...[
    { ...dice, plugin: 'dsh-tavern-fate-dice-evil' }, { ...dice, name: 'fate-dice' },
    { ...dice, origin: 'preset' }, { ...dice, slot: 'activeWorldbook' }, { ...damper, name: 'style-reference' },
    { ...damper, plugin: 'dsh-tavern-narrative-damper' }, { ...damper, slot: 'writingRules' },
  ].map(row => ({ ...row, text: decoy }))]));
  await h.f.call('settings', { injectFateDice: false, injectNarrativeDamper: false });
  const dto = Object.freeze({ ...materials, history: [...materials.history,
    { role: 'user', text: materials.input.raw, turn: 8 }, { role: 'assistant', text: '', turn: 8, input: materials.input.raw, greeting: false }] });
  const before = structuredClone(dto), sent = await h.dispatch(config, dto);
  for (const raw of [damper.text, dice.text]) assert.equal(sent.text.split(raw).length - 1, 1);
  assert.ok(!sent.text.includes(decoy)); assert.deepEqual(sent.warnings, []);
  assert.deepEqual(dto, before);
  assert.deepEqual(h.reads, Array(2).fill({ gameId: 'test', turn: 8 }));
});

test('a repeated input never selects the previous frame, a guessed +1, or a completed history turn', async () => {
  const h = await rulingFixture();
  h.observe(5); const first = await h.f.prepare(); h.frames.set(5, frame(5));
  const prior = { ...materials, history: [...materials.history, { role: 'assistant', turn: 5, text: '已写完' }] };
  for (const cfg of [first, await h.f.prepare()]) {
    const miss = await h.dispatch(cfg, prior);
    assert.ok(!miss.text.includes(dice.text)); assert.equal(miss.warnings.length, 1);
  }
  h.observe(5); assert.equal((await h.f.prepare()).turnRulingBinding, undefined); // already persisted before prepare
  h.observe(11); const second = await h.f.prepare();
  h.frames.set(11, frame(11, [{ ...dice, text: '另一轮的骰面' }]));
  const hit = await h.dispatch(second, prior);
  assert.ok(hit.text.includes('另一轮的骰面')); assert.ok(!hit.text.includes(dice.text));
  assert.deepEqual(h.reads.map(r => r.turn), [5, 5, 11, 11]);
});

test('switching after several native turns binds the new turn; genuine overlaps and timeline changes invalidate it', async () => {
  const h = await rulingFixture();
  for (const nativeTurn of [3, 4, 8]) { h.observe(nativeTurn); h.frames.set(nativeTurn, frame(nativeTurn)); }
  h.observe(12); const normal = await h.f.prepare(); h.frames.set(12, frame(12));
  assert.ok((await h.dispatch(normal)).text.includes(dice.text));
  assert.deepEqual(h.reads.map(({ turn }) => turn), [8, 12, 12]);
  // The same raw/projected input and visible prior floors are no proof after a rollback.
  h.invalidate(); assert.equal((await h.dispatch(normal)).warnings.length, 1);
  h.observe(15); h.observe(16); // 15 never landed
  assert.equal((await h.f.prepare()).turnRulingBinding, undefined);
  h.observe(22); h.observe(22); assert.equal((await h.f.prepare()).turnRulingBinding, undefined);
  h.observe(24); h.setRead(() => { h.invalidate(); return null; });
  assert.equal((await h.f.prepare()).turnRulingBinding, undefined);
});

test('a frozen config without its live ticket cannot select a reused turn after reload or eviction', async () => {
  const original = await rulingFixture(); original.observe(8);
  const frozen = JSON.parse(JSON.stringify(await original.f.prepare()));
  const reloaded = await rulingFixture();
  for (let i = 0; i < 64; i++) original.observe(1, '其他输入', 'another-game-' + i);
  for (const h of [original, reloaded]) {
    h.frames.set(8, frame(8)); const before = h.reads.length;
    const sent = await h.dispatch(frozen);
    assert.equal(sent.warnings.length, 1); assert.ok(!sent.text.includes(dice.text));
    assert.equal(h.reads.length, before);
  }
});

test('normal checks game, raw and projected inputs and returned turn; empty differs from ambiguous', async () => {
  const h = await rulingFixture(); h.observe(8); const config = await h.f.prepare();
  for (const [snapshot, dto] of [
    [null, materials], [frame(9), materials], [{ ...frame(8), input: materials.input.raw }, materials],
    [frame(8), { ...materials, gameId: 'other' }], [frame(8), { ...materials, input: { ...materials.input, raw: '不同原始输入' } }],
  ]) {
    h.frames.set(8, snapshot); const miss = await h.dispatch(config, dto);
    assert.ok(!miss.text.includes(damper.text)); assert.equal(miss.warnings.length, 1);
  }
  h.frames.set(8, frame(8, [])); assert.deepEqual((await h.dispatch(config)).warnings, []);
  h.frames.set(8, frame(8, [damper, dice, { ...dice, text: '歧义骰面' }]));
  const ambiguous = await h.dispatch(config);
  assert.ok(ambiguous.text.includes(damper.text) && !ambiguous.text.includes(dice.text) && !ambiguous.text.includes('歧义骰面'));
  assert.equal(ambiguous.warnings.length, 1);
  h.frames.set(8, frame(8, [{ text: '【命运之骰】不能按标题恢复' }]));
  const oldShape = await h.dispatch(config);
  assert.ok(!oldShape.text.includes('不能按标题恢复')); assert.equal(oldShape.warnings.length, 1);
});

test('no context reads with disabled switches or an ambiguous replacement; an old host still sends', async () => {
  const h = await rulingFixture({}); h.observe(6); const disabled = await h.f.prepare();
  assert.equal(disabled.turnRulingBinding, undefined);
  assert.deepEqual((await h.dispatch(disabled)).warnings, []); assert.deepEqual(h.reads, []);
  await h.f.call('settings', { injectFateDice: true }); h.observe(8); const normal = await h.f.prepare(); h.frames.set(8, frame(8));
  const hit = await h.dispatch(normal); assert.ok(hit.text.includes(dice.text) && !hit.text.includes(damper.text));
  for (const reason of ['retry', 'regenerate']) {
    h.observe(8);
    const fresh = await h.f.generator.prepare({ reason, gameId: materials.gameId, signal: new AbortController().signal });
    for (const cfg of [normal, fresh]) { // a matching old normal snapshot isn't a replacement target
      const miss = await h.dispatch(cfg, { ...materials, reason, operationId: 'attempt:turn:8' });
      assert.ok(!miss.text.includes(dice.text)); assert.equal(miss.warnings.length, 1);
    }
  }
  assert.equal(h.reads.length, 2);
  const old = fixture(); await importPreset(old); await old.call('settings', both);
  assert.equal((await old.generate(() => ({ text: '可用' }), await old.prepare())).text, '可用');
  assert.ok((await old.call('request', { gameId: 'test' })).report.warnings.some(s => s.includes('动态裁定')));
});

test('frame read failure degrades to a preview warning; cancellation interrupts outstanding frame reads', async () => {
  const h = await rulingFixture(); h.observe(8); const cfg = await h.f.prepare();
  h.setRead(() => { throw Error('宿主暂时不可读'); });
  assert.equal((await h.dispatch(cfg)).warnings.length, 1);
  for (const step of ['generate', 'prepare']) {
    const controller = new AbortController();
    let reading; const called = new Promise(resolve => { reading = resolve; });
    h.setRead(() => { reading(); return new Promise(() => {}); });
    if (step === 'prepare') h.observe(9);
    const task = step === 'prepare' ? h.f.generator.prepare({ reason: 'normal', gameId: 'test', signal: controller.signal })
      : h.f.generate(() => assert.fail('no dispatch'), cfg, materials, controller.signal);
    await called; controller.abort(new Error('取消宿主读取'));
    await assert.rejects(task, /取消宿主读取/);
  }
});

test('upstream API 7 registers once, imports, and freezes configuration without a model request', async () => {
  const f = fixture();
  assert.equal(name, 'dsh-tavern-STcontext');
  await assert.rejects(f.prepare(), /先.*导入/);
  await importPreset(f);
  const config = await f.prepare();
  assert.equal(f.requests, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), config);
  assert.equal((await f.call('config')).hostReady, true);
  assert.equal((await f.call('config')).generationReady, true);
  for (const key of ['start', 'status', 'cancel']) assert.equal(f.handlers.has('dsh-tavern-stcontext/' + key), false);
});

test('shared presets are referenced, read fresh for each preparation and frozen for generation', async () => {
  const id = 'presets/shared.json', source = structuredClone(preset), reads = [];
  const f = fixture(1, 7, {
    capabilities: { generationPresets: 1 }, methods: {
      listGenerationPresets: async () => [{ id, name: 'Shared' }],
      readGenerationPreset: async selection => {
        reads.push(selection);
        return { id, name: 'Shared', revision: 'rev', text: JSON.stringify(source) };
      },
    },
  });
  assert.deepEqual((await f.call('config')).sharedPresets, [{ id, name: 'Shared' }]);
  await f.call('settings', { model: { provider: 'fixture', model: 'story', reasoningEffort: 'high' } });
  await f.call('select', { hostPreset: id });
  assert.equal(f.saved.hostPreset, id);
  assert.deepEqual(f.saved.presets, []);
  const oldConfig = await f.prepare();
  source.extensions.regex_scripts.find(rule => rule.replaceString === 'XX').replaceString = 'YY';
  const newConfig = await f.prepare();
  assert.deepEqual(reads, [{ id }, { id }, { id }]);
  assert.equal(displayed(await f.generate(async () => ({ text: 'X' }), oldConfig)), 'XX');
  assert.equal(displayed(await f.generate(async () => ({ text: 'X' }), newConfig)), 'YY');
  await f.call('select', { hostPreset: 'current' });
  await f.prepare();
  assert.deepEqual(reads.at(-1), { gameId: 'test' });
  await importPreset(f);
  assert.equal((await f.call('config')).hostPreset, null);
});

test('large presets cross the 2 MiB host snapshot boundary compressed and keep old expanded snapshots usable', async () => {
  const f = fixture();
  const document = { ...preset, notes: '原始数据'.repeat(800000) };
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > 8 * 1024 * 1024);
  await importPreset(f, document);
  const frozen = JSON.parse(JSON.stringify(await f.prepare()));
  assert.equal(frozen.snapshotVersion, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(frozen)) < 2 * 1024 * 1024);
  await f.call('remove', { id: (await f.call('config')).activeId });
  for (const config of [frozen, restoreGenerationConfig(frozen)]) {
    const output = await f.generate(async () => ({ text: 'X' }), config);
    assert.equal(displayed(output), 'XX');
  }
});

test('capabilities, not fork API versions or method presence alone, control registration', async () => {
  for (const capability of [0, null, 2]) {
    const f = fixture(capability, 8);
    await importPreset(f);
    assert.equal((await f.call('config')).hostReady, false);
    assert.equal(f.generator, undefined);
  }
  assert.ok(fixture(1, 7).generator);
});

for (const reason of ['normal', 'regenerate', 'retry']) {
  test(`${reason} uses complete upstream materials and runs output regex once`, async () => {
    const f = fixture(); await importPreset(f);
    await f.call('settings', { personaDescription: '自定义玩家设定 {{保持原样}}' });
    const config = await f.prepare();
    const output = await f.generate(async request => {
      assert.equal(request.provider, 'fixture'); assert.equal(request.model, 'story');
      assert.equal(request.reasoningEffort, 'high');
      const text = request.messages.map(m => m.content[0].text).join('\n');
      for (const value of [...materials.history.map(m => m.text), ...materials.context.map(m => m.text),
        '测试角色与测试玩家', '输入处理后的状态', '"hp":10', '"inputCount":2', '本轮已处理输入', '额外指导', '自定义玩家设定 {{保持原样}}']) {
        assert.equal(text.split(value).length - 1, 1, value + ' must occur once');
      }
      assert.ok(text.includes(reason === 'normal' ? 'normal-only' : 'regenerate-only'));
      assert.ok(!text.includes(reason === 'normal' ? 'regenerate-only' : 'normal-only'));
      assert.ok(!text.includes('原始输入'));
      return { text: '<div>X</div>' };
    }, config, { ...materials, reason, guidance: '额外指导' });
    assert.equal(output.text, '<div>X</div>');
    assert.equal(displayed(output), '<div>XX</div>');
    assert.equal(output.regexScripts[0].promptOnly, false);
    assert.equal(f.requests, 1);
    const preview = await f.call('request', { gameId: 'test' });
    assert.equal(preview.report.reason, reason);
    assert.equal(preview.report.operationId, 'operation');
    assert.deepEqual(JSON.parse(preview.text).request.model, config.settings.model);
  });
}

test('request preview reports the host policy while preset output regex stays active', async () => {
  const f = fixture(); await importPreset(f);
  const config = await f.prepare();
  for (const hostRegex of [true, false, undefined]) {
    const input = { ...materials, ...(hostRegex === undefined ? {} : { outputProcessing: { hostRegex } }) };
    const reply = await f.generate(async () => ({ text: 'X' }), config, input);
    assert.equal(reply.text, 'X');
    assert.equal(displayed(reply), 'XX');
    const preview = await f.call('request', { gameId: materials.gameId });
    assert.equal(preview.report.outputProcessing?.hostRegex, hostRegex);
    const decoded = JSON.parse(preview.text);
    assert.equal(decoded.report.outputProcessing?.hostRegex, hostRegex);
    assert.equal(Object.hasOwn(decoded.request, 'outputProcessing'), false);
  }
});

test('prepared preset/model/persona survive selection changes and removal until the next operation', async () => {
  const f = fixture(); await importPreset(f);
  await f.call('settings', { personaDescription: '原玩家设定' });
  const firstId = (await f.call('config')).activeId, frozen = JSON.parse(JSON.stringify(await f.prepare()));
  const next = structuredClone(preset); next.extensions.regex_scripts[0].replaceString = 'YY';
  await importPreset(f, next);
  await f.call('settings', { model: { provider: 'later', model: 'next' }, personaDescription: '新玩家设定' });
  await f.call('remove', { id: firstId });
  const old = await f.generate(async request => {
    assert.equal(request.model, 'story');
    const text = request.messages.map(message => message.content[0].text).join('\n');
    assert.ok(text.includes('原玩家设定')); assert.ok(!text.includes('新玩家设定'));
    return { text: 'X' };
  }, frozen);
  const current = await f.generate(async request => {
    assert.equal(request.model, 'next');
    const text = request.messages.map(message => message.content[0].text).join('\n');
    assert.ok(text.includes('新玩家设定')); assert.ok(!text.includes('原玩家设定'));
    return { text: 'X' };
  }, await f.prepare());
  assert.equal(displayed(old), 'XX'); assert.equal(displayed(current), 'YY');
  await assert.rejects(f.generate(() => assert.fail('no model request'), null), /冻结的预设配置/);
  assert.equal(f.requests, 2);
});

test('saving an edited preset changes the next preparation but not an ongoing generation', async () => {
  const f = fixture(); await importPreset(f);
  const frozen = await f.prepare(), id = (await f.call('config')).activeId;
  const base = await f.call('preset/read', { id });
  const edited = JSON.parse(base.text);
  edited.prompts.find(prompt => prompt.identifier === 'identity').content = 'EDITED PROMPT';
  edited.extensions.regex_scripts[0].replaceString = 'YY';
  const text = JSON.stringify(edited), upload = await f.call('upload/begin', { name: 'edited.json', operation: 'replace', presetId: id, revision: base.revision, size: text.length });
  await f.call('upload/chunk', { ...upload, index: 0, text }); await f.call('upload/finish', upload);
  const old = await f.generate(async request => {
    assert.ok(!JSON.stringify(request.messages).includes('EDITED PROMPT')); return { text: 'X' };
  }, frozen);
  const next = await f.generate(async request => {
    assert.ok(JSON.stringify(request.messages).includes('EDITED PROMPT')); return { text: 'X' };
  }, await f.prepare());
  assert.equal(displayed(old), 'XX'); assert.equal(displayed(next), 'YY');
});

test('invalid selection/materials fail before dispatch; model failure never returns a candidate', async () => {
  const f = fixture(); await importPreset(f);
  await f.call('settings', { model: null });
  await assert.rejects(f.prepare(), /选择插件正文模型/);
  await importPreset(f);
  const config = await f.prepare();
  await assert.rejects(f.generate(() => assert.fail('no dispatch'), config, { ...materials, schemaVersion: 2 }), /材料格式/);
  assert.equal(f.requests, 0);
  await assert.rejects(f.generate(async () => { throw new Error('model failure'); }, config), { code: 'STCONTEXT_PROVIDER_ERROR', stage: 'response' });
});

for (const reason of ['normal', 'regenerate', 'retry']) test(`${reason} exposes the original failure stage without a candidate or retry`, async () => {
  const f = fixture(), doc = structuredClone(preset);
  // If response failures reached output processing, this would hide the cause.
  doc.extensions.SPreset = { OutputPreprocessing: { enabled: true, script: '() => {throw Error("must not run");}' } };
  await importPreset(f, doc);
  const config = await f.prepare();
  for (const [response, code] of [
    [{ text: '', finishReason: { kind: 'error', failure: { message: 'Provider finish_reason: content_filter' } } }, 'CONTENT_FILTERED'],
    [{ text: '', finishReason: { kind: 'error', failure: { code: 'context_length_exceeded' } } }, 'CONTEXT_OVERFLOW'],
    [{ text: '' }, 'EMPTY_RESPONSE'],
  ]) {
    const before = f.requests;
    await assert.rejects(f.generate(async () => response, config, { ...materials, reason }), { code: 'STCONTEXT_' + code, stage: 'response' });
    assert.equal(f.requests, before + 1);
  }
  doc.extensions.SPreset.OutputPreprocessing.script = '() => ({output:""})';
  await importPreset(f, doc);
  await assert.rejects(f.generate(async () => ({ text: '正文' }), await f.prepare(), { ...materials, reason }), {
    code: 'STCONTEXT_OUTPUT_EMPTY', stage: 'output-script', message: '预设输出脚本处理后正文为空，未替换宿主正文',
  });
  assert.equal(f.requests, 4);
});

test('cancellation before compilation or after a late model response cannot return prose', async () => {
  const f = fixture(); await importPreset(f);
  const config = await f.prepare(), early = new AbortController(); early.abort(new Error('stopped early'));
  await assert.rejects(f.generate(() => assert.fail('no dispatch'), config, materials, early.signal), /stopped early/);
  assert.equal(f.requests, 0);
  const late = new AbortController();
  await assert.rejects(f.generate(async () => { late.abort(new Error('stopped late')); return { text: 'X' }; }, config, materials, late.signal), /stopped late/);
});

test('SPreset pipeline uses frozen hooks, previews the exact request, and returns a tool body after one regex pass', async () => {
  const f = fixture(), document = structuredClone(preset);
  document.extensions.SPreset = {
    ToolBindings: { identity: { enabled: true, editorMode: 'form', form: { name: 'story', description: '正文', parameters: [{ name: 'text', type: 'string', required: true }] } } },
    FinalRequestProcessing: { enabled: true, script: '({request}) => { request.messages[0].content += "\\nnonce=" + Math.random(); return request; }' },
    OutputPreprocessing: { consumeToolCalls: true, toolCallFormatter: { enabled: true, script: '({calls}) => "<body>" + calls[0].arguments.text + "</body>"' } },
  };
  await importPreset(f, document);
  const config = await f.prepare();
  document.extensions.SPreset.OutputPreprocessing.toolCallFormatter.script = '() => "changed"';
  await importPreset(f, document);
  let sent;
  const output = await f.generate(async request => { sent = request; return { toolCalls: [{ id: 'one', name: 'story', arguments: { text: 'X' } }] }; }, config);
  assert.equal(output.text, '<body>X</body>');
  assert.equal(displayed(output), '<body>XX</body>');
  assert.equal(f.requests, 1);
  const preview = JSON.parse((await f.call('request', { gameId: 'test' })).text);
  assert.deepEqual(preview.request.messages, sent.messages.map(m => ({ role: m.role, content: m.content[0].text })));
  assert.deepEqual(preview.request.tools, sent.tools);
});

test('SPreset failed scripts and expanded request budgets never reach the model', async () => {
  for (const script of ['() => { throw Error("hook failure"); }',
    '({request}) => {request.messages[0].content += "x".repeat(500000); return request;}']) {
    const f = fixture(), document = structuredClone(preset);
    document.extensions.SPreset = { FinalRequestProcessing: { enabled: true, script } };
    await importPreset(f, document);
    const config = await f.prepare();
    await assert.rejects(f.generate(() => assert.fail('no model dispatch'), config), /hook failure|超过模型窗口/);
    assert.equal(f.requests, 0);
  }
});

test('helper request/response interception survives the real worker boundary and frozen configuration', async () => {
  const f = fixture(), document = structuredClone(preset);
  document.extensions.tavern_helper = { scripts: [{ enabled: true, name: 'generic transport', content: `(() => {
    const original = fetch;
    fetch = async (url, options) => {
      const data = JSON.parse(options.body), name = 'body_' + Math.floor(Math.random()*1000000);
      data.tools = [{type:'function', function:{name,description:data.messages.map(m=>m.content).join('\\n'),parameters:{type:'object'}}}];
      data.messages = [{role:'user',content:'return body'}];
      const response = await original(url, {...options,body:JSON.stringify(data)});
      const json = await response.json(), msg = json.choices[0].message;
      if (msg.tool_calls[0].function.name !== name) throw Error('request context changed');
      msg.content = JSON.parse(msg.tool_calls[0].function.arguments).body;
      delete msg.tool_calls;
      return new Response(JSON.stringify(json));
    };
  })();` }] };
  await importPreset(f, document);
  const config = await f.prepare();
  await importPreset(f, preset);
  const result = await f.generate(async request => {
    assert.equal(request.tools.length, 1);
    assert.ok(request.tools[0].description.includes('完整历史正文 {{不要再次展开}}'));
    assert.doesNotMatch(JSON.stringify(request), /STCONTEXT_MATERIAL_/);
    return { toolCalls: [{ name: request.tools[0].name, arguments: '{"body":"X"}' }] };
  }, config);
  assert.equal(displayed(result), 'XX');
  assert.equal(f.requests, 1);
  const preview = await f.call('request', { gameId: 'test' });
  assert.equal(preview.report.protocol, 'spreset');
  assert.ok(JSON.parse(preview.text).request.tools[0].name.startsWith('body_'));
  assert.ok(!preview.text.includes('helperState'));
});
