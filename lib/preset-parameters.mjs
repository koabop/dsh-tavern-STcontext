// ST values keep their JSON type. Only an explicit legacy plugin override is
// coerced to Number; ''/null/undefined mean "inherit", while 0 is an override.
export const hasParameterOverride = value => value !== '' && value != null;
export function presetParameters(doc, settings) {
  const budgetKey = doc.openai_max_tokens != null ? 'openai_max_tokens' : 'max_tokens';
  const parameter = (override, preset, fallback) => hasParameterOverride(override) ? Number(override) : preset ?? fallback;
  const temperature = parameter(settings.temperature, doc.temperature);
  const maxTokens = parameter(settings.maxTokens, doc[budgetKey], 8192);
  const contextLimit = parameter(settings.contextLimit);
  const controls = { ...(temperature !== undefined && { temperature }), maxTokens, ...(contextLimit !== undefined && { contextLimit }) };
  const diagnostics = [];
  const fail = (setting, field, message) => {
    const fromPreset = field && !hasParameterOverride(settings[setting]) && Object.hasOwn(doc, field);
    diagnostics.push({ severity: 'error', stage: 'native', path: fromPreset ? field : 'settings.' + setting, message,
      ...(fromPreset && { pointer: '/' + field }) });
  };
  const validBudget = Number.isSafeInteger(maxTokens) && maxTokens > 0;
  if (!validBudget) fail('maxTokens', budgetKey, '输出 token 上限必须是正整数');
  if (contextLimit !== undefined && (!Number.isSafeInteger(contextLimit) || (validBudget && contextLimit <= maxTokens))) {
    fail('contextLimit', null, '上下文上限必须大于输出 token 上限');
  }
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    fail('temperature', 'temperature', '温度必须在 0–2 之间');
  }
  return { controls, diagnostics };
}
