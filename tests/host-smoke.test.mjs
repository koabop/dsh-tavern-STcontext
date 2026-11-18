import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from '../index.mjs';
import { preset } from './fixtures/materials.mjs';

// Real upstream regeneration transaction and native DSH Session, with optional user preset.
const enabled = process.env.STCONTEXT_HOST_REPO && process.env.DSH_BOOT_MODULE;
const kunlun = !!process.env.STCONTEXT_PRESET_FIXTURE;
for (const failed of [false, true]) test(`upstream ${failed ? 'failed-input retry' : 'regeneration'} -> frozen preset -> native sync/settlement`, { skip: !enabled, timeout: 20000 }, async () => {
  const host = async path => import(pathToFileURL(resolve(process.env.STCONTEXT_HOST_REPO, path)).href);
  const [{ createBodyGenerationProviders }, { createPluginBodyGeneration }, { createRoundHistory }, { createStoryTimeline },
    { captureBodyRegenerationSource, buildBodyRegenerationMaterials }, { Session }, { appendSessionEvent }] = await Promise.all([
    host('tavern-plugin/lib/domain/body-generation-providers.js'), host('tavern-plugin/lib/domain/plugin-body-generation.js'),
    host('tavern-plugin/lib/domain/round-history.js'), host('tavern-plugin/lib/domain/story-timeline.js'),
    host('tavern-plugin/lib/domain/body-regeneration-materials.js'), host('tests/fixtures/dsh-session-host.mjs'),
    host('tavern-plugin/lib/domain/session-events.js'),
  ]);
  const clone = structuredClone, revisions = new Map(), card = { name: '守门人', description: '测试人物设定' };
  let state, revision = 0;
  const chats = {
    async write(chat) { state = { ...clone(chat), _storageRevision: ++revision }; revisions.set(revision, clone(state)); return clone(state); },
    async read() { return clone(state); }, async readState() { return clone(state); }, async forSession() { return clone(state); },
    async readRevision(id, rev) { return clone(revisions.get(rev)); }, async readCard() { return clone(card); },
    async update(id, fn) { const updated = await fn(clone(state)); return updated === undefined ? clone(state) : this.write(updated); },
  };
  const initialMessages = [
    { role: 'assistant', turn: 1, greeting: true, text: '完整可见开场白' },
    { role: 'user', text: '前轮可见玩家输入' },
    { role: 'tavern-helper', tavernRole: 'assistant', tavernHidden: true, text: 'NEVER_SEND_HIDDEN_HELPER' },
    { role: 'assistant', turn: 2, text: '前轮完整可见正文', variables: [{ hp: 10 }] },
  ];
  const timeline = createStoryTimeline();
  await chats.write(timeline.apply({ chat: { id: 'chat', sessionId: 'session', mode: 'story', messages: initialMessages,
    posture: '本轮起点 HP 10', cardContextSnapshot: '已展开人物设定', userProfileContextSnapshot: '玩家人设',
    macroState: { userName: '测试玩家', local: { inputCount: 1 } }, mvu: { enabled: true, owner: 'official' } }, intent: { kind: 'ensure' } }).chat);
  const before = await chats.read();
  const begun = timeline.apply({ chat: before, intent: { kind: 'body.begin', turn: 3, userText: '本轮原有输入' } });
  const operation = begun.chat.timeline.operations[begun.value.operationId];
  const prepared = { ...begun.chat, macroState: { userName: '测试玩家', local: { inputCount: 2 } },
    tavernScriptPrompts: [{ id: 'one-shot', once: true, content: '原有写作提示' }] };
  begun.chat.foregroundFrames = { [operation.id]: { kind: 'foreground', chatId: 'chat', turn: 3,
    operationId: operation.id, branchId: operation.basedOn.branchId, basedOnRevision: operation.basedOn.revision,
    userInput: { sourceText: '本轮原有输入', projectedText: '本轮原有输入' },
    contributions: [{ slot: 'activeWorldbook', text: '本轮选取世界书' }, { slot: 'writingRules', text: '本轮写作要求' }],
    source: { ...captureBodyRegenerationSource({ chat: prepared, card }), worldBook: { refs: [] } } } };
  const completed = timeline.complete({ chat: begun.chat, operationId: operation.id, basedOn: operation.basedOn,
    outcome: { status: 'success' }, apply(chat) {
      chat.messages.push({ role: 'user', text: '本轮原有输入', variables: [{ hp: 10 }] },
        { role: 'assistant', turn: 3, sourceText: '应被替换的旧正文', text: '应被替换的旧正文', variables: [{ hp: 9 }] });
      chat.posture = '旧正文后 HP 9'; chat.macroState = { local: { inputCount: 2, oldOutput: 1 } }; chat.settleStatus = 'done';
    } });
  await chats.write(failed ? begun.chat : completed.chat);
  const session = Session.create('session');
  let messageId = 0;
  for (const row of [...initialMessages, ...(failed ? [] : [{ role: 'user', text: '本轮原有输入' }, { role: 'assistant', turn: 3, text: '应被替换的旧正文' }])]) {
    if (row.tavernHidden) continue;
    const message = { id: 'm' + ++messageId, role: row.role, source: row.role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: row.text }] };
    if (row.role === 'user') appendSessionEvent(session, 'user/message', message, { surfaceOp: 'append' });
    else appendSessionEvent(session, 'assistant/message', { turn: row.turn, step: 1, message }, { surfaceOp: 'append', sourceEventSeqs: [] });
  }
  if (failed) {
    appendSessionEvent(session, 'turn/start', { turn: 3 });
    appendSessionEvent(session, 'step/start', { turn: 3, step: 1 });
    appendSessionEvent(session, 'user/message', { id: 'failed-input', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '本轮原有输入' }] }, { surfaceOp: 'append' });
    appendSessionEvent(session, 'step/end', { turn: 3, step: 1 });
    appendSessionEvent(session, 'turn/end', { turn: 3, reason: { kind: 'error', message: '模型拒绝' } });
  }
  const agent = { session, phase: { kind: 'idle', lastTurn: 3 }, followup() { throw new Error('Foreground agent must not run'); } };
  const settlements = [], notifications = [], projections = [], phases = [];
  let capturedMaterials, candidate, modelCalls = 0;
  const history = createRoundHistory({
    chats, timeline, sessions: { get: () => agent, flush: async () => {} }, scripts: {},
    readRegenerationMaterials: async input => { capturedMaterials = buildBodyRegenerationMaterials(input); return capturedMaterials; },
    prepareRegenerationReply: async ({ chat, text }) => {
      projections.push(text);
      assert.equal(chat.macroState.local.inputCount, 2); assert.equal(chat.macroState.local.oldOutput, undefined);
      return { projectionText: text, sessionText: text, displayText: text, displayMode: 'html', warnings: [] };
    }, cancelSettlement: async () => {}, notifyRegeneration: async (id, target) => notifications.push(target.turn),
    queueSettlement: async () => { settlements.push(await chats.read()); await chats.update('chat', chat => { chat.settleStatus = 'done'; chat.posture = '新正文结算后状态'; return chat; }); },
    present: async chat => chat,
  });
  const rawOutput = '<talk>过程</talk><content><hidden>极其平静的正文</hidden></content>';
  const llm = {
    async prepareCall(config, signal, transform) {
      const controls = transform(config, { context: { contextWindow: 1000000 }, defaultMaxTokens: 4096 });
      return { config: controls, stream: async function* (options) {
        modelCalls++;
        assert.equal(options.provider, 'independent'); assert.equal(options.model, 'plugin-story');
        assert.equal(options.system, ''); assert.equal(options.tools.length, kunlun ? 1 : 0);
        const wire = JSON.stringify(options);
        for (const text of ['完整可见开场白', '前轮可见玩家输入', '前轮完整可见正文', '本轮原有输入', '已展开人物设定', '本轮选取世界书', '本轮写作要求', '本轮起点 HP 10']) assert.ok(wire.includes(text), text);
        assert.doesNotMatch(wire, /NEVER_SEND_HIDDEN_HELPER|应被替换的旧正文|旧正文后 HP 9/);
        if (kunlun) {
          const toolName = options.tools[0].name;
          assert.match(toolName, /^view_file_stream_/);
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'output', name: toolName, arguments: { buffer_content: rawOutput } } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          assert.match(wire, /regenerate-only/); assert.doesNotMatch(wire, /normal-only/);
          yield { type: 'text-delta', index: 0, text: '<div>X</div>' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      } };
    },
  };
  const providers = createBodyGenerationProviders({ allowed: async () => true });
  const generation = createPluginBodyGeneration({ chatForSession: chats.forSession,
    updateChat: chats.update.bind(chats), readRevision: chats.readRevision,
    settings: async () => ({ storyGenerationMode: 'plugin-direct', storyGenerationProvider: 'dsh-tavern-STcontext:st-context' }), providers,
    regenerateWithProvider: input => history.regenerateWithProvider({ ...input, onPhase: phase => { phases.push(phase); input.onPhase(phase); } }) });
  const owner = 'dsh-tavern-STcontext', handlers = new Map();
  let saved;
  apply({ get: () => undefined, llm, get agents() { assert.fail('must not read foreground selection'); }, tavern: {
    capabilities: { bodyGeneration: 1 },
    readPluginData: async () => clone(saved), savePluginData: async ({ data }) => { saved = clone(data); },
    handle: (key, handler) => handlers.set(key, handler), onGameRemoved() {},
    bodyGenerator: entry => providers.register(owner, { ...entry, generate: async input => { candidate = await entry.generate(input); return candidate; } }),
  } });
  const call = (name, input) => handlers.get('dsh-tavern-stcontext/' + name)(input);
  const presetSource = kunlun ? await readFile(process.env.STCONTEXT_PRESET_FIXTURE, 'utf8') : JSON.stringify(preset);
  const upload = await call('upload/begin', { name: 'user-imported.json', size: presetSource.length });
  for (let offset = 0, index = 0; offset < presetSource.length; offset += 50000, index++) await call('upload/chunk', { id: upload.id, index, text: presetSource.slice(offset, offset + 50000) });
  await call('upload/finish', { id: upload.id });
  await call('settings', { model: { provider: 'independent', model: 'plugin-story' } });
  assert.equal((await call('export', { id: saved.activeId })).text, presetSource);
  const result = await generation.regenerate('session');
  assert.equal(result.settlement, 'done');
  assert.equal(modelCalls, 1);
  assert.equal(candidate.text, kunlun ? rawOutput : '<div>X</div>');
  assert.deepEqual(projections, [candidate.text]); assert.deepEqual(notifications, [failed ? 4 : 3]);
  assert.deepEqual(phases, ['generating', 'validating', 'committed', 'settling']);
  assert.equal(capturedMaterials.completeness.history, 'all-visible');
  assert.equal(capturedMaterials.history.length, 3);
  assert.equal(capturedMaterials.history.at(-1).input, '前轮可见玩家输入');
  assert.doesNotMatch(JSON.stringify(capturedMaterials), /NEVER_SEND_HIDDEN_HELPER/);
  const current = await chats.read();
  assert.equal(current.messages.at(-1).text, candidate.text);
  assert.equal(current.messages.at(-1).bodyRegenerationProcessed, true);
  assert.ok(current.messages.some(row => row.text === '前轮完整可见正文'), 'previous successful body remains intact');
  assert.equal(current.posture, '新正文结算后状态');
  assert.equal(settlements.length, 1); assert.equal(settlements[0].posture, '本轮起点 HP 10');
  assert.deepEqual(settlements[0].messages.at(-1).variables, [{ hp: 10 }]);
  const visible = JSON.stringify(session.deriveMessages());
  assert.ok(visible.includes(candidate.text)); assert.doesNotMatch(visible, /应被替换的旧正文/);
  const preview = await call('request', { gameId: 'session' });
  assert.equal(preview.report.protocol, 'spreset');
  assert.equal(preview.report.reason, failed ? 'retry' : 'regenerate');
});
