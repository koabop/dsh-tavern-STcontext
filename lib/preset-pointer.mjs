import { isDeepStrictEqual } from 'node:util';
import { MAX_PRESET_BYTES, formatBytes } from './limits.mjs';

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const arrayIndex = /^(?:0|[1-9]\d*)$/;
const plain = obj => obj !== null && typeof obj === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(obj));
const dataKey = (obj, key) => {
  const field = Object.getOwnPropertyDescriptor(obj, key);
  return field?.enumerable && Object.hasOwn(field, 'value');
};
export function checkFields(obj, required, optional = []) {
  if (!plain(obj) || required.some(key => !Object.hasOwn(obj, key))
    || Reflect.ownKeys(obj).some(key => !(required.includes(key) || optional.includes(key)) || !dataKey(obj, key))) {
    throw new Error('工作台参数无效：请检查必填字段和字段名');
  }
}
function parts(pointer, allowRoot) {
  if (pointer === '') {
    if (allowRoot) return [];
    throw new Error('不能修改根节点');
  }
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 1024 || /~(?![01])/.test(pointer)) {
    throw new Error('JSON Pointer 无效或超过 1024 字符');
  }
  return pointer.slice(1).split('/').map(part => {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (forbidden.has(key)) throw new Error('JSON Pointer 包含受保护的属性');
    return key;
  });
}
function checkKey(parent, key, allowNew) {
  if (Array.isArray(parent)) {
    if (!arrayIndex.test(key) || Number(key) >= parent.length) throw new Error('JSON Pointer 数组索引无效或越界');
  } else if (!plain(parent) || JSON.isRawJSON(parent)) throw new Error('JSON Pointer 的父节点不是对象或数组');
  if (!Object.hasOwn(parent, key) && (!allowNew || key in parent)) throw new Error('JSON Pointer 属性不存在或为继承属性');
}

// Keep numeric literals JS would otherwise round or turn into null. Even an
// unrelated edit must not corrupt an extension's large integer IDs/decimals.
function decimalKey(text) {
  const [mantissa, exponent = '0'] = text.split(/[eE]/);
  const [integer, fraction = ''] = mantissa.replace(/^-/, '').split('.');
  const digits = (integer + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  let end = digits.length;
  while (digits[end - 1] === '0') end--;
  return (text.startsWith('-') ? '-' : '') + digits.slice(0, end) + 'e' + (Number(exponent) - fraction.length + digits.length - end);
}
function losesNumber(token, value) {
  if (!Number.isFinite(value) || Object.is(value, -0)) return true;
  const canonical = JSON.stringify(value);
  return token !== canonical && decimalKey(token) !== decimalKey(canonical);
}
function parseNodes(text) {
  return JSON.parse(text, (key, value, context) => typeof value === 'number' && losesNumber(context.source, value) ? JSON.rawJSON(context.source) : value);
}

// Unlike private patches, the host editor round-trips numbers through JS. Do
// not build a reviver source map/raw-number tree just to answer yes/no. Scan
// tokens linearly, skipping strings; parse once natively to validate syntax.
export function sharedEditRisk(text) {
  const invalid = '共享预设 JSON 无法验证，不建议用宿主工具写入。';
  if (typeof text !== 'string') return invalid;
  if (text.length > MAX_PRESET_BYTES || Buffer.byteLength(text) > MAX_PRESET_BYTES) return '共享预设超过 10 MiB 验证上限，不建议用宿主工具写入。';
  try {
    const tokens = /["\[\]{}]|-?\d[\d.eE+-]*/g;
    let match, depth = 0, count = 0;
    while ((match = tokens.exec(text))) {
      if (++count > 1_000_000 || depth > 512) return '共享预设结构过于复杂，无法验证宿主写入是否无损。';
      const token = match[0];
      if (token === '"') {
        let end = tokens.lastIndex;
        do {
          end = text.indexOf('"', end);
          if (end < 0) return invalid;
          let start = end;
          while (text[start - 1] === '\\') start--;
          const escaped = (end - start) % 2 !== 0;
          end++;
          if (!escaped) break;
        } while (end < text.length);
        tokens.lastIndex = end;
      } else if (token === '[' || token === '{') depth++;
      else if (token === ']' || token === '}') depth--;
      else if (token.length > 1 && losesNumber(token, Number(token))) return '宿主 JSON 编辑器无法无损保留此预设的数值精度或符号，不建议写入。';
    }
    JSON.parse(text);
    return null;
  } catch { return invalid; }
}
export function readNode(source, pointer, offset = 0, limit = 2000) {
  const keys = parts(pointer, true);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) {
    throw new Error('分片位置或长度无效：offset 从 0 起，limit 须为 1..8000');
  }
  const node = keys.reduce((parent, key) => { checkKey(parent, key, false); return parent[key]; }, parseNodes(source));
  const text = JSON.stringify(node);
  if (offset > text.length) throw new Error('分片位置超过节点长度');
  const type = node === null ? 'null' : Array.isArray(node) ? 'array' : JSON.isRawJSON(node) ? 'number' : typeof node;
  return { pointer, type, offset, total: text.length, text: text.slice(offset, offset + limit) };
}

function denseArray(value) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).length === value.length + 1;
}
// The store can also be called directly. Reject values JSON.stringify would
// silently omit/coerce, and snapshot the request before awaiting the write queue.
export function prepareOperations(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 16 || !denseArray(operations)) {
    throw new Error('每批需要 1..16 项修改');
  }
  let budget = MAX_PRESET_BYTES;
  const seen = new Set();
  function spend(bytes) {
    budget -= bytes;
    if (budget < 0) throw new Error('修改内容不能超过 ' + formatBytes(MAX_PRESET_BYTES));
  }
  function copy(value, depth = 0) {
    if (value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value)) {
      spend(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if ((!plain(value) && !denseArray(value)) || seen.has(value) || depth >= 128) throw new Error('修改值必须是有限深度的 JSON 数据');
    seen.add(value); spend(2);
    const array = Array.isArray(value), result = array ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || !dataKey(value, key) || forbidden.has(key) || (array && !arrayIndex.test(key))) {
        throw new Error('修改值含非 JSON 或受保护的属性');
      }
      spend(array ? 1 : Buffer.byteLength(key) + 3);
      result[key] = copy(value[key], depth + 1);
    }
    seen.delete(value);
    return result;
  }
  return Array.from({ length: operations.length }, (_, i) => {
    if (!dataKey(operations, i)) throw new Error('修改项无效');
    const item = operations[i];
    checkFields(item, ['op', 'path'], ['value']);
    if (!['set', 'delete'].includes(item.op) || Object.hasOwn(item, 'value') !== (item.op === 'set')) throw new Error('修改项只能是带 value 的 set 或不带 value 的 delete');
    return { op: item.op, keys: parts(item.path, false), value: item.op === 'set' ? copy(item.value) : undefined };
  });
}
export function patchNodes(source, operations) {
  const original = parseNodes(source);
  // Copy only the edited path. Untouched subtrees are shared, so semantic
  // no-ops (including a whole batch that cancels out) keep the original bytes.
  function update(parent, operation, depth) {
    const key = operation.keys[depth], leaf = depth + 1 === operation.keys.length;
    checkKey(parent, key, leaf && operation.op === 'set');
    const next = Array.isArray(parent) ? [...parent] : { ...parent };
    if (!leaf) next[key] = update(parent[key], operation, depth + 1);
    else if (operation.op === 'set') next[key] = operation.value;
    else if (Array.isArray(next)) next.splice(Number(key), 1);
    else delete next[key];
    return next;
  }
  const updated = operations.reduce((doc, op) => update(doc, op, 0), original);
  return isDeepStrictEqual(original, updated) ? source : JSON.stringify(updated);
}
