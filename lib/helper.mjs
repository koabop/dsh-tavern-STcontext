import { createHash, randomBytes } from 'node:crypto';
import { parse } from './vendor/parser.mjs';
import { MAX_SCRIPT_BYTES } from './script-syntax.mjs';
import { executeScript } from './sandbox.mjs';
import { helperGuest } from './helper-guest.mjs';
import { installHelperBrowser } from './helper-browser.mjs';
import { createHelperTools } from './helper-tools.mjs';

// Compose only our own source. Every dependency is instantiated inside QuickJS.
const guestSource = 'input => (' + helperGuest + ')(input, ' + installHelperBrowser + ', ' + createHelperTools + ')';

const hash = value => createHash('sha256').update(value).digest('hex');
export const MAX_BUNDLED_HELPER_BYTES = 4 * 1024 * 1024;
const BUNDLED_HOOK_RE = /\b(?:CHAT_COMPLETION_PROMPT_READY|CHAT_COMPLETION_SETTINGS_READY|MESSAGE_RECEIVED|chat_completion_prompt_ready|chat_completion_settings_ready|message_received|registerFunctionTool|ToolManager)\b/;
const BUNDLED_UI_RE = /\b(?:createElement|querySelector|MutationObserver|localStorage|addEventListener)\b/;

export function isBundledHelperScript(source = '') {
  const text = String(source || '');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (!bytes || bytes > MAX_BUNDLED_HELPER_BYTES) return false;
  return BUNDLED_HOOK_RE.test(text) && (bytes > MAX_SCRIPT_BYTES || BUNDLED_UI_RE.test(text));
}

// Same-origin SillyTavern admin routes a bundled script may reference as string
// literals. Only the virtual generation endpoint exists here; at run time every
// other /api/ route fails with a catchable error (see helperGuest's baseFetch),
// so this static scan reports the same boundary. It is a reference scan, not a
// proof the route is called: a library bundled into the script may only mention it.
const SUPPORTED_BACKEND_ROUTE = '/api/backends/chat-completions/generate';
const BACKEND_ROUTE_RE = /(['"`])(\/api\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-])/g;
export const MAX_REPORTED_BACKEND_ROUTES = 12;

export function unavailableBackendRoutes(source = '') {
  const routes = new Set();
  for (const match of String(source || '').matchAll(BACKEND_ROUTE_RE)) {
    const route = match[2];
    if (route !== SUPPORTED_BACKEND_ROUTE) routes.add(route);
  }
  return [...routes].sort();
}

// Identifies the SPreset engine bootstrap, not a preset. Its configured engine
// is implemented locally; remote code is never fetched, cached or executed.
const BUILTIN_BOOTSTRAPS = new Set(['8298258224ebc3edaae17072b3bd93004f5cef05c479fa6012603dc049e3c632']);
// These audited exports only manage a panel and its settings. Some observe
// generation for token estimates or statistics, so event names alone cannot
// distinguish them from a hook that actually changes the outgoing prompt.
const PANEL_SCRIPTS = new Set([
  '15ff3d2fc2e9e16cdaf6f7abb9799c0d1ee5ffc01028306d1b51165a229343c8',
  '8ff5f42ec98da8fe9b1dab2095c8fa2cb461b28144b3f489036a89dce316dde0',
]);
const panelEvents = new Set(['click', 'dblclick', 'change', 'input', 'submit', 'pointerdown', 'pointerup']);
function onlyPanelOperations(tree) {
  // Only literal DOM construction and interaction bindings qualify. Their
  // callback bodies never run during generation. Unknown code stays executable.
  const elements = new Set();
  const method = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : undefined;
  const isElement = node => {
    if (node?.type === 'Identifier') return elements.has(node.name);
    if (method(node) === 'body' && node.object.name === 'document') return true;
    if (node?.type !== 'CallExpression' || node.arguments.length !== 1 || typeof node.arguments[0].value !== 'string') return false;
    if (node.callee.type === 'Identifier' && node.callee.name === '$') return !node.arguments[0].value.trimStart().startsWith('<');
    if (node.callee.object?.name !== 'document') return false;
    const name = method(node.callee);
    return name === 'getElementById' || name === 'querySelector' ||
      name === 'createElement' && /^(button|div|span|section|p|input|label|select|option|textarea)$/i.test(node.arguments[0].value);
  };
  return tree.body.length > 0 && tree.body.every(statement => {
    if (statement.type === 'EmptyStatement' || statement.directive) return true;
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const') return statement.declarations.every(({ id, init }) => {
      if (id.type !== 'Identifier' || !isElement(init)) return false;
      elements.add(id.name); return true;
    });
    const call = statement.expression;
    if (call?.type === 'AssignmentExpression' && call.operator === '=') return isElement(call.left.object) &&
      ['id', 'className', 'textContent', 'title', 'value'].includes(method(call.left)) && typeof call.right.value === 'string';
    if (call?.type !== 'CallExpression') return false;
    if (isElement(call)) return true;
    const name = method(call.callee), args = call.arguments;
    if (['append', 'appendChild', 'prepend'].includes(name) && isElement(call.callee.object)) {
      return args.every(arg => isElement(arg) || typeof arg.value === 'string');
    }
    if (args.length !== 2 || !['FunctionExpression', 'ArrowFunctionExpression'].includes(args[1].type)) return false;
    const event = args[0];
    if (call.callee.type === 'Identifier' && call.callee.name === 'eventOn') return event.type === 'CallExpression' &&
      event.callee.name === 'getButtonEvent' && event.arguments.length === 1 && typeof event.arguments[0].value === 'string';
    return ['addEventListener', 'on'].includes(name) && isElement(call.callee.object) && panelEvents.has(event.value);
  });
}
export function helperScripts(doc) {
  const list = doc.extensions?.tavern_helper?.scripts ?? [];
  if (!Array.isArray(list)) throw new Error('酒馆助手 scripts 必须是数组');
  const result = [];
  function visit(items) {
    for (const item of items) {
      if (item?.enabled === false) continue;
      if (item?.type === 'folder' && Array.isArray(item.scripts)) { visit(item.scripts); continue; }
      if (item?.enabled !== true) continue;
      result.push({ id: String(item.id || 'script-' + result.length), name: String(item.name || item.id || '未命名脚本'), content: String(item.content || '') });
    }
  }
  visit(list);
  if (result.length > 32) throw new Error('启用的助手脚本超过 32 个');
  return result;
}
export function inspectHelpers(doc) {
  const scripts = helperScripts(doc), diagnostics = [];
  const reports = scripts.map((script, index) => {
    const source = script.content.replace(/\r\n/g, '\n').trim(), fingerprint = hash(source);
    const builtin = BUILTIN_BOOTSTRAPS.has(fingerprint) && !!doc.extensions?.SPreset;
    const panel = PANEL_SCRIPTS.has(fingerprint);
    const bundled = !builtin && !panel && isBundledHelperScript(source);
    const add = (severity, message) => diagnostics.push({ severity, stage: 'helper', path: 'extensions.tavern_helper.scripts[' + index + '] (' + script.name + ')', message });
    const reportPanel = () => {
      add('info', '仅用于预设面板或交互设置，正文生成时忽略。');
      return { name: script.name, hash: fingerprint, supported: 'ui-only', builtin: false, kind: 'ui-only' };
    };
    if (panel) return reportPanel();
    if (builtin) add('warning', 'SPreset 引擎加载器由内置接口接管，不下载或执行远程代码。');
    else try {
      const maxBytes = bundled ? MAX_BUNDLED_HELPER_BYTES : MAX_SCRIPT_BYTES;
      if (!source || Buffer.byteLength(source) > maxBytes) throw Error('脚本必须非空且不超过 ' + (bundled ? '4 MiB' : '256 KiB'));
      const tree = parse(source, { ecmaVersion: 2024, sourceType: 'script' });
      if (onlyPanelOperations(tree)) return reportPanel();
      if (bundled) {
        add('warning', '打包型助手脚本在受限沙箱环境执行：浏览器 UI 挂载与定时器以惰性内存桩运行，仅生效本次生成事件、ToolManager 输出工具与回复后处理。');
        const routes = unavailableBackendRoutes(source);
        if (routes.length) {
          const shown = routes.slice(0, MAX_REPORTED_BACKEND_ROUTES).join('、');
          const more = routes.length > MAX_REPORTED_BACKEND_ROUTES ? ' 等 ' + routes.length + ' 个' : '';
          add('warning', '脚本引用了酒馆后端接口：' + shown + more + '。这些接口在此环境不可用，调用会得到「本地管理接口未启用」错误，依赖它们的功能（如记忆/世界书编辑、聊天回读）不会生效。此为静态引用扫描，不代表一定会被调用。');
        }
      } else {
        const stack = [tree], unavailable = new Set();
        while (stack.length) {
          const node = stack.pop();
          if (node.type === 'ImportExpression') unavailable.add('import');
          if (node.type === 'Identifier' && ['XMLHttpRequest', 'WebSocket', 'process', 'require', 'generate', 'generateRaw', 'setChatMessages', 'triggerSlash', 'setTimeout', 'setInterval'].includes(node.name)) unavailable.add(node.name);
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) { for (const child of value) if (child?.type) stack.push(child); }
            else if (value?.type) stack.push(value);
          }
        }
        if (unavailable.size) add('warning', '引用未提供的能力：' + [...unavailable].join('、') + '；调用时将失败。');
        add('warning', '脚本在受限助手环境执行；只允许本次事件、临时变量和虚拟生成请求，未实现的 API 会报错。');
      }
    } catch (error) { add('error', '助手脚本语法或大小不受支持：' + error.message); }
    return { name: script.name, hash: fingerprint, supported: builtin ? 'builtin' : 'restricted', builtin,
      ...(bundled ? { bundled: true, kind: 'bundled' } : {}) };
  });
  return { diagnostics, scripts, reports, bundled: reports.some(r => r.bundled),
    executable: scripts.filter((_, i) => reports[i].supported === 'restricted') };
}

export function transformHelperRequest(document, wire, options = {}) {
  const inspected = inspectHelpers(document), scripts = inspected.executable;
  if (!scripts.length) {
    if (options.templates) {
      for (const edit of options.templates.patches(wire.messages, wire)) wire.messages[edit.index].content = edit.text;
    }
    return { wire };
  }
  const sourceMap = { openai: 'openai', openrouter: 'openrouter', google: 'makersuite', 'google-vertex': 'vertexai', anthropic: 'claude' };
  const source = Object.hasOwn(sourceMap, options.provider) ? sourceMap[options.provider] : 'custom';
  const rawPreset = inspected.bundled ? buildRawPreset(document, source) : undefined;
  const preset = helperPreset(document, wire);
  const state = { version: 1, seed: randomBytes(4).readUInt32LE() || 1, now: Date.now(), request: wire,
    bundled: inspected.bundled, bootstrapIds: [], source, functionCalling: document.function_calling !== false,
    trigger: options.trigger, userName: options.env?.userName, charName: options.env?.charName,
    variables: { chat: options.chatVariables || options.env?.local || {}, global: options.env?.global || {} },
    chat: (options.env?.chat || []).map((row, message_id) => ({ message_id, name: row.role === 'user' ? options.env.userName : options.env.charName,
      role: row.role, message: row.text, is_hidden: false, data: {}, extra: {} })),
  };
  const run = phase => executeScript(guestSource, { ...state, scripts, preset, ...(rawPreset ? { rawPreset } : {}), phase },
    { stage: 'TavernHelper', timeout: 1800 });
  if (options.templates) {
    const snapshot = run('templates');
    state.templatePass = { before: JSON.stringify(snapshot.messages), edits: options.templates.patches(wire.messages, snapshot) };
  }
  const result = run('request');
  const expected = JSON.stringify(result.request);
  const { type, chat_completion_source, stream, ...outgoing } = result.request;
  if (type !== (state.trigger || 'normal') || chat_completion_source !== source || stream !== false) {
    throw new Error('助手脚本不能更改已冻结的生成类型、连接或流式模式');
  }
  // Receipt is compiler-owned and never part of the model request or UI preview.
  return {
    wire: outgoing,
    handledTools: result.handledTools || [],
    helperState: { ...state, expected, documentHash: hash(JSON.stringify(document)) },
    notes: result.notes,
    intercepts: result.intercepts,
  };
}

function buildRawPreset(document, source) {
  return {
    prompts: document.prompts,
    prompt_order: document.prompt_order,
    preset_settings_openai: 'active-preset',
    function_calling: document.function_calling !== false,
    squash_system_messages: !!document.squash_system_messages,
    chat_completion_source: source,
  };
}

function stripLargeScripts(items) {
  if (!Array.isArray(items)) return items;
  return items.map(item => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'folder' && Array.isArray(item.scripts)) return { ...item, scripts: stripLargeScripts(item.scripts) };
    if (typeof item.content === 'string' && Buffer.byteLength(item.content, 'utf8') > MAX_SCRIPT_BYTES) return { ...item, content: '' };
    return item;
  });
}

// Tavern Helper's public getPreset contract uses ordered {id, enabled} prompts,
// not the raw ST {identifier, prompt_order} file shape. Only frozen settings
// with a known mapping are exposed; unsupported settings are not invented.
function helperPreset(document, wire) {
  const group = document.prompt_order.find(g => Number(g.character_id) === 100001) || document.prompt_order[0];
  const definitions = new Map(document.prompts.map(p => [p.identifier, p]));
  const used = new Set(group.order.map(p => p.identifier));
  const convert = (p, enabled) => ({ id: p.identifier, name: p.name || p.identifier, enabled,
    role: p.role || 'system', ...(p.marker ? {} : { content: p.content || '' }),
    position: Number(p.injection_position) === 1 ? { type: 'in_chat', depth: Number(p.injection_depth) || 0, order: Number(p.injection_order) || 0 } : { type: 'relative' },
  });
  const settings = { max_completion_tokens: wire.max_tokens, ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
    should_stream: false, reply_count: 1, squash_system_messages: !!document.squash_system_messages };
  const aliases = { max_context: 'openai_max_context', reasoning_effort: 'reasoning_effort', request_thoughts: 'show_thoughts', enable_function_calling: 'function_calling',
    frequency_penalty: 'frequency_penalty', presence_penalty: 'presence_penalty', top_p: 'top_p', top_k: 'top_k', top_a: 'top_a', min_p: 'min_p', seed: 'seed', repetition_penalty: 'repetition_penalty' };
  for (const [key, source] of Object.entries(aliases)) if (document[source] !== undefined) settings[key] = document[source];
  const extensions = structuredClone(document.extensions || {});
  if (Array.isArray(extensions.tavern_helper?.scripts)) {
    extensions.tavern_helper.scripts = stripLargeScripts(extensions.tavern_helper.scripts);
  }
  return { settings, prompts: group.order.map(item => convert(definitions.get(item.identifier), item.enabled !== false)),
    prompts_unused: document.prompts.filter(p => !used.has(p.identifier)).map(p => convert(p, false)),
    extensions };
}
export function formatHelperOutput(document, response, state) {
  const inspected = inspectHelpers(document);
  if (!state) {
    if (inspected.executable.length) throw Error('助手输出缺少冻结的编译状态');
    return response;
  }
  if (state.version !== 1 || state.documentHash !== hash(JSON.stringify(document))) throw Error('助手预设与冻结状态不一致');
  const toolCalls = (response.toolCalls || []).map(call => ({ id: call.id, type: 'function', function: {
    name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
  } }));
  const envelope = { choices: [{ index: 0, message: { role: 'assistant', content: response.text || '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] };
  const scripts = state.scripts || inspected.executable;
  const preset = state.preset || helperPreset(document, state.request || {});
  const rawPreset = state.rawPreset || (inspected.bundled ? buildRawPreset(document, state.source || 'openai') : undefined);
  const result = executeScript(guestSource, {
    ...state,
    scripts,
    preset,
    ...(rawPreset ? { rawPreset } : {}),
    phase: 'response',
    response: envelope,
  }, { stage: 'TavernHelper 输出', timeout: 1800 });
  const message = result.response?.choices?.[0]?.message;
  if (!message || (message.content != null && typeof message.content !== 'string') || (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))) throw Error('助手输出不是有效的完整消息');
  return { text: message.content || '', toolCalls: (message.tool_calls || []).map(call => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments })) };
}
