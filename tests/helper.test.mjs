import { bundledHelper } from './fixtures/bundled-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePreset, inspectPreset, processOutput } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { runCompiler } from '../lib/worker-client.mjs';
import { materials, preset } from './fixtures/materials.mjs';
import { transformHelperRequest, unavailableBackendRoutes, MAX_REPORTED_BACKEND_ROUTES } from '../lib/helper.mjs';

const settings = { model: { provider: 'fixture', model: 'story' } };
const doc = (...scripts) => ({ ...structuredClone(preset), extensions: { ...structuredClone(preset.extensions),
  tavern_helper: { scripts: scripts.map((content, i) => ({ id: 'id-' + i, name: 'arbitrary-' + i, enabled: true, content })) } } });
const compile = document => compilePreset(document, compilerMaterials(materials), settings);
const output = (document, compiled, response) => processOutput({ document, helperState: compiled.helperState,
  toolNames: (compiled.request.tools || []).map(t => t.name), response });

// A synthetic legacy browser interceptor independent of either user's preset.
const interceptor = `(() => {
  const original = window.parent.fetch;
  window.parent.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    const bytes = new Uint8Array(4); crypto.getRandomValues(bytes);
    const name = 'story_' + Array.from(bytes).join('_');
    request.tools = [{type:'function',function:{name,description:request.messages.map(m=>m.content).join('\\n'),parameters:{type:'object',properties:{body:{type:'string'}},required:['body']}}}];
    request.messages = [{role:'user',content:'reply'}];
    const response = await original(url, {...init,body:JSON.stringify(request)});
    const data = await response.clone().json();
    const message = data.choices[0].message;
    if (message.tool_calls?.length) {
      if (message.tool_calls[0].function.name !== name) throw Error('lost request state');
      message.content = JSON.parse(message.tool_calls[0].function.arguments).body;
      delete message.tool_calls;
    }
    return new Response(JSON.stringify(data), {headers:{'content-type':'application/json'}});
  };
})();`;

test('arbitrary helper fetch interceptors share one SPreset pipeline and preserve response state', () => {
  const document = doc(interceptor), compiled = compile(document);
  assert.equal(compiled.report.protocol, 'spreset');
  assert.ok(compiled.helperState);
  for (const value of materials.history.map(row => row.text)) assert.ok(compiled.request.tools[0].description.includes(value));
  assert.doesNotMatch(JSON.stringify(compiled.request), /STCONTEXT_MATERIAL_/);
  const name = compiled.request.tools[0].name;
  assert.equal(output(document, compiled, { toolCalls: [{ name, arguments: '{"body":"中文😀X"}' }] }).text, '中文😀XX');
  assert.equal(output(document, compiled, { text: '直接X' }).text, '直接XX');
  assert.throws(() => output(document, compiled, { toolCalls: [{ name, arguments: '{' }] }), /JSON/);
  assert.throws(() => output(document, compiled, { toolCalls: [{ name: 'undeclared', arguments: '{}' }] }), /未声明/);
  const changed = structuredClone(document); changed.prompts[1].content += 'changed';
  assert.throws(() => output(changed, compiled, { text: 'X' }), /冻结状态/);
  const altered = structuredClone(compiled); altered.helperState.expected += ' ';
  assert.throws(() => output(document, altered, { text: 'X' }), /重放不一致/);
  assert.throws(() => processOutput({ document, response: { text: 'X' } }), /冻结的编译状态/);
});

test('Tavern Helper events support deduplication, first/last, once, stop and async handlers', () => {
  const document = doc(`
    const e = tavern_events.CHAT_COMPLETION_SETTINGS_READY;
    const log = [];
    const first = () => log.push('A');
    eventOn(e, first); eventOn(e, first);
    eventMakeFirst(e, () => log.push('B'));
    eventOnce(e, () => log.push('C'));
    eventOn(e, () => { throw Error('stopped'); }).stop();
    eventMakeLast(e, async request => { await Promise.resolve(); request.messages.push({role:'system',content:log.join('')}); });
  `);
  assert.equal(compile(document).request.messages.at(-1).content, 'BAC');
});

test('self-contained named exports use private module bindings and run callbacks through reply replay', () => {
  const document = doc(`
    var moduleValue = 'module value';
    export const example = 'export const is ordinary text here';
    export async function start() {
      await Promise.resolve();
      eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, r => r.messages.push({role:'system',content:moduleValue}));
      eventOn(tavern_events.MESSAGE_RECEIVED, i => SillyTavern.getContext().chat[i].mes += ':' + moduleValue);
    }
    export { start as activate };
    await start();
  `, "if ('moduleValue' in globalThis) throw Error('module binding leaked');");
  const compiled = compile(document);
  assert.equal(compiled.request.messages.at(-1).content, 'module value');
  assert.equal(output(document, compiled, { text: 'reply' }).text, 'reply:module value');
  for (const source of ["export { value } from './external.mjs';",
    "import value from './external.mjs'; export { value };", "export const value = () => import('./external.mjs');"]) {
    assert.ok(inspectPreset(doc(source)).blockers.some(message => /本地命名导出|导入外部依赖/.test(message)));
  }
});

test('after-data exposes the actual player input, preserves legacy wire access, and runs before settings', () => {
  const document = doc(`
    let promptReference;
    let savedInput;
    let stage = '';
    eventOn(tavern_events.CHAT_COMPLETION_PROMPT_READY, event => {
      stage += 'P';
      event.chat = event.chat.map(message => ({...message})).reverse();
      if (JSON.stringify(event.chat).includes('is_user')) throw Error('source leaked into a prompt snapshot');
    });
    eventOn(tavern_events.GENERATE_AFTER_DATA, (data, dryRun) => {
      if (dryRun !== false || data.messages !== data.prompt) throw Error('invalid data');
      const snapshot = structuredClone(data);
      if (!Object.hasOwn(data, 'prompt') || !Object.hasOwn(data, 'messages') || snapshot.messages[0].content !== snapshot.prompt[0].content)
        throw Error('incorrect event shape');
      const copied = data.prompt.map(row => ({...row}));
      if (JSON.stringify(copied).includes('is_user')) throw Error('source leaked into a tool snapshot');
      const playerRows = copied.filter(row => row.is_user === true);
      if (playerRows.length !== 1 || playerRows[0].content !== 'player') throw Error('wrong input');
      savedInput = Object.freeze({...playerRows[0]});
      data.prompt = copied;
      data.temperature = 0.6;
      promptReference = data.messages;
      stage += 'A';
    });
    eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, wire => {
      if (wire.messages !== promptReference || wire.temperature !== 0.6 || 'prompt' in wire) throw Error('lost request state');
      wire.messages.push(savedInput);
      wire.messages.push({role:'system', content:stage + 'S'});
    });
  `);
  const wire = { messages: [
    { role: 'user', content: 'worldbook' }, { role: 'user', content: 'player' }, { role: 'user', content: 'depth injection' },
  ], model: 'story', max_tokens: 32 };
  const transformed = transformHelperRequest(document, wire, { inputMessageIndex: 1 });
  assert.equal(transformed.wire.messages.at(-1).content, 'PAS');
  assert.equal(transformed.wire.temperature, 0.6);
  assert.ok(transformed.wire.messages.every(m => !Object.hasOwn(m, 'is_user')));
  assert.ok(!Object.hasOwn(transformed.wire, 'prompt'));
  assert.equal(output(document, { request: {}, helperState: transformed.helperState }, { text: 'reply' }).text, 'reply');
});

test('in-flight v1 receipts replay their original settings and after-data order', () => {
  const document = doc(`
    eventOn('generate_after_data', r => { r.messages[0].content += '[after]'; });
    eventOn('chat_completion_settings_ready', r => { r.messages[0].content += '[settings]'; });
  `);
  const compiled = compile(document);
  assert.equal(compiled.helperState.version, 2);
  const expected = JSON.parse(compiled.helperState.expected);
  assert.ok(expected.messages[0].content.endsWith('[after][settings]'));
  expected.messages[0].content = expected.messages[0].content.replace('[after][settings]', '[settings][after]');
  const prior = { ...compiled, helperState: { ...compiled.helperState, version: 1, expected: JSON.stringify(expected) } };
  assert.equal(output(document, prior, { text: 'prior reply' }).text, 'prior reply');
});

test('after-data EJS edits respect frozen message identity and replay', () => {
  const document = doc(`eventOn(tavern_events.GENERATE_AFTER_DATA, d => {
    replaceVariables({phase:'prepared'});
    d.prompt = d.prompt.filter(row => !row.content.includes('DROP_EJS')).reverse();
  });`);
  document.prompts[1].content = '<%= getLocalVar("phase") %>';
  document.prompts[2].content = 'DROP_EJS <%= unknown() %>';
  const compiled = compile(document);
  assert.ok(compiled.request.messages.some(m => m.content === 'prepared'));
  assert.equal(output(document, compiled, { text: 'reply' }).text, 'reply');
  document.extensions.tavern_helper.scripts[0].content =
    "eventOn(tavern_events.GENERATE_AFTER_DATA,d=>{ d.prompt = d.prompt.map(m=>({...m})); });";
  assert.throws(() => compile(document), /无法确认模板来源/);
});

test('helper macro registration resolves deferred preset macros without touching frozen text', () => {
  const document = doc(`registerMacroLike(/{{custom}}/g, (context, text) => context.role + ':' + getScriptId());`);
  document.prompts[1].content = '{{custom}}';
  const compiled = compile(document);
  assert.ok(compiled.request.messages.some(m => m.content === 'system:id-0'));
  for (const row of materials.history) assert.ok(JSON.stringify(compiled.request).includes(row.text));
  document.extensions.tavern_helper.scripts[0].content = 'console.info("no macro registered")';
  assert.throws(() => compile(document), /未解析预设宏/);
  document.prompts[1].content = '{{\ncustom\n}}';
  assert.throws(() => compile(document), /未解析预设宏/);
});

test('script scoped variables, ready callbacks and global aliases are temporary and isolated', () => {
  const document = doc(`$(() => {
    if (window !== globalThis || parent !== window || window.top !== window) throw Error('aliases');
    replaceVariables({value:'one'}, {type:'script'});
    eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, request => {
      request.messages.push({role:'system',content:getScriptId() + ':' + getVariables({type:'script'}).value});
    });
  });`, `replaceVariables({value:'two'}, {type:'script'});`);
  for (let i = 0; i < 2; i++) assert.equal(compile(document).request.messages.at(-1).content, 'id-0:one');
});

test('network, DOM loaders, nested generation and host mutations are denied even if caught', () => {
  for (const source of [
    'fetch("https://example.invalid").catch(()=>{});',
    'try {document.createElement("script")} catch {}',
    'try {generate({})} catch {}', 'try {setChatMessages([])} catch {}',
    'try {setTimeout(()=>{},0)} catch {}',
    'eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, async () => {try {await fetch("/api/backends/chat-completions/generate", {method:"POST",body:"{}"})} catch {}});',
    `const original=fetch; fetch=(url,init)=>original('https://example.invalid',init);`,
    `const original=fetch; fetch=(url,init)=>original(url,{...init,headers:{Authorization:'secret'}});`,
  ]) assert.throws(() => compile(doc(source)), /受限助手环境/);
});

test('helper transformations preserve the model, output budget and local transport constraints', () => {
  for (const body of ['r.messages=[]', 'r.model="other"', 'r.max_tokens=1', 'r.tool_choice="required"', 'r.stream=true', 'r.chat_completion_source="other"']) {
    assert.throws(() => compile(doc(`eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY,r=>{${body}});`)), /完整|冻结|强制工具/);
  }
  assert.throws(() => compile(doc('while(true){}')), /超时/);
});

test('direct UI handlers are skipped while mixed generation hooks still run', () => {
  const document = doc(`document.querySelector('#options').addEventListener('click', () => generate({}));`,
    `const ctx = SillyTavern.getContext();
    eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, request => {
      if (request.type !== 'normal' || request.stream !== false || !request.chat_completion_source) throw Error('missing envelope');
      request.messages.push({role:'system',content:ctx.canPerformToolCalls() ? 'tools available' : 'plain text'});
    });`);
  const compiled = compile(document);
  assert.equal(compiled.report.scripts[0].kind, 'ui-only');
  assert.equal(compiled.request.messages.at(-1).content, 'tools available');
  assert.equal(compiled.request.chat_completion_source, undefined);
  document.function_calling = false;
  assert.equal(compile(document).request.messages.at(-1).content, 'plain text');
});

test('event-only tool declarations still need an output formatter before a model dispatch', () => {
  assert.throws(() => compile(doc(`eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY, r => {
    r.tools=[{type:'function',function:{name:'body',description:'body',parameters:{type:'object'}}}];
  });`)), /toolCallFormatter/);
});

test('helper workers remain cancellable before any model dispatch', async () => {
  const controller = new AbortController();
  const pending = runCompiler('compile', { document: doc('while(true){}'), materials: compilerMaterials(materials) }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('用户取消助手脚本')), 60);
  await assert.rejects(pending, /用户取消助手脚本/);
});

test('helper globals cannot escape WASM or pollute the next generation', () => {
  const document = doc(`
    if (({}).constructor.constructor('return typeof process')() !== 'undefined') throw Error('escape');
    if (Object.prototype.helperPolluted) throw Error('previous runtime leaked');
    Object.prototype.helperPolluted = true;
  `);
  compile(document); compile(document);
  assert.equal(Object.prototype.helperPolluted, undefined);
  assert.throws(() => compile(doc('const buffer = new ArrayBuffer(100 * 1024 * 1024);')), /memory|内存|alloc/i);
});

test('buffered helper responses preserve UTF-8 across stream chunk boundaries', () => {
  const document = doc(`
    const original=fetch;
    fetch=async (...args)=>{
      const response=await original(...args), bytes=new TextEncoder().encode(await response.text());
      return new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close()}}));
    };
  `);
  const compiled = compile(document);
  assert.equal(output(document, compiled, { text: '中文😀X' }).text, '中文😀XX');
});

test('read-only helper snapshots follow ordered preset and visible chat API shapes', () => {
  const document = doc(`
    const snapshot = getPreset('in_use');
    if (snapshot.prompts[0].id !== 'identity' || !snapshot.prompts[0].enabled || !Array.isArray(snapshot.prompts_unused)) throw Error('preset shape');
    if (snapshot.settings.max_completion_tokens !== 8192) throw Error('settings shape');
    const messages = getChatMessages('0-{{lastMessageId}}', {role:'user'});
    if (messages.length !== 2 || messages.some(m=>m.is_hidden || !m.name || !m.data || !m.extra)) throw Error('chat shape');
    if (getChatMessages(-1)[0].message !== '本轮已处理输入') throw Error('current input');
    if (getChatMessages('0-100', {hide_state:'hidden'}).length) throw Error('hidden data');
    snapshot.prompts[0].content='mutated'; messages[0].message='mutated';
  `);
  const compiled = compile(document);
  assert.ok(compiled.request.messages.some(m => m.content.includes('测试角色与测试玩家')));
  assert.ok(compiled.request.messages.some(m => m.content === '历史玩家输入'));
  for (const source of ['getPreset("other")', 'getChatMessages(0,{include_swipes:true})']) assert.throws(() => compile(doc(source)), /受限助手环境/);
});

test('original Kunlun script works under a different name and fingerprint without an adapter', { skip: !process.env.STCONTEXT_PRESET_FIXTURE }, async () => {
  const document = JSON.parse(await readFile(process.env.STCONTEXT_PRESET_FIXTURE, 'utf8'));
  for (const script of document.extensions.tavern_helper.scripts) if (script.enabled) {
    script.name = 'unrelated-name'; script.content += '\n// Different fingerprint, same script contract.\n';
  }
  const data = compilerMaterials(materials);
  data.history.push({ role: 'assistant', text: '几步以后 {{target_length}} 原地停下。' });
  data.input.projected = '  中文😀\n最后输入  ';
  const compiled = compilePreset(document, data, settings);
  assert.equal(compiled.report.protocol, 'spreset');
  assert.ok(compiled.request.tools[0].description.includes(data.history.at(-1).text));
  assert.ok(compiled.request.tools[0].description.includes(data.input.projected.trim()));
  const { name, parameters } = compiled.request.tools[0];
  assert.equal(parameters.required.length, 1);
  const args = { [parameters.required[0]]: '正文' };
  assert.equal(output(document, compiled, { toolCalls: [{ name, arguments: JSON.stringify(args) }] }).text, '正文');
});

test('original mixed helper and its panel compile tool and text deliveries independently', { skip: !process.env.STCONTEXT_WAVE_FIXTURE }, async () => {
  const document = JSON.parse(await readFile(process.env.STCONTEXT_WAVE_FIXTURE, 'utf8'));
  for (const script of document.extensions.tavern_helper.scripts) {
    script.name = 'renamed helper';
    script.content += '\n// edited export';
  }
  const compiled = compile(document);
  assert.ok(compiled.report.scripts.filter(script => script.supported === 'restricted').length >= 2);
  assert.ok(compiled.request.tools.find(tool => tool.name === 'wave_context_reference').description.includes(materials.input.text));
  const response = { toolCalls: [{ id: 'reply', name: 'actual_content', arguments: '{"content":"交付的故事"}' }] };
  assert.equal(output(document, compiled, response).text, '交付的故事');
  document.function_calling = false;
  const textMode = compile(document);
  assert.ok(textMode.request.messages.some(message => message.content?.includes('<wave_delivery>')));
  assert.equal(output(document, textMode, { text: '标记之前<wave_delivery>交付的故事</wave_delivery>标记之后' }).text, '交付的故事');
});

test('host iframe reads the original floor when a display-only panel expands it', {
  skip: !process.env.STCONTEXT_HOST_REPO || !process.env.STCONTEXT_WAVE_FIXTURE,
}, async () => {
  const hostModule = name => import(pathToFileURL(resolve(process.env.STCONTEXT_HOST_REPO, 'tavern-plugin/lib/domain', name + '.js')).href);
  const [{ projectPluginReply }, { replyProse }, { projectTavernHelperMessage }, { copyPluginRegexScripts }] = await Promise.all([
    hostModule('reply-presentation'), hostModule('reply-prose'), hostModule('tavern-helper-context'), hostModule('st-contract-service'),
  ]);
  const document = JSON.parse(await readFile(process.env.STCONTEXT_WAVE_FIXTURE, 'utf8'));
  const text = '<content>正文</content>\n<wave_options>1. 继续走。\n2. 等一等。</wave_options>';
  const rules = copyPluginRegexScripts(document.extensions.regex_scripts.filter(rule => rule.markdownOnly)
    .map(rule => ({ ...rule, promptOnly: false })));
  const projection = projectPluginReply(text, { pluginRegexScripts: rules });
  const row = replyProse(text, projection);
  const floor = projectTavernHelperMessage({ ...row, role: 'assistant', turn: 2, swipeId: 0, swipes: [row.projectionText] }, 3);
  assert.ok(projection.displayParts.some(part => part.kind === 'html'));
  assert.ok(row.displayText.includes('getCurrentMessageId'));
  assert.equal(floor.message, text);
  assert.equal(row.text, text);
});

test('Meowssiah bootstrap compiles original tool history, required choice and signatures through generic SPreset', { skip: !process.env.STCONTEXT_COMPAT_FIXTURE }, async () => {
  const document = JSON.parse(await readFile(process.env.STCONTEXT_COMPAT_FIXTURE, 'utf8'));
  const report = inspectPreset(document);
  assert.equal(report.protocol, 'spreset');
  assert.ok(report.scripts.some(s => s.builtin));
  assert.equal(report.blockers.length, 0);
  const compiled = compile(document);
  assert.equal(compiled.request.toolChoice, 'required');
  assert.equal(compiled.request.toolConfig.functionCallingConfig.mode, 'ANY');
  assert.equal(compiled.request.messages.filter(m => m.role === 'tool').length, 2);
  assert.equal(compiled.request.messages.flatMap(m => m.tool_calls || []).length, 2);
  assert.ok(compiled.request.messages.filter(m => m.tool_calls).every(m => m.tool_calls[0].signature === 'skip_thought_signature_validator'));
  assert.ok(output(document, compiled, { toolCalls: [{ name: 'soliumbra_reply', arguments: '{"game_content":"测试正文"}' }] }).text.includes('测试正文'));
});

test('bundled UI + generation hooks transform a copy of history and decode the tool reply', () => {
  const document = doc(bundledHelper);
  document.prompts.push(
    { identifier: 'tool-switch', name: '🔧结构化输出开关', role: 'system', content: '启用工具[ANTI_ROUTE_TAG]' },
  );
  document.prompt_order[0].order.push({ identifier: 'tool-switch', enabled: true });
  const report = inspectPreset(document);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.scripts[0].bundled, true);
  assert.equal(report.scripts[0].kind, 'bundled');

  const data = compilerMaterials(materials);
  data.history.push({ role: 'user', text: '包含敏感词的历史消息' });
  const compiled = compilePreset(document, data, settings);
  const wire = JSON.stringify(compiled.request.messages);
  assert.doesNotMatch(wire, /ANTI_ROUTE_TAG/);
  assert.match(wire, /<!-- anti-route -->/);
  assert.ok(wire.includes('包含ㄇㄧㄣˇ ㄍㄢˇ ㄘˊ的历史消息'));
  assert.equal(data.history.at(-1).text, '包含敏感词的历史消息');
  assert.equal(compiled.request.tools?.length, 1);
  assert.equal(compiled.request.tools[0].name, 'structured_reply');

  const restored = output(document, compiled, {
    toolCalls: [{ id: 'c1', name: 'structured_reply', arguments: JSON.stringify({ content: '回复中的ㄇㄧㄣˇ ㄍㄢˇ ㄘˊ已还原X' }) }],
  });
  assert.equal(restored.text, '回复中的敏感词已还原XX');
});

test('backend route scan reports only unsupported same-origin /api/ literals, deduplicated and sorted', () => {
  const source = [
    `const a = '/api/worldinfo/edit'; const b = "/api/chats/get"; const c = \`/api/chats/get\`;`,
    `const ok = '/api/backends/chat-completions/generate';`,
    `const nested = '/api/backends/chat-completions/generate/extra';`,
    `const dyn = \`/api/characters/\${id}\`; const trailing = '/api/settings/get/';`,
    `const prose = 'see the /api/ docs'; const bare = '/api/'; const other = '/apiary/x'; const url = 'https://example.com/api/x';`,
  ].join('\n');
  assert.deepEqual(unavailableBackendRoutes(source), [
    '/api/backends/chat-completions/generate/extra', '/api/characters', '/api/chats/get', '/api/settings/get', '/api/worldinfo/edit',
  ]);
  assert.deepEqual(unavailableBackendRoutes(''), []);
  assert.deepEqual(unavailableBackendRoutes(undefined), []);
});

test('bundled helper reports unavailable tavern backend routes in the import report without blocking', () => {
  const bundle = (extra) => [
    `(() => {`,
    `  const panel = document.createElement('div'); document.body.appendChild(panel);`,
    `  const ctx = SillyTavern.getContext();`,
    `  ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY, () => {});`,
    extra,
    `})();`,
  ].join('\n');
  const withRoutes = inspectPreset(doc(bundle(`fetch('/api/chats/get', { method: 'POST' }); fetch('/api/worldinfo/edit', { method: 'POST' });`)));
  assert.equal(withRoutes.blockers.length, 0);
  const warning = withRoutes.warnings.find(text => text.includes('酒馆后端接口'));
  assert.ok(warning, 'missing backend route warning');
  assert.match(warning, /\/api\/chats\/get/);
  assert.match(warning, /\/api\/worldinfo\/edit/);
  assert.match(warning, /静态引用扫描/);

  const generateOnly = inspectPreset(doc(bundle(`fetch('/api/backends/chat-completions/generate', { method: 'POST' });`)));
  assert.equal(generateOnly.warnings.some(text => text.includes('酒馆后端接口')), false);

  const none = inspectPreset(doc(bundle('')));
  assert.equal(none.warnings.some(text => text.includes('酒馆后端接口')), false);

  const many = Array.from({ length: MAX_REPORTED_BACKEND_ROUTES + 3 }, (_, i) => `'/api/route${String(i).padStart(2, '0')}'`).join(', ');
  const capped = inspectPreset(doc(bundle(`void [${many}];`)));
  const cappedWarning = capped.warnings.find(text => text.includes('酒馆后端接口'));
  assert.match(cappedWarning, new RegExp('等 ' + (MAX_REPORTED_BACKEND_ROUTES + 3) + ' 个'));
  assert.equal((cappedWarning.match(/\/api\/route\d\d/g) || []).length, MAX_REPORTED_BACKEND_ROUTES);
});
