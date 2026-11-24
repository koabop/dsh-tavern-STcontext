import { fileURLToPath } from 'node:url';
import { inspectWorkbenchSource, projectWorkbenchReport } from './workbench-report.mjs';
import { sharedEditRisk } from './preset-pointer.mjs';

const SKILL = 'stcontext-preset';
const PATCH = 'stcontext_patch_private_preset';
const text = description => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const source = { type: 'string', enum: ['shared', 'private'], description: 'shared 酒馆预设库；private 插件导入库。' };
const id = text('清单中的精确 ID，不是显示名称。');
const pointer = text('原始 JSON Pointer，例如 /prompts/0/content。');
const offset = { type: 'integer', description: '从 0 开始的分页位置。' };
const limit = { type: 'integer', description: '本页条数，默认 20，最多 40。' };
const trigger = { type: 'string', enum: ['normal', 'regenerate'], description: '按指定生成动作检查；省略时检查所有触发项。' };
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

function selection({ hostPreset, activeId }) {
  if (hostPreset === 'current') return { source: 'shared', followGame: true };
  if (hostPreset) return { source: 'shared', id: hostPreset };
  return activeId ? { source: 'private', id: activeId } : null;
}
function checkSource(value) {
  if (!['shared', 'private'].includes(value)) throw new Error('请明确预设来源：shared 或 private');
}
function checkShared(tavern) {
  if (tavern.capabilities?.generationPresets !== 1 || typeof tavern.readGenerationPreset !== 'function' || typeof tavern.listGenerationPresets !== 'function') {
    throw new Error('此版本酒馆不支持读取共享预设；仍可检查插件私有预设');
  }
}

// Private records are shared across games. A model-supplied save flag requests
// a write; only the host approval service can authorize that exact revision/edit.
async function approvePatch(scoped, exec, { id, expectedRevision, operations }, name) {
  const changes = JSON.stringify({ name, id, revision: expectedRevision, operations });
  if (changes.length > 16000) throw new Error('改动过长，无法完整展示给用户确认；请缩小修改范围或使用预设编辑器');
  const approval = scoped.get('approval');
  if (!approval?.request) throw new Error('当前宿主没有可用的审批界面，未保存；可在 STcontext 预设编辑器手动修改');
  const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(exec.signal ? [exec.signal] : [])]);
  const result = await approval.request({ agent: exec.agent, callId: exec.callId, toolName: PATCH, signal,
    reason: '修改 STcontext 私有预设，会影响以后使用此预设的生成，不修改已有楼层。请核对目标与改动：\n' + changes });
  if (result === 'cancelled') throw new Error('审批已取消或超时，预设未保存');
  if (result === 'rejected') throw new Error('本次审批未通过，预设未保存。若没有弹窗，酒馆默认的完全权限会自动拒绝审批；可手动编辑，或由用户选择允许询问的会话权限后重试。');
  if (result !== 'allowed-once') throw new Error('审批界面不可用，预设未保存；可在 STcontext 预设编辑器手动修改');
  signal.throwIfAborted();
}

export function registerWorkbench(ctx, store) {
  let ready = false;
  // Optional services: older hosts still load the panel and body generator.
  ctx.inject?.(['tools', 'tavern', 'agentPresets'], scoped => {
    const { tavern, agentPresets } = scoped;
    if (typeof tavern.toolModes !== 'function' || typeof agentPresets.presetForSession !== 'function') return;
    const isTavern = ({ agent }) => !!agent?.session && agentPresets.presetForSession(agent.session) === 'tavern';
    function register(name, description, parameters, run) {
      tavern.toolModes({ name, modes: ['card'] });
      tavern.toolSkills?.({ name, skills: [SKILL, 'debug-card'] });
      scoped.tools.register({ name, description, parameters, output, async execute(args, exec) {
        if (!exec || !isTavern(exec)) throw new Error('请在酒馆卡片工作台使用此工具');
        exec.signal?.throwIfAborted();
        return run(args, exec);
      } }, { when: isTavern });
    }
    tavern.skillSource?.({ dir: fileURLToPath(new URL('./skills', import.meta.url)), role: 'card' });
    register('stcontext_list_presets', '列出指定来源的预设及 STcontext 当前选择，不读取提示词或切换预设。',
      obj({ source, offset, limit }, ['source']), async ({ source, offset = 0, limit = 20 }) => {
        checkSource(source);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw new Error('offset 从 0 开始，limit 为 1–40');
        const config = await store.workbenchCatalog();
        if (source === 'shared') checkShared(tavern);
        const records = source === 'shared' ? await tavern.listGenerationPresets() : config.presets;
        return { source, selection: selection(config), total: records.length, offset, nextOffset: offset + limit < records.length ? offset + limit : null,
          presets: records.slice(offset, offset + limit).map(({ id, name }) => ({ id, name })) };
      });
    register('stcontext_inspect_preset', '对当前预设源做 STcontext 静态检查；返回版本、阻断项、提示及可确认的字段指针，不运行脚本或模型。',
      obj({ source, id, gameId: text('仅 shared：用来源游玩的 sessionId 解析本局绑定，与 id 二选一。'),
        trigger, offset, limit }, ['source']),
      async ({ source, id, gameId, trigger, offset, limit }, exec) => {
        checkSource(source);
        if ((id === undefined) === (gameId === undefined) || typeof (id ?? gameId) !== 'string' || !(id ?? gameId).trim()) throw new Error('须指定一个精确 id 或来源游玩的 gameId');
        if (trigger !== undefined && !['normal', 'regenerate'].includes(trigger)) throw new Error('trigger 仅支持 normal 或 regenerate');
        if (gameId !== undefined && (source !== 'shared' || gameId === exec.agent.session.id)) throw new Error('gameId 仅用于共享库，须来自关联游玩的 sessionId，不能使用工作台会话');
        if (source === 'shared') checkShared(tavern);
        const record = source === 'shared' ? await tavern.readGenerationPreset(id !== undefined ? { id } : { gameId }) : await store.workbenchSource({ id });
        const settings = source === 'shared' ? await store.workbenchSettings() : record.settings;
        const sharedWriteWarning = source === 'shared' ? sharedEditRisk(record.text) : null;
        return { source, id: record.id, name: record.name, revision: record.revision, trigger: trigger ?? 'all',
          ...(sharedWriteWarning && { sharedWriteWarning }), report: inspectWorkbenchSource(record.text, { settings, trigger, offset, limit }) };
      });
    register('stcontext_read_private_preset', '按字段分段读取插件私有预设的原始 JSON；共享预设用 tavern_read_preset。',
      obj({ id, pointer, offset, limit: { type: 'integer', description: 'JSON 字符数，默认 2000，最大 8000。' } }, ['id', 'pointer']), args => store.workbenchRead(args));
    register(PATCH, '对插件私有预设预览最小修改并重新做静态检查。保存需要用户批准，不会切换选择；共享预设用 tavern_update_preset。',
      obj({ id, expectedRevision: text('刚读取的私有预设版本，冲突时重新读取并核对。'),
        operations: { type: 'array', description: '1–16 项，只改已确认的字段。', items: obj({ op: { type: 'string', enum: ['set', 'delete'] }, path: pointer, value: {} }, ['op', 'path']) },
        trigger, offset, limit, save: { type: 'boolean', description: '默认 false：只预览。用户要求保存时传 true 发起审批。' } }, ['id', 'expectedRevision', 'operations']),
      async (args, exec) => {
        const { offset, limit, ...input } = structuredClone(args);
        let result = await store.workbenchPatch({ ...input, save: false });
        if (input.save === true) {
          await approvePatch(scoped, exec, input, result.name);
          result = await store.workbenchPatch(input); // CAS again after the user has reviewed the edit.
        }
        return { source: 'private', id: result.id, name: result.name, revision: result.revision, saved: result.saved, trigger: input.trigger ?? 'all', report: projectWorkbenchReport(result.report, { offset, limit }) };
      });
    scoped.effect(() => { ready = true; return () => { ready = false; }; }, 'stcontext.workbench');
  });
  return () => ready;
}
