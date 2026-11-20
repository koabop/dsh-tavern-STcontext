import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createProtocolTransport, buildProtocolBody } from '../lib/protocol-transport.mjs';
import { validateRequestProtocol, toolPolicy } from '../lib/request.mjs';
import { createDshGeneration } from '../lib/generation.mjs';
import { compilePreset, processOutput } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { materials, preset as basePreset } from './fixtures/materials.mjs';

const signature = 'skip_thought_signature_validator';
const tool = { name: 'story', description: '完整材料', parameters: { type: 'object', properties: { body: { type: 'string' } } } };
function request() {
  return { model: { provider: 'configured', model: 'story-model' }, maxTokens: 256, temperature: 0.7,
    tools: [structuredClone(tool)], toolChoice: 'required', toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['story'] } },
    messages: [{ role: 'user', content: '完整历史' }, { role: 'assistant', thoughtSignature: signature,
      tool_calls: [{ id: 'call_one', type: 'function', signature, extra_content: { google: { thoughtSignature: signature } }, function: { name: 'story', arguments: '{"body":"旧正文"}' } }] },
    { role: 'tool', tool_call_id: 'call_one', name: 'story', content: '{"ok":true}' }, { role: 'user', content: '继续' }] };
}
const openai = (overrides = {}) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
  tool_calls: [{ id: 'new_call', type: 'function', function: { name: 'story', arguments: '{"body":"新正文"}' } }] }, ...overrides }] });
const gemini = () => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'story', args: { body: '新正文' } } }] } }] });
// Default/empty compatibility fields from the pinned pi-ai OpenAI path, not
// additional preset capabilities. The old field-name allowlist rejected these.
const openaiDefaults = {
  thinkingFormat: 'openai', requiresAssistantAfterToolResult: false, requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false, supportsThinkingTokenBudget: false,
  supportsLongCacheRetention: false, thinkingTokenBudgetField: undefined, cacheControlFormat: undefined,
  chatTemplateKwargs: {}, chatTemplateArgs: {}, openRouterRouting: {}, vercelGatewayRouting: {},
  zaiToolStream: false, supportsOpenAIGrammarTools: false, supportsMidConvoSystemMessages: false,
  supportsMidConvoToolAdditions: false, sendSessionAffinityHeaders: false, sessionAffinityFormat: 'openai',
};
function harness({ api = 'openai-completions', reply, capacity = 128000, fetchImpl, profile: additions = {}, beforePrepare } = {}) {
  const sent = [], profile = { api, baseURL: 'https://provider.invalid/v1', apiKeyEnv: 'TEST_API_KEY', ...additions };
  let nativeCalls = 0, credentialReads = 0;
  const llm = {
    listConfigurableProviders: () => [{ provider: 'configured', settingsNs: 'models', settingsPath: ['providers', 'configured'], declared: true }],
    async prepareCall(config, signal, configure) {
      beforePrepare?.(profile);
      const { provider, model, ...controls } = config;
      return { config: { provider, model, ...configure(controls, { context: { contextWindow: capacity } }) },
        async *stream() { nativeCalls++; assert.fail('extended protocols must never fall back to the native adapter'); } };
    },
  };
  const ctx = { llm, get: name => ({ settings: { describe: () => [{ ns: 'models', revision: 1, value: { providers: { configured: profile } } }] },
    credentials: { async resolve(ref) { credentialReads++; assert.equal(ref, 'TEST_API_KEY'); return { value: 'synthetic-test-key' }; } } })[name] };
  const transport = createProtocolTransport(ctx, { fetchImpl: fetchImpl || (async (url, options) => {
    sent.push({ url, ...options, json: JSON.parse(options.body) });
    return Response.json(reply || (api === 'google-generative-ai' ? gemini() : openai()));
  }) });
  return { sent, profile, run: createDshGeneration({ llm, protocolTransport: transport }),
    counts: () => ({ nativeCalls, credentialReads }) };
}

test('history validates call/result pairing, declarations, arguments and consistent signature aliases', () => {
  validateRequestProtocol(request());
  const mutations = [r => r.messages.splice(2, 1), r => r.messages[2].tool_call_id = 'unknown', r => r.messages[2].name = 'wrong',
    r => r.messages[1].tool_calls[0].function.name = 'unknown', r => r.messages[1].tool_calls[0].function.arguments = '{',
    r => r.messages[1].tool_calls[0].function.arguments = '[]', r => r.messages[1].tool_calls.push(structuredClone(r.messages[1].tool_calls[0])),
    r => r.messages[1].tool_calls[0].signature = 'different', r => r.messages[1].tool_calls[0].extra_content.other = 'private',
    r => r.messages[0].thoughtSignature = signature, r => r.messages[1].thoughtSignature = 3,
    r => r.toolConfig.functionCallingConfig.mode = 'AUTO', r => r.toolConfig.functionCallingConfig.allowedFunctionNames = ['unknown']];
  for (const mutate of mutations) { const r = request(); mutate(r); assert.throws(() => validateRequestProtocol(r)); }
  const r = request(); r.messages.push(structuredClone(r.messages[2])); assert.throws(() => validateRequestProtocol(r), /匹配/);
});

test('unsigned tool history uses native DSH blocks without tool execution or dynamic toolHistory', async () => {
  const r = request(); delete r.toolChoice; delete r.toolConfig;
  delete r.messages[1].thoughtSignature;
  delete r.messages[1].tool_calls[0].signature; delete r.messages[1].tool_calls[0].extra_content;
  const sent = [];
  const run = createDshGeneration({ llm: { async prepareCall(config, signal, configure) {
    const { provider, model, ...controls } = config;
    return { config: { provider, model, ...configure(controls, { context: { contextWindow: 10000 } }) }, async *stream(options) {
      sent.push(options); yield { type: 'text-delta', text: '正文' }; yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } } });
  assert.equal((await run({ request: r })).text, '正文');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].messages[1].content, [{ type: 'tool-call', id: 'call_one', name: 'story', arguments: '{"body":"旧正文"}' }]);
  assert.equal(sent[0].messages[1].source.provider, 'configured');
  assert.deepEqual(sent[0].messages[2].source, { kind: 'tool', callId: 'call_one' });
  assert.equal(sent[0].messages[2].toolCallId, 'call_one');
  assert.equal(sent[0].toolHistory, undefined);
});

test('OpenAI dispatch preserves exact history/signatures and converts forced choice without fallback', async () => {
  const h = harness(), r = request();
  r.stop = ['Participant:'];
  const result = await h.run({ request: r });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].json.messages, r.messages);
  assert.deepEqual(h.sent[0].json.stop, r.stop);
  assert.deepEqual(h.sent[0].json.tool_choice, { type: 'function', function: { name: 'story' } });
  assert.equal(h.sent[0].json.toolConfig, undefined);
  assert.equal(h.sent[0].json.max_tokens, 256);
  assert.equal(h.sent[0].headers.get('authorization'), 'Bearer synthetic-test-key');
  assert.match(h.sent[0].headers.get('user-agent'), /^dsh-tavern-STcontext\//);
  assert.equal(h.sent[0].redirect, 'error');
  assert.equal(result.toolCalls[0].arguments, '{"body":"新正文"}');
  assert.ok(!JSON.stringify(result).includes('synthetic-test-key'));
  assert.deepEqual(h.counts(), { nativeCalls: 0, credentialReads: 1 });
});

test('Gemini dispatch maps historical tool calls/results and signature to native parts', async () => {
  const h = harness({ api: 'google-generative-ai' }), r = request();
  r.stop = ['Participant:'];
  r.messages[0] = { role: 'assistant', content: '', thoughtSignature: signature };
  const result = await h.run({ request: r });
  const body = h.sent[0].json, parts = body.contents.flatMap(c => c.parts);
  assert.equal(h.sent[0].url, 'https://provider.invalid/v1/models/story-model:generateContent');
  assert.deepEqual(parts.find(p => p.functionCall), { functionCall: { id: 'call_one', name: 'story', args: { body: '旧正文' } }, thoughtSignature: signature });
  assert.deepEqual(parts.find(p => p.functionResponse).functionResponse, { id: 'call_one', name: 'story', response: { ok: true } });
  assert.deepEqual(parts[0], { text: '', thoughtSignature: signature });
  assert.deepEqual(body.toolConfig, r.toolConfig);
  assert.deepEqual(body.generationConfig.stopSequences, r.stop);
  assert.equal(h.sent[0].headers.get('x-goog-api-key'), 'synthetic-test-key');
  assert.equal(body.generationConfig.maxOutputTokens, 256);
  assert.deepEqual(result.toolCalls[0].arguments, { body: '新正文' });
});

test('Gemini converts only a recognized Reverie plain system/user/system prompt in place', () => {
  const input = { messages: [{ role: 'system', content: '开头' }, { role: 'user', content: '玩家' }, { role: 'system', content: '尾部' }],
    stop: ['Participant:'] };
  const controls = { model: 'gemini', maxTokens: 512 };
  const route = { api: 'google-generative-ai', reverieSystemPrompt: true };
  const body = buildProtocolBody(route, input, controls);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: '开头' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '玩家\n\n尾部' }] }]);
  assert.deepEqual(body.generationConfig.stopSequences, input.stop);
  assert.ok(!Object.hasOwn(body, 'reverieSystemPrompt'));
  assert.deepEqual(buildProtocolBody({ ...route, api: 'openai-completions' }, input, controls).messages, input.messages);
  assert.throws(() => buildProtocolBody({ api: route.api }, input, controls), /中途的 system/);
  assert.throws(() => buildProtocolBody(route, { ...input, tools: [tool] }, controls), /中途的 system/);
  assert.throws(() => buildProtocolBody(route, { ...input, messages: [...input.messages, input.messages[1]] }, controls), /中途的 system/);
  assert.throws(() => validateRequestProtocol({ ...input, reverieSystemPrompt: true }), /不支持请求字段/);
});

test('original Reverie maps its three default messages through the configured Gemini transport', {
  skip: !process.env.STCONTEXT_REVERIE_FIXTURE,
}, async () => {
  const document = JSON.parse(await readFile(process.env.STCONTEXT_REVERIE_FIXTURE, 'utf8'));
  const compile = doc => compilePreset(doc, compilerMaterials(materials), { model: request().model });
  const compiled = compile(document), messages = structuredClone(compiled.request.messages);
  assert.equal(compiled.reverieSystemPrompt, true);
  assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'system']);
  assert.ok(!Object.hasOwn(compiled.request, 'reverieSystemPrompt'));
  const h = harness({ api: 'google-generative-ai', reply: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '模拟正文' }] } }] } });
  assert.equal((await h.run(compiled)).text, '模拟正文');
  assert.deepEqual(h.sent[0].json.systemInstruction.parts, [{ text: messages[0].content }]);
  assert.deepEqual(h.sent[0].json.contents, [{ role: 'user', parts: [{ text: messages[1].content + '\n\n' + messages[2].content }] }]);
  assert.deepEqual(h.sent[0].json.generationConfig.stopSequences, ['Participant:']);
  const chat = harness({ reply: openai({ finish_reason: 'stop', message: { role: 'assistant', content: '模拟正文' } }) });
  assert.equal((await chat.run(compiled)).text, '模拟正文');
  assert.deepEqual(chat.sent[0].json.messages, messages);
  assert.deepEqual(chat.sent[0].json.stop, ['Participant:']);
  assert.deepEqual(compiled.request.messages, messages);
  assert.equal(compile({ ...document, use_sysprompt: false }).reverieSystemPrompt, undefined);
  assert.equal(compile({ ...basePreset, use_sysprompt: true }).reverieSystemPrompt, undefined);
});

test('a helper stop sequence survives compilation, response replay and a text-only provider request', async () => {
  const document = structuredClone(basePreset);
  document.extensions.tavern_helper = { scripts: [{ enabled: true, name: 'stop', content:
    "eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, data => { data.stop = ['Participant:', '', 'Participant:', '\\n']; });" }] };
  const compiled = compilePreset(document, compilerMaterials(materials), { model: request().model });
  assert.deepEqual(compiled.request.stop, ['Participant:', '\n']);
  const output = processOutput({ document, helperState: compiled.helperState, response: { text: '正文' } });
  assert.equal(output.sourceText, '正文');
  const plan = compiled.request;
  for (const api of ['openai-completions', 'google-generative-ai']) {
    const reply = api === 'openai-completions' ? openai({ finish_reason: 'stop', message: { role: 'assistant', content: '正文' } })
      : { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '正文' }] } }] };
    const h = harness({ api, reply });
    assert.equal((await h.run({ request: plan })).text, '正文');
    const body = h.sent[0].json;
    assert.deepEqual(api === 'openai-completions' ? body.stop : body.generationConfig.stopSequences, plan.stop);
    assert.equal(body.tools, undefined);
    assert.equal(h.counts().nativeCalls, 0);
  }
  const unsupported = harness({ api: 'openai-responses' });
  await assert.rejects(unsupported.run({ request: plan }), /停止串/);
  assert.equal(unsupported.sent.length, 0);
  assert.equal(unsupported.counts().credentialReads, 0);
});

test('empty stop controls preserve ordinary routes and native DeepSeek receives the exact nonempty controls', async () => {
  const sent = [];
  const run = createDshGeneration({ llm: { async prepareCall(config, signal, configure) {
    const { provider, model, ...controls } = config;
    return { config: { provider, model, ...configure(controls, { context: { contextWindow: 16000 } }) }, async *stream(options) {
      sent.push(options);
      yield { type: 'text-delta', text: '正文' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } } });
  for (const [provider, stop, expected] of [
    ['configured', null, undefined], ['configured', [], undefined], ['configured', ['', ''], undefined],
    ['deepseek-account', 'Participant:', ['Participant:']], ['deepseek-official', ['\n', ' END '], ['\n', ' END ']],
  ]) {
    const plan = { messages: [{ role: 'user', content: '继续' }], model: { provider, model: 'story-model' }, stop };
    assert.equal((await run({ request: plan })).text, '正文');
    assert.deepEqual(sent.at(-1).stop, expected);
  }
  const document = structuredClone(basePreset);
  document.extensions.SPreset = { FinalRequestProcessing: { enabled: true, script: '({request}) => ({...request, stop: []})' } };
  assert.ok(!Object.hasOwn(compilePreset(document, compilerMaterials(materials)).request, 'stop'));
  document.extensions.SPreset.FinalRequestProcessing.script = '({request}) => ({...request, stop: ["ok", 3]})';
  assert.throws(() => compilePreset(document, compilerMaterials(materials)), /stop 停止串/);
});

test('standard OpenAI format and known inactive defaults do not block signed tool requests', async () => {
  const r = request(), h = harness({ profile: { compat: openaiDefaults } });
  r.model.reasoningEffort = 'high';
  await h.run({ request: r });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].json.messages, r.messages);
  assert.equal(h.sent[0].json.reasoning_effort, 'high');
  assert.deepEqual(h.sent[0].json.tool_choice, { type: 'function', function: { name: 'story' } });
  assert.equal(h.sent[0].json.compat, undefined);
  assert.equal(h.sent[0].json.thinkingFormat, undefined);
});

test('defined model overrides win while undefined defaults preserve provider compat requirements', async () => {
  const r = request(); delete r.messages[2].name;
  const h = harness({ profile: {
    compat: { ...openaiDefaults, maxTokensField: 'max_completion_tokens', requiresToolResultName: true,
      requiresAssistantAfterToolResult: true, supportsStore: true, vllmPriority: 0 },
    models: [{ id: 'story-model', compat: { maxTokensField: undefined, requiresToolResultName: undefined, requiresAssistantAfterToolResult: false } }],
  } });
  await h.run({ request: r });
  const body = h.sent[0].json;
  assert.equal(body.max_completion_tokens, r.maxTokens);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.messages.length, r.messages.length);
  assert.equal(body.messages[2].name, 'story');
  assert.equal(body.store, false);
  assert.equal(body.priority, 0);
});

test('explicit assistant gap and reasoning-content requirements preserve original history and signatures', async () => {
  const h = harness({ profile: { compat: { requiresAssistantAfterToolResult: true, requiresReasoningContentOnAssistantMessages: true } } });
  const r = request(); await h.run({ request: r });
  const messages = h.sent[0].json.messages;
  assert.equal(messages.length, r.messages.length + 1);
  assert.equal(messages[1].content, '');
  assert.deepEqual(messages[1].tool_calls, r.messages[1].tool_calls);
  assert.equal(messages[1].thoughtSignature, signature);
  assert.deepEqual(messages[2], r.messages[2]);
  assert.equal(messages[3].role, 'assistant');
  assert.deepEqual(messages[4], r.messages[3]);
  assert.ok(messages.filter(m => m.role === 'assistant').every(m => m.reasoning_content === ''));
  assert.equal(r.messages[1].content, undefined);
});

test('active unsupported compat names are reported precisely without leaking values or dispatching', async () => {
  for (const compat of [{ thinkingFormat: 'qwen' }, { supportsThinkingTokenBudget: true },
    { cacheControlFormat: 'anthropic' }, { unknownSwitch: false }, { maxTokensField: null },
    { chatTemplateKwargs: { privateValue: 'do-not-display-this-value' } }]) {
    const h = harness({ profile: { compat } });
    await assert.rejects(h.run({ request: request() }), error => error.code === 'STCONTEXT_PROTOCOL_ROUTE_UNSUPPORTED'
      && error.message.includes('compat.' + Object.keys(compat)[0]) && !error.message.includes('do-not-display-this-value'));
    assert.deepEqual(h.counts(), { nativeCalls: 0, credentialReads: 0 });
    assert.equal(h.sent.length, 0);
  }
});

test('tool controls preserve auto/none/required/named and reject contradictory or unrepresentable subsets', () => {
  const r = request(); delete r.toolConfig;
  for (const [choice, mode] of [['auto', 'AUTO'], ['none', 'NONE'], ['required', 'ANY'], [{ type: 'function', function: { name: 'story' } }, 'ANY']]) {
    r.toolChoice = choice; assert.equal(toolPolicy(r).mode, mode);
  }
  r.toolChoice = 'required';
  r.tools.push({ ...tool, name: 'other' }, { ...tool, name: 'third' });
  r.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['story', 'other'] } };
  const controls = { model: 'm', maxTokens: 100 };
  assert.throws(() => buildProtocolBody({ api: 'openai-completions' }, r, controls), /子集/);
  assert.deepEqual(buildProtocolBody({ api: 'google-generative-ai' }, r, controls).toolConfig, r.toolConfig);
  r.toolConfig.functionCallingConfig.allowedFunctionNames.push('third');
  assert.equal(buildProtocolBody({ api: 'openai-completions' }, r, controls).tool_choice, 'required');
});

test('unavailable routes, configuration races and oversized history/signatures fail before credentials or HTTP', async () => {
  for (const options of [{ api: 'openai-responses' }, { profile: { api: undefined } }, { profile: { transport: 'websocket' } },
    { profile: { compat: { thinkingFormat: 'qwen' } } }, { beforePrepare: p => p.baseURL = 'https://changed.invalid' }]) {
    const h = harness(options); await assert.rejects(h.run({ request: request() }), { code: 'STCONTEXT_PROTOCOL_ROUTE_UNSUPPORTED' });
    assert.equal(h.sent.length, 0); assert.equal(h.counts().credentialReads, 0);
  }
  const r = request(); r.messages[2].content = '大结果'.repeat(3000);
  const h = harness({ capacity: 2000 });
  await assert.rejects(h.run({ request: r }), { code: 'STCONTEXT_CONTEXT_OVERFLOW' });
  assert.equal(h.sent.length, 0);
  const s = request(); s.messages[1].thoughtSignature = 's'.repeat(60000);
  s.messages[1].tool_calls[0].signature = s.messages[1].thoughtSignature;
  s.messages[1].tool_calls[0].extra_content.google.thoughtSignature = s.messages[1].thoughtSignature;
  await assert.rejects(h.run({ request: s }), { code: 'STCONTEXT_CONTEXT_OVERFLOW' });
  assert.equal(h.counts().credentialReads, 0);
});

test('route diagnostics distinguish missing configuration from unsupported protocols without dispatching', async () => {
  for (const [profile, expected] of [
    [{ api: undefined }, /配置缺少 api；/],
    [{ baseURL: undefined }, /配置缺少 baseURL；/],
    [{ api: '', baseURL: '' }, /配置缺少 api、baseURL；/],
    [{ api: 'openai-responses' }, /API 协议（openai-responses）不支持/],
    [{ api: 'anthropic-messages', baseURL: undefined }, /API 协议（anthropic-messages）不支持/],
    [{ api: 'private-invalid-config-value', baseURL: 'https://private.invalid' }, /API 协议不支持/],
  ]) {
    const h = harness({ profile });
    await assert.rejects(h.run({ request: request() }), error => {
      assert.equal(error.code, 'STCONTEXT_PROTOCOL_ROUTE_UNSUPPORTED');
      assert.match(error.message, expected);
      assert.match(error.message, /未发送请求/);
      assert.doesNotMatch(error.message, /private-invalid-config-value|private\.invalid|synthetic-test-key/);
      return true;
    });
    assert.equal(h.sent.length, 0);
    assert.deepEqual(h.counts(), { nativeCalls: 0, credentialReads: 0 });
  }
});

test('frozen reasoning and budget controls are translated explicitly or rejected', async () => {
  const r = request(); r.model.reasoningEffort = 'high';
  const h = harness({ profile: { compat: { maxTokensField: 'max_completion_tokens' }, models: [{ id: 'story-model', reasoningEfforts: { high: 'medium' } }] } });
  await h.run({ request: r });
  assert.equal(h.sent[0].json.reasoning_effort, 'medium');
  assert.equal(h.sent[0].json.max_completion_tokens, 256);
  assert.equal(h.sent[0].json.max_tokens, undefined);
  const g = harness({ api: 'google-generative-ai' });
  await assert.rejects(g.run({ request: r }), /thinkingBudgets/);
  assert.equal(g.sent.length, 0);
});

test('malformed, truncated, refused or noncompliant provider output never becomes a body', async () => {
  for (const reply of [openai({ finish_reason: 'length' }), openai({ finish_reason: 'content_filter' }),
    openai({ message: { content: '普通文本' }, finish_reason: 'stop' }),
    openai({ message: { tool_calls: [{ type: 'function', function: { name: 'unknown', arguments: '{}' } }] } }),
    openai({ message: { tool_calls: [{ type: 'function', function: { name: 'story', arguments: '{' } }] } }),
    openai({ message: { tool_calls: [{ type: 'function', function: { name: 'story', arguments: '[]' } }] } }),
    { error: { message: 'secret-server-diagnostic' } }]) {
    const h = harness({ reply }); await assert.rejects(h.run({ request: request() })); assert.equal(h.sent.length, 1);
  }
  const r = request(); r.toolChoice = 'none'; delete r.toolConfig;
  await assert.rejects(harness().run({ request: r }), /禁用工具/);
  let attempts = 0;
  const h = harness({ fetchImpl: async () => { attempts++; return new Response('secret-server-diagnostic', { status: 400 }); } });
  await assert.rejects(h.run({ request: request() }), error => /HTTP 400/.test(error.message) && !error.message.includes('secret-server'));
  assert.equal(attempts, 1);
});

test('cancel reaches compatibility HTTP and does not retry, while oversized responses are bounded', async () => {
  const controller = new AbortController(); let attempts = 0;
  const h = harness({ fetchImpl: async (url, options) => {
    attempts++; controller.abort(new Error('用户取消'));
    options.signal.throwIfAborted();
  } });
  await assert.rejects(h.run({ request: request(), signal: controller.signal }), /用户取消/);
  assert.equal(attempts, 1);
  const large = harness({ fetchImpl: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)) });
  await assert.rejects(large.run({ request: request() }), { code: 'STCONTEXT_RESPONSE_TOO_LARGE' });
});

test('actual HTTP request carries the complete extended protocol once', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, json: JSON.parse(Buffer.concat(chunks)), headers: req.headers });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(openai()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const h = harness({ fetchImpl: globalThis.fetch, profile: { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' } });
  const plan = { ...request(), stop: ['Participant:'] };
  await h.run({ request: plan });
  assert.equal(received.length, 1); assert.equal(received[0].url, '/v1/chat/completions');
  assert.deepEqual(received[0].json.messages, plan.messages);
  assert.deepEqual(received[0].json.stop, plan.stop);
  assert.equal(received[0].headers.authorization, 'Bearer synthetic-test-key');
});

test('provider failures retain actionable categories before candidate and tool validation', async () => {
  const cases = [
    ['openai-completions', openai({ finish_reason: 'content_filter', message: { tool_calls: [null] } }), 'CONTENT_FILTERED', /内容审核/],
    ['openai-completions', openai({ finish_reason: 'length', message: {} }), 'OUTPUT_LIMIT', /长度上限/],
    ['openai-completions', openai({ finish_reason: 'stop', message: { refusal: 'private refusal text' } }), 'MODEL_REFUSAL', /明确拒绝/],
    ['openai-completions', { error: { code: 'context_length_exceeded', message: 'private prompt' } }, 'CONTEXT_OVERFLOW', /上下文容量/],
    ['openai-completions', { error: { code: 'insufficient_quota', message: 'private account' } }, 'QUOTA_EXCEEDED', /额度不足/],
    ['openai-completions', openai({ finish_reason: 'stop', message: { content: '' } }), 'EMPTY_RESPONSE', /未返回有效正文/],
    ['openai-completions', openai({ finish_reason: 'stop', message: { content: '', reasoning_content: 'private reasoning' } }), 'REASONING_ONLY', /只返回了思考/],
    ['google-generative-ai', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'CONTENT_FILTERED', /内容审核/],
    ['google-generative-ai', { candidates: [{ finishReason: 'SAFETY', content: { parts: [null] } }] }, 'CONTENT_FILTERED', /内容审核/],
    ['google-generative-ai', { candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'OUTPUT_LIMIT', /长度上限/],
    ['google-generative-ai', { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }, 'TOOL_PROTOCOL', /工具调用格式/],
    ['google-generative-ai', { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private reasoning' }] } }] }, 'REASONING_ONLY', /只返回了思考/],
    ['google-generative-ai', { error: { status: 'INVALID_ARGUMENT', message: 'The input token count exceeds the maximum number of tokens allowed' } }, 'CONTEXT_OVERFLOW', /上下文容量/],
    ['google-generative-ai', { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 'RATE_LIMITED', /请求受限/],
  ];
  for (const [api, reply, code, pattern] of cases) {
    const h = harness({ api, reply });
    await assert.rejects(h.run({ request: request() }), error => {
      assert.equal(error.code, 'STCONTEXT_' + code); assert.match(error.message, pattern);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private/);
      return true;
    });
    assert.equal(h.sent.length, 1); assert.equal(h.counts().nativeCalls, 0);
  }
});

test('HTTP failures use bounded error envelopes and preserve status when the body is unusable', async () => {
  const cases = [
    [400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'private prompt' } }), 'CONTEXT_OVERFLOW'],
    [403, JSON.stringify({ error: { code: 'content_policy_violation' } }), 'CONTENT_FILTERED'],
    [401, '<html>private credential echo</html>', 'AUTH_FAILED'],
    [429, 'private quota information', 'RATE_LIMITED'],
    [503, '', 'PROVIDER_UNAVAILABLE'],
    [400, 'private prompt'.repeat(10000), 'REQUEST_REJECTED'],
    [400, JSON.stringify({ error: { message: 'unknown failure', request: { messages: ['private prompt'] } } }), 'REQUEST_REJECTED'],
  ];
  for (const [status, body, code] of cases) {
    let attempts = 0;
    const h = harness({ fetchImpl: async () => { attempts++; return new Response(body, { status }); } });
    await assert.rejects(h.run({ request: request() }), error => {
      assert.equal(error.code, 'STCONTEXT_' + code); assert.equal(error.details.httpStatus, status);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private|unknown failure/);
      assert.match(error.message, new RegExp('HTTP ' + status)); return true;
    });
    assert.equal(attempts, 1);
  }
});

test('unknown, malformed and interrupted responses do not invent moderation or context causes', async () => {
  for (const reply of [null, [], {}, { choices: [null] }, { candidates: [null] }, { error: { message: 'unknown failure' } },
    openai({ finish_reason: 'unknown_provider_reason', message: { content: '' } })]) {
    const h = harness({ fetchImpl: async () => Response.json(reply) });
    await assert.rejects(h.run({ request: request() }), error => {
      assert.doesNotMatch(error.message, /内容审核|上下文容量|正则|强制工具/); return true;
    });
  }
  const timeout = harness({ fetchImpl: async () => { throw new DOMException('private detail', 'TimeoutError'); } });
  await assert.rejects(timeout.run({ request: request() }), { code: 'STCONTEXT_REQUEST_TIMEOUT' });
  const network = harness({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', secret: 'private' } }); } });
  await assert.rejects(network.run({ request: request() }), { code: 'STCONTEXT_NETWORK_ERROR' });
  const broken = harness({ fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('fetch failed')); } })) });
  await assert.rejects(broken.run({ request: request() }), { code: 'STCONTEXT_NETWORK_ERROR' });
});

test('original Meowssiah compiles, dispatches both protocol bodies and formats the reply without tool actions', { skip: !process.env.STCONTEXT_COMPAT_FIXTURE }, async () => {
  const document = JSON.parse(await readFile(process.env.STCONTEXT_COMPAT_FIXTURE, 'utf8'));
  for (const api of ['openai-completions', 'google-generative-ai']) {
    const compiled = compilePreset(document, compilerMaterials(materials), { model: { provider: 'configured', model: 'story-model' } });
    const args = { game_content: '完整测试正文', think_nya: '', options: '', summary: '', comment: '' };
    const reply = api === 'openai-completions' ? openai({ message: { tool_calls: [{ id: 'new', type: 'function', function: { name: 'soliumbra_reply', arguments: JSON.stringify(args) } }] } })
      : { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'soliumbra_reply', args } }] } }] };
    const h = harness({ api, reply, profile: api === 'openai-completions' ? { compat: openaiDefaults } : {} }), response = await h.run({ request: compiled.request });
    assert.equal(h.sent.length, 1);
    const body = h.sent[0].body;
    for (const row of materials.history) assert.ok(body.includes(row.text));
    assert.ok(body.includes(signature));
    const allowed = compiled.request.toolConfig?.functionCallingConfig?.allowedFunctionNames ?? compiled.request.tools.map(t => t.name);
    if (api === 'openai-completions') {
      // Some releases declare a context tool but allow only the story tool for this reply.
      const choice = allowed.length === 1 ? { type: 'function', function: { name: allowed[0] } } : 'required';
      assert.deepEqual(h.sent[0].json.tool_choice, choice);
    } else assert.deepEqual(h.sent[0].json.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: allowed });
    const output = processOutput({ document, response, helperState: compiled.helperState, toolNames: compiled.request.tools.map(t => t.name) });
    assert.ok(output.text.includes('完整测试正文'));
  }
});
