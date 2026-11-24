import { inspectMacros } from './macros.mjs';
import { regexProblem } from './regex.mjs';
import { inspectPromptTemplate } from './prompt-template.mjs';

// Display paths contain labels, dots in user-defined keys and grouped settings.
// Only producers know the actual segments. Never point at a missing field.
export function diagnosticLocation(doc, segments) {
  let pointer = '', value = doc;
  for (const key of segments || []) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key) ||
        (Array.isArray(value) && !Number.isSafeInteger(key)) || String(key).length > 320) return {};
    pointer += '/' + String(key).replaceAll('~', '~0').replaceAll('/', '~1');
    if (pointer.length > 320) return {};
    value = value[key];
  }
  return pointer ? { pointer } : {};
}

export function inspectNative(doc, group, { allowScript = false, trigger, dynamicMacros } = {}) {
  const diagnostics = [];
  const add = (severity, path, message, segments) => diagnostics.push({ severity, stage: 'native', path, message, ...diagnosticLocation(doc, segments) });
  const definitions = new Map(doc.prompts.map((entry, index) => [entry.identifier, { entry, index }]));
  for (const item of group.order) {
    if (item.enabled === false) continue;
    const { entry, index } = definitions.get(item.identifier);
    if (trigger && Array.isArray(entry.injection_trigger) && entry.injection_trigger.length && !entry.injection_trigger.includes(trigger)) continue;
    const path = 'prompts[' + index + '] (' + (entry.name || entry.identifier) + ')';
    const prompt = (severity, field, message, label = field) => add(severity, path + (label ? '.' + label : ''), message, ['prompts', index, field]);
    if (entry.role === 'model') prompt('warning', 'role', 'model 按 assistant（助手）角色发送；预设原始字段保持不变。');
    if (entry.content?.includes('<%')) {
      const error = inspectPromptTemplate(entry.content);
      if (error) prompt('error', 'content', 'EJS 模板语法或功能不受支持：' + error);
    }
    const result = inspectMacros(entry.content, { dynamicMacros });
    if (result.error) prompt('error', 'content', result.error);
    const required = allowScript ? result.unknown : result.requiredUnknown;
    if (required.length) prompt(allowScript ? 'warning' : 'error', 'content', (allowScript ? '宏交由助手/请求钩子处理；最终仍未解析将阻止发送：' : '预设含尚不支持的宏：') + required.slice(0, 8).join('、'));
    if (!allowScript && result.unknown.length > required.length) prompt('warning', 'content', '条件分支含尚不支持的宏，选中该分支时将阻止发送。');
    if (result.names.some(name => name.includes('globalvar'))) prompt('warning', 'content', '全局变量仅在本次编译内共享，不读写 ST 或宿主全局变量。', '');
    if (result.names.includes('lastmessageid')) prompt('warning', 'content', 'lastMessageId 使用导出可见消息的局部索引，不是原 ST 楼层 ID。', '');
    if (entry.injection_position !== undefined && ![0, 1].includes(Number(entry.injection_position))) prompt('error', 'injection_position', '不支持的提示词插入位置');
    if (entry.injection_depth !== undefined && (!Number.isSafeInteger(Number(entry.injection_depth)) || Number(entry.injection_depth) < 0)) prompt('error', 'injection_depth', '深度必须是非负整数');
    if (entry.injection_order !== undefined && !Number.isSafeInteger(Number(entry.injection_order))) prompt('error', 'injection_order', '注入顺序必须是安全整数');
    if (entry.injection_trigger !== undefined && (!Array.isArray(entry.injection_trigger) || entry.injection_trigger.some(v => !['normal', 'regenerate', 'continue', 'quiet', 'impersonate', 'swipe'].includes(v)))) prompt('error', 'injection_trigger', '生成触发类型无效');
    if (Array.isArray(entry.injection_trigger) && entry.injection_trigger.length && !entry.injection_trigger.some(v => ['normal', 'regenerate'].includes(v))) prompt('warning', 'injection_trigger', '宿主正文接口只触发 normal/regenerate，此条目在当前宿主不会启用。', '');
  }
  for (const key of ['assistant_prefill', 'assistant_impersonation']) if (doc[key]) add('error', key, '尚不支持此预填充设置，不能静默忽略', [key]);
  for (const key of ['new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt', 'continue_nudge_prompt', 'send_if_empty', 'wi_format', 'scenario_format', 'personality_format']) {
    if (doc[key]) add('warning', key, '使用宿主已解析材料和本轮输入，不额外应用此 ST 模板。', [key]);
  }
  if (doc.openai_max_context) add('warning', 'openai_max_context', '预设上下文容量不作为模型能力；发送前按 DSH 模型窗口校验。', ['openai_max_context']);
  if (doc.request_images || doc.enable_web_search || doc.n > 1) add('error', 'request_images/enable_web_search/n', '正文接口只支持单次文本输出，不支持图像生成、网络搜索或多个候选');
  for (const [index, rule] of (doc.extensions?.regex_scripts || []).entries()) if (rule.disabled !== true && rule.enabled !== false) {
    const path = 'extensions.regex_scripts[' + index + ']';
    const regex = (severity, field, message) => add(severity, path + '.' + field, message, ['extensions', 'regex_scripts', index, field]);
    const placement = Array.isArray(rule.placement) ? rule.placement.map(Number) : [];
    const problem = regexProblem(rule);
    if (problem) {
      const displayOnly = rule.markdownOnly === true && rule.promptOnly !== true;
      const required = !displayOnly && (problem.field === 'placement' || placement.some(value => [1, 2].includes(value)));
      regex(required ? 'error' : 'warning', problem.field, problem.message + (required ? '' : '；已跳过该规则。'));
      continue;
    }
    if (rule.runOnEdit) regex('warning', 'runOnEdit', '宿主编辑楼层时会保存新版本；插件不会在编辑回调中重新执行写入规则。');
    if (placement.some(value => ![1, 2].includes(value))) regex('warning', 'placement', '插件处理用户消息和助手消息，其他正则位置由各自宿主负责。');
  }
  for (const [key, value] of Object.entries(doc.extensions || {})) {
    if (['regex_scripts', 'tavern_helper', 'SPreset', 'extensions'].includes(key)) continue;
    if (value?.enabled === true) add('error', 'extensions.' + key, '未支持的启用扩展', ['extensions', key]);
    else add('warning', 'extensions.' + key, '扩展数据仅保留，不执行其行为', ['extensions', key]);
  }
  if (doc.extensions?.extensions) add('warning', 'extensions.extensions', '嵌套扩展元数据仅保留，不执行。', ['extensions', 'extensions']);
  return diagnostics;
}
