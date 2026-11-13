import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name } from '../index.mjs';
import { materials, preset } from './fixtures/materials.mjs';
import { restoreGenerationConfig } from '../lib/generation-config.mjs';

function fixture(capability = 1, apiVersion = 7, sharedPresets = {}) {
  let saved, generator, respond, requests = 0;
  const handlers = new Map();
  const tavern = {
    apiVersion, capabilities: { bodyGeneration: capability, ...sharedPresets.capabilities },
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
      return generator.generate({ materials: structuredClone(input), config, signal });
    },
  };
}
async function importPreset(f, document = preset) {
  const text = JSON.stringify(document), { id } = await f.call('upload/begin', { name: 'example.json', size: text.length });
  for (let index = 0, offset = 0; offset < text.length; index++, offset += 50000) await f.call('upload/chunk', { id, index, text: text.slice(offset, offset + 50000) });
  await f.call('upload/finish', { id });
  await f.call('settings', { model: { provider: 'fixture', model: 'story', reasoningEffort: 'high' } });
}

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
  assert.equal((await f.generate(async () => ({ text: 'X' }), oldConfig)).text, 'XX');
  assert.equal((await f.generate(async () => ({ text: 'X' }), newConfig)).text, 'YY');
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
    assert.equal(output.text, 'XX');
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
    assert.deepEqual(output, { text: '<div>XX</div>' });
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
    assert.deepEqual(await f.generate(async () => ({ text: 'X' }), config, input), { text: 'XX' });
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
  assert.equal(old.text, 'XX'); assert.equal(current.text, 'YY');
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
  assert.equal(old.text, 'XX'); assert.equal(next.text, 'YY');
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
  assert.equal(output.text, '<body>XX</body>');
  assert.equal(f.requests, 1);
  const preview = JSON.parse((await f.call('request', { gameId: 'test' })).text);
  assert.deepEqual(preview.request.messages, sent.messages.map(m => ({ role: m.role, content: m.content[0].text })));
  assert.deepEqual(preview.request.tools, sent.tools);
});

test('SPreset failed scripts, lost materials and expanded request budgets never reach the model', async () => {
  for (const script of ['() => { throw Error("hook failure"); }',
    '({request}) => {request.messages=[{role:"user",content:"lost"}]; return request;}',
    '({request}) => {request.messages[0].content += "x".repeat(500000); return request;}']) {
    const f = fixture(), document = structuredClone(preset);
    document.extensions.SPreset = { FinalRequestProcessing: { enabled: true, script } };
    await importPreset(f, document);
    const config = await f.prepare();
    await assert.rejects(f.generate(() => assert.fail('no model dispatch'), config), /hook failure|完整历史保护|超过模型窗口/);
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
  assert.equal(result.text, 'XX');
  assert.equal(f.requests, 1);
  const preview = await f.call('request', { gameId: 'test' });
  assert.equal(preview.report.protocol, 'spreset');
  assert.ok(JSON.parse(preview.text).request.tools[0].name.startsWith('body_'));
  assert.ok(!preview.text.includes('helperState'));
});
