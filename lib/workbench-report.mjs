import { parsePreset, inspectPreset } from './preset.mjs';

// Limits are per page in UTF-16 units and, independently, serialized UTF-8.
const MAX_PAGE = 40, PAGE_BYTES = 24 * 1024, MAX_MESSAGE = 240, MAX_PATH = 160;
const clipped = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const list = value => Array.isArray(value) ? value : [];
const stages = new Set(['native', 'helper', 'spreset', 'structure']);

function displayMessage(text) {
  if (typeof text !== 'string' || !text) return '未提供诊断说明。';
  // Parsers and the legacy inspector can quote the *entire* offending macro,
  // regex, identifier, route, protocol literal or source fragment. Do not echo it.
  const head = clipped(text, MAX_MESSAGE);
  const cut = /(?:^|：)(预设含尚不支持的宏|宏交由助手\/请求钩子处理；最终仍未解析将阻止发送|宏块(?:标记不匹配|未闭合)|查找表达式无效|EJS 模板语法或功能不受支持|脚本语法不受支持|助手脚本语法或大小不受支持|脚本引用了酒馆后端接口|脚本引用请求协议字段)：/.exec(head);
  if (cut) return cut[1] + '（未显示源内容）。';
  if (/(?:^|：)Invalid (?:regular expression|flags supplied to RegExp)/i.test(head)) return '正则表达式或标志无效。';
  if (/(?:^|：)不自动跳过：/.test(head)) return '静态分析无法确认该助手仅影响面板，未自动跳过。';
  return head;
}

function issueFor(item, severity) {
  const { pointer, stage } = item;
  // Reports are inspector output. Never interpret a human path as a pointer,
  // and never truncate a pointer: the prefix might address a different field.
  const locatable = typeof pointer === 'string' && pointer.length <= 320 && pointer.startsWith('/') &&
    !/~(?![01])/.test(pointer) && !/\/(?:__proto__|constructor|prototype)(?:\/|$)/.test(pointer);
  // Unlocated legacy rows may contain user-supplied names inside display labels.
  const path = !locatable && typeof item.path === 'string' ? clipped(item.path.split(' (', 1)[0], MAX_PATH) : '';
  return { severity, stage: stages.has(stage) ? stage : 'preset', message: displayMessage(item.message), locatable,
    ...(locatable ? { pointer } : path ? { path } : {}) };
}

function failure(message, pointer) {
  return { diagnostics: [{ severity: 'error', stage: 'structure', message, pointer }] };
}

// Project an inspectPreset report (including saved legacy reports). Error rows
// first. Its `warnings` array includes info diagnostics; keep that count stable.
export function projectWorkbenchReport(report, { offset = 0, limit = 20 } = {}) {
  if (![report?.diagnostics, report?.blockers, report?.warnings].some(Array.isArray)) report = failure('兼容报告结构无效。');
  offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE) : 20;
  const issues = [];
  let issueCount = 0, blockerCount = 0, bytes = 256, full = false;
  const append = (item, severity) => {
    if (severity === 'error') blockerCount++;
    if (issueCount++ < offset || issues.length === limit || full) return;
    const issue = issueFor(item, severity);
    bytes += Buffer.byteLength(JSON.stringify(issue)) + 1;
    if (bytes > PAGE_BYTES) { full = true; return; }
    issues.push(issue);
  };
  for (const severity of ['error', 'warning']) {
    // buildReport mirrors diagnostics as `path：message` among its standalone
    // warnings. Subtract occurrences, not unique strings (distinct real rows).
    const mirrors = new Map();
    for (const d of list(report.diagnostics)) {
      if (!d || !['error', 'warning', 'info'].includes(d.severity) || (d.severity === 'error') !== (severity === 'error')) continue;
      append(d, d.severity);
      if (typeof d.path !== 'string' || typeof d.message !== 'string') continue;
      const key = d.path + '：' + d.message;
      mirrors.set(key, 1 + (mirrors.get(key) || 0));
    }
    for (const message of list(severity === 'error' ? report.blockers : report.warnings)) {
      const count = mirrors.get(message);
      if (count) mirrors.set(message, count - 1);
      else append({ message }, severity);
    }
  }
  offset = Math.min(offset, issueCount);
  const next = offset + issues.length;
  const page = { validation: 'static', blockerCount, warningCount: issueCount - blockerCount, issueCount, issues, offset, limit,
    nextOffset: next < issueCount ? next : null };
  for (const key of ['enabledPrompts', 'regexCount']) if (Number.isSafeInteger(report[key]) && report[key] >= 0) page[key] = report[key];
  return page;
}

export function inspectWorkbenchSource(text, { trigger, offset, limit, settings } = {}) {
  let report;
  try {
    const doc = parsePreset(text);
    // Do not let a malformed string become millions of extension keys.
    report = doc.extensions != null && (typeof doc.extensions !== 'object' || Array.isArray(doc.extensions))
      ? failure('extensions 必须是对象。', '/extensions') : inspectPreset(doc, { trigger,
        temperature: settings?.temperature, maxTokens: settings?.maxTokens, contextLimit: settings?.contextLimit });
  } catch (error) {
    // JSON.parse (and other parsers) can include input excerpts in the message.
    const reason = String(error.message).split('：', 1)[0];
    const known = /^(?:预设|提示词|重复的提示词标识|不支持的消息角色|顺序引用|同一提示词|extensions\.regex_scripts |酒馆助手 scripts |启用的助手脚本)/.test(reason);
    report = failure(known ? clipped(reason, MAX_MESSAGE) : '无法完成静态检查；请核对提示词、顺序和扩展配置的结构。');
  }
  return projectWorkbenchReport(report, { offset, limit });
}
