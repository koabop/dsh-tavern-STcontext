import { assertMaterialsPreserved } from './request.mjs';

// These describe how to read upstream material, not what happened this turn.
const fateGuide = '【命运之骰】有实际行动检定时，按本轮原文演绎成败、代价与后果，不重投、不改判；免骰直通不编骰点，暗骰只写角色可感知的迹象。奇遇骰指引局势，不等于行动成败；宿命序列是预掷而非既定结论，遇到真正的不确定性才按原文顺序取用，回传依原文要求。正文用事件体现后果，不播报规则；未附结果不补判。';
const damperGuide = '【叙事阻尼器】区分行动企图与既成事实。本轮若附裁定，按原文给出的推进幅度、阻力、代价及状态变化上限演绎，保留角色动机与既有设定；未附裁定不自行设限或沿用上轮结论。';
const boundary = '【以下为本轮系统裁定，非玩家台词】';

export function rulingPrompt(settings, turnRulings) {
  const guides = [], results = [];
  for (const [enabled, guide, key] of [[settings.injectFateDice, fateGuide, 'fateDice'],
    [settings.injectNarrativeDamper, damperGuide, 'narrativeDamper']]) {
    if (enabled !== true) continue;
    guides.push(guide);
    const text = turnRulings?.[key];
    if (typeof text === 'string' && text.trim()) results.push(text);
  }
  return { guide: guides.join('\n\n'), appendix: results.length ? boundary + '\n' + results.join('\n\n') : '' };
}

// A final hook can legitimately regroup messages or serialize them into a tool
// description. Accept complete literal blocks, including JSON string values;
// never accept a private metadata field on a request as proof of delivery.
export function assertRulingPromptPreserved({ guide, appendix }, request) {
  if (!guide) return;
  const required = [guide, appendix].filter(Boolean).map(content => ({ source: 'materials', content }));
  const fields = [];
  // Decode only complete JSON carriers, never a stray backslash-n in prose.
  // Count either the decoded fields or the original text, not both: duplicate
  // views of one occurrence must not satisfy two material requirements.
  function collect(text, level = 0) {
    if (typeof text !== 'string' || (!text.includes('【') && !text.includes('\\u'))) return;
    if (/^\s*[\[{"]/.test(text)) {
      if (level >= 32) return;
      let parsed;
      try { parsed = JSON.parse(text); } catch { /* plain text */ }
      if (parsed !== undefined) {
        const stack = [parsed];
        while (stack.length) {
          const value = stack.pop();
          if (typeof value === 'string') collect(value, level + 1);
          else if (value && typeof value === 'object') {
            for (const key of Object.keys(value)) if (key !== 'rawContent') stack.push(value[key]);
          }
        }
        return;
      }
    }
    if (required.some(({ content }) => text.includes(content))) fields.push({ content: text });
  }
  for (const message of request.messages) collect(message.content);
  for (const tool of request.tools || []) collect(tool.description);
  assertMaterialsPreserved(required, { messages: fields });
}
