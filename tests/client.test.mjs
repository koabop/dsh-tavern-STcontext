import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { apply } from '../index.mjs';
import { decodePreset } from '../lib/store.mjs';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const simplePreset = { prompts: [{ identifier: 'chatHistory', marker: true }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] }] };

// Drive the real client and host entry with a tiny hook scheduler; no DOM or framework dependency.
function harness({ hostReady = true, initialModel, initialSettings = {}, catalogFailure = false, resolveModelInfo, getStorageLimits } = {}) {
  const hooks = [], effects = [], pending = new Set(), timers = new Map(), calls = [], downloads = [], disposers = [];
  let cursor = 0, dirty = true, tree, component, properties, panel, action, overlay, registered, settingsSection, settingsSpec, saved, serial = 0;
  const handlers = new Map();
  saved = { schemaVersion: 1, presets: [], activeId: null, settings: { ...initialSettings, ...(initialModel === undefined ? {} : { model: initialModel }) } };
  let modelFailure = catalogFailure;
  const models = [{ id: 'story', name: 'Story', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }, { id: 'other', name: 'Other' }];
  const tavern = { readPluginData: async () => structuredClone(saved), savePluginData: async ({ data }) => { saved = structuredClone(data); },
    handle: (key, fn) => handlers.set(key, fn), onGameRemoved() {} };
  if (getStorageLimits) tavern.getPluginDataLimits = getStorageLimits;
  if (hostReady) Object.assign(tavern, { capabilities: { bodyGeneration: 1 }, bodyGenerator() {} });
  apply({ tavern, get: () => undefined, llm: {
    listProviders: () => [{ id: 'own', name: 'Own Provider' }],
    listModels: async () => { if (modelFailure) throw new Error('offline'); return models.map(({ reasoning, ...summary }) => summary); },
    resolveModelInfo: resolveModelInfo || (async (provider, model) => {
      if (provider !== 'own') throw new Error('unknown provider');
      return models.find(item => item.id === model);
    }),
  } });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false) }),
    useState(initial) {
      const i = cursor++;
      hooks[i] ||= { value: initial };
      return [hooks[i].value, value => { hooks[i].value = typeof value === 'function' ? value(hooks[i].value) : value; dirty = true; }];
    },
    useRef(initial) { const i = cursor++; hooks[i] ||= { current: initial }; return hooks[i]; },
    useEffect(effect, deps) {
      const i = cursor++, prior = hooks[i];
      if (!prior || deps.some((value, j) => !Object.is(value, prior.deps[j]))) {
        hooks[i] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = effect(); });
      }
    },
  };
  const ui = {
    callHost(name, input) {
      calls.push({ name: name.replace('dsh-tavern-stcontext/', ''), input: structuredClone(input) });
      const promise = Promise.resolve().then(() => {
        assert.ok(JSON.stringify(input ?? {}).length <= 256 * 1024, 'host argument limit');
        return handlers.get(name)(input);
      }).then(value => {
        assert.ok(JSON.stringify(value ?? null).length <= 4 * 1024 * 1024, 'host result limit');
        return value;
      });
      pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    },
    registerPanel: entry => { panel = entry; }, registerComposerAction: entry => { action = entry; }, openOverlay: entry => { overlay = entry; },
  };
  const blobs = new Map();
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { registered = value; } } },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    Blob, TextEncoder, URL: { createObjectURL: blob => { const key = 'blob:' + serial++; blobs.set(key, blob); return key; }, revokeObjectURL: key => blobs.delete(key) },
    document: { createElement: () => ({ click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }) },
  });
  registered.factory(name => { assert.equal(name, 'react'); return React; }).apply({
    tavernUi: ui,
    effect: run => { disposers.push(run()); },
    slots: {
      inject: (name, run) => { assert.equal(name, 'settings.section'); return run(); },
      register: (spec, render) => {
        assert.equal(spec.name, 'settings.section'); settingsSpec = spec; settingsSection = render;
        return () => { settingsSpec = null; settingsSection = null; };
      },
    },
  });
  function render() {
    if (!dirty || !component) return;
    dirty = false; cursor = 0; tree = component(properties);
    while (effects.length) effects.shift()();
  }
  async function flush() {
    for (let i = 0; i < 50; i++) {
      render();
      if (pending.size) await Promise.allSettled([...pending]);
      await new Promise(resolve => setImmediate(resolve));
      if (!dirty && !pending.size && !effects.length) return;
    }
    throw new Error('Client did not settle');
  }
  function nodes(node = tree) {
    return node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(child => nodes(child))] : [];
  }
  const contents = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.type === 'style' ? '' : (node?.children || []).map(contents).join('');
  return {
    calls, downloads,
    host: (name, input) => ui.callHost('dsh-tavern-stcontext/' + name, input),
    get settingsSpec() { return settingsSpec; },
    get saved() { return structuredClone(saved); }, set modelFailure(value) { modelFailure = value; },
    async mount(useAction = false) {
      let element;
      if (useAction === 'settings') element = settingsSection();
      else if (useAction) { await action.run({ gameId: 'game' }); element = overlay.render({ close() {} }); }
      else element = panel.render({ gameId: 'game' });
      component = element.type; properties = element.props; await flush();
    },
    async input(file) { const target = { files: [file], value: 'selected.json' }; nodes().find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target }); assert.equal(target.value, ''); await flush(); },
    async click(label) { const element = nodes().find(node => node.type === 'button' && contents(node) === label); assert.ok(element, label); assert.ok(!element.props.disabled, label + ' must be enabled'); await element.props.onClick(); await flush(); },
    async field(label, value) { const node = nodes().find(node => ['input', 'textarea', 'select'].includes(node.type) && node.props['aria-label'] === label); assert.ok(node, label); assert.ok(!node.props.disabled); node.props.onChange({ target: { value, checked: value } }); await flush(); },
    fieldValue: label => nodes().find(node => node.props?.['aria-label'] === label)?.props.value,
    checkbox: label => nodes().find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === label)?.props,
    async labeledClick(label) { const node = nodes().find(node => node.type === 'button' && node.props['aria-label'] === label); assert.ok(node); assert.ok(!node.props.disabled); node.props.onClick(); await flush(); },
    numberInputs: () => nodes().filter(node => node.type === 'input' && node.props.type === 'number').length,
    async choose(label, value, settle = true) { const node = nodes().find(node => node.type === 'select' && node.props['aria-label'] === label); assert.ok(node, label); assert.ok(!node.props.disabled); node.props.onChange({ target: { value } }); if (settle) await flush(); else render(); },
    flush,
    selectDisabled: label => nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)?.props.disabled,
    selectValue: label => nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)?.props.value,
    text: () => contents(tree),
    disabled: label => nodes().find(node => node.type === 'button' && contents(node) === label)?.props.disabled,
    destroy() { for (const item of hooks) item?.cleanup?.(); timers.clear(); for (const dispose of disposers) dispose?.(); },
  };
}
const file = (text, name = 'imported.json') => ({ name, size: Buffer.byteLength(text), text: async () => text });

test('helper editor follows nested folder enablement and preserves script data', async () => {
  const h = harness();
  const document = { ...simplePreset, extensions: { tavern_helper: { scripts: [null,
    { type: 'folder', name: '目录', scripts: [
      { id: 'child', name: '脚本', enabled: true, content: 'console.info("中文");', custom: 42 },
      { type: 'folder', name: '子目录', enabled: false, scripts: [{ id: 'nested', enabled: true, content: 'void 0;' }] },
    ] },
  ] } } };
  try {
    await h.mount('settings'); await h.input(file(JSON.stringify(document)));
    await h.click('编辑预设'); await h.click('助手脚本');
    assert.equal(h.checkbox('启用 目录').checked, true);
    assert.equal(h.checkbox('启用 目录 / 脚本').checked, true);
    assert.equal(h.checkbox('启用 目录 / 子目录 / nested').disabled, true);
    await h.field('启用 目录', false);
    assert.equal(h.checkbox('启用 目录 / 脚本').disabled, true);
    await h.field('启用 目录', true);
    await h.field('启用 目录 / 脚本', false);
    await h.click('保存预设');
    const saved = JSON.parse(decodePreset(h.saved.presets[0].data));
    assert.deepEqual(saved.extensions.tavern_helper.scripts[1].scripts[0], {
      ...document.extensions.tavern_helper.scripts[1].scripts[0], enabled: false,
    });
    assert.deepEqual(saved.extensions.tavern_helper.scripts[1].scripts[1], document.extensions.tavern_helper.scripts[1].scripts[1]);
  } finally { h.destroy(); }
});

test('10 MiB import and export use bounded RPC chunks; oversized imports and edited drafts stay unsaved', async () => {
  const h = harness({ getStorageLimits: () => ({ maxBytes: 256 * 1024 * 1024 }) });
  const source = JSON.stringify(simplePreset).padEnd(10 * 1024 * 1024, ' ');
  try {
    await h.mount('settings');
    assert.match(h.text(), /最大 10 MiB/); assert.match(h.text(), /256 MiB/);
    await h.input(file(source)); assert.match(h.text(), /预设已导入/);
    await h.click('导出预设');
    assert.equal(await h.downloads[0].blob.text(), source);
    assert.ok(h.calls.filter(call => call.name === 'preset/read').length > 100);
    assert.equal(h.calls.some(call => call.name === 'export'), false);
    const before = h.saved, uploads = h.calls.filter(call => call.name === 'upload/begin').length;
    await h.input({ name: 'too-large.json', size: source.length + 1, text: () => assert.fail('reject before reading') });
    assert.match(h.text(), /不能超过 10 MiB/);
    assert.equal(h.calls.filter(call => call.name === 'upload/begin').length, uploads);
    await h.click('编辑预设'); await h.click('完整 JSON');
    await h.field('预设 JSON', source + ' '); await h.click('保存预设');
    assert.match(h.text(), /不能超过 10 MiB/);
    assert.equal(h.fieldValue('预设 JSON'), source + ' ');
    assert.deepEqual(h.saved, before);
  } finally { h.destroy(); }
});

test('capacity query failures can be retried; legacy hosts display their smaller limits', async () => {
  let offline = true;
  const h = harness({ getStorageLimits: () => { if (offline) throw Error('offline'); return { maxBytes: 8 * 1024 * 1024 }; } });
  try {
    await h.mount(); assert.match(h.text(), /无法读取宿主存储额度/); assert.equal(h.disabled('导入 JSON'), true);
    offline = false; await h.click('刷新预设与容量');
    assert.match(h.text(), /最大 10 MiB/); assert.match(h.text(), /8 MiB/);
    await h.input(file(JSON.stringify(simplePreset))); assert.match(h.text(), /预设已导入/);
  } finally { h.destroy(); }
  const legacy = harness();
  try { await legacy.mount(); assert.match(legacy.text(), /最大 2 MiB/); assert.match(legacy.text(), /250 KiB/); assert.match(legacy.text(), /升级宿主/); }
  finally { legacy.destroy(); }
});

test('large compatibility reports and draft validation are read in multiple bounded chunks', async () => {
  const h = harness({ getStorageLimits: () => ({ maxBytes: 256 * 1024 * 1024 }) });
  const prompts = Array.from({ length: 500 }, (_, index) => ({ identifier: 'p' + index, role: 'system', content: '{{unsupported_macro}}' }));
  const doc = { prompts, prompt_order: [{ character_id: 100001, order: prompts.map(({ identifier }) => ({ identifier, enabled: true })) }] };
  try {
    await h.mount(); await h.input(file(JSON.stringify(doc)));
    assert.match(h.text(), /unsupported_macro/);
    assert.ok(h.calls.filter(call => call.name === 'preset/report').length > 1);
    await h.click('编辑预设'); await h.click('校验草稿');
    assert.match(h.text(), /结构有效，可保存/);
    assert.ok(h.calls.filter(call => call.name === 'preset/report' && call.input.offset >= 50000).length >= 2);
  } finally { h.destroy(); }
});

test('editor updates prompts, order and regex while retaining hidden sampling and extension data', async () => {
  const h = harness();
  const doc = { ...simplePreset, temperature: .65, top_p: .9, openai_max_tokens: 4096,
    prompts: [{ identifier: 'main', name: '主提示词', role: 'system', content: 'original', injection_trigger: ['normal'], custom: { keep: true } }, ...simplePreset.prompts],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: false }] }, { character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
    extensions: { unknown: { preserve: [1, '脚本'] }, regex_scripts: [{ scriptName: '规则', findRegex: '/X/g', replaceString: 'XX', placement: [2], minDepth: 0, custom: 'keep' }] } };
  try {
    await h.mount('settings'); await h.input(file(JSON.stringify(doc)));
    const id = h.saved.activeId;
    await h.click('编辑预设');
    await h.field('预设名称', '我的预设'); await h.field('提示词内容', '新的提示词 {{user}}');
    await h.choose('消息角色', 'user'); await h.choose('注入位置', '1');
    await h.field('注入深度', '2');
    assert.doesNotMatch(h.text(), /触发类型|全不选表示全部|扮演用户/);
    await h.labeledClick('下移 主提示词');
    await h.click('新增提示词'); await h.field('条目名称', '额外规则'); await h.field('提示词内容', 'added');
    await h.click('复制条目'); await h.click('从当前顺序移除');
    assert.equal(h.disabled('生成参数'), undefined);
    assert.equal(h.fieldValue('温度'), undefined); assert.equal(h.fieldValue('输出 token 上限'), undefined);
    await h.field('合并相邻系统消息', true);
    await h.click('正则规则'); await h.field('替换文本', 'YYY');
    await h.click('校验草稿'); assert.match(h.text(), /结构校验通过/);
    assert.equal(JSON.parse(decodePreset(h.saved.presets[0].data)).prompts[0].content, 'original');
    await h.click('保存预设'); assert.match(h.text(), /下次生成生效/);
    const result = JSON.parse(decodePreset(h.saved.presets[0].data));
    assert.equal(h.saved.activeId, id); assert.equal(h.saved.presets[0].name, '我的预设');
    assert.equal(result.prompts[0].content, '新的提示词 {{user}}'); assert.equal(result.prompts[0].role, 'user');
    assert.equal(result.prompts[0].injection_depth, 2); assert.deepEqual(result.prompts[0].injection_trigger, ['normal']);
    assert.deepEqual(result.prompts[0].custom, { keep: true });
    assert.deepEqual(result.prompt_order[0], doc.prompt_order[0]); assert.equal(result.prompt_order[1].order[0].identifier, 'chatHistory');
    assert.equal(result.prompts.length, 4); assert.equal(result.prompt_order[1].order.length, 3);
    assert.equal(result.temperature, .65); assert.equal(result.top_p, .9); assert.equal(result.openai_max_tokens, 4096);
    assert.equal(result.squash_system_messages, true);
    assert.deepEqual(result.extensions.unknown, doc.extensions.unknown);
    assert.deepEqual(result.extensions.regex_scripts[0], { ...doc.extensions.regex_scripts[0], replaceString: 'YYY' });
    await h.click('导出预设'); assert.deepEqual(JSON.parse(await h.downloads[0].blob.text()), result);
    await h.click('另存为副本'); assert.equal(h.saved.presets.length, 2); assert.notEqual(h.saved.activeId, id);
  } finally { h.destroy(); }
});

test('editor retains invalid JSON and conflicted drafts, guards discard, and rescues a copy', async () => {
  const h = harness();
  try {
    await h.mount(); await h.input(file(JSON.stringify(simplePreset))); await h.click('编辑预设');
    const original = h.saved.presets[0].data;
    await h.click('完整 JSON'); await h.field('预设 JSON', '{broken');
    await h.click('提示词'); assert.match(h.text(), /无法切换/); assert.equal(h.fieldValue('预设 JSON'), '{broken');
    await h.click('保存预设'); assert.match(h.text(), /JSON 无效/); assert.equal(h.saved.presets[0].data, original);
    await h.click('关闭编辑器'); assert.match(h.text(), /继续会放弃/); await h.click('继续编辑');
    await h.field('预设 JSON', JSON.stringify({ ...simplePreset, notes: '保留我的更改' }));
    // Importing identical bytes from another window changes the record revision.
    const text = JSON.stringify(simplePreset), upload = await h.host('upload/begin', { name: 'other.json', size: text.length });
    await h.host('upload/chunk', { id: upload.id, index: 0, text }); await h.host('upload/finish', upload);
    await h.click('保存预设'); assert.match(h.text(), /其他窗口修改/);
    assert.match(h.fieldValue('预设 JSON'), /保留我的更改/);
    await h.click('另存为副本'); assert.equal(h.saved.presets.length, 2);
    assert.equal(JSON.parse(decodePreset(h.saved.presets.find(item => item.id === h.saved.activeId).data)).notes, '保留我的更改');
    await h.field('预设 JSON', '{discard'); await h.click('关闭编辑器'); await h.click('放弃更改并继续');
    assert.equal(h.fieldValue('预设 JSON'), undefined);
    await h.click('编辑预设'); await h.click('完整 JSON'); assert.doesNotMatch(h.fieldValue('预设 JSON'), /discard/);
  } finally { h.destroy(); }
});

test('presets outside the form shape remain repairable as JSON without losing source data', async () => {
  const h = harness();
  try {
    await h.mount(); await h.input(file(JSON.stringify({ ...simplePreset, extensions: null })));
    await h.click('编辑预设'); assert.match(h.fieldValue('预设 JSON'), /"extensions":null/);
    await h.field('预设名称', 'renamed.json'); await h.click('保存预设');
    assert.match(h.text(), /下次生成生效/); assert.equal(h.saved.presets[0].name, 'renamed.json');
    await h.field('预设 JSON', JSON.stringify(simplePreset)); await h.click('提示词');
    assert.match(h.text(), /材料占位项/); await h.click('保存预设');
    assert.equal(JSON.parse(decodePreset(h.saved.presets[0].data)).extensions, undefined);
  } finally { h.destroy(); }
});

test('panel automatically recognizes SPreset and removes legacy mode controls and settings', async () => {
  const h = harness({ initialModel: { provider: 'own', model: 'story' }, initialSettings: { adapter: 'st' } });
  try {
    await h.mount('settings');
    const document = { ...simplePreset, extensions: { SPreset: { FinalRequestProcessing: { enabled: true, script: '({request}) => request' } },
      tavern_helper: { scripts: [{ enabled: true, name: 'loader', content: 'throw Error("never execute")' }] } } };
    await h.input(file(JSON.stringify(document)));
    assert.equal(h.selectValue('请求模式'), undefined);
    assert.doesNotMatch(h.text(), /预设适配|请求模式|标准 ST（|受限 SPreset（/);
    assert.match(h.text(), /受限助手环境/);
    await h.click('保存设置');
    assert.equal(Object.hasOwn(h.saved.settings, 'adapter'), false);
    assert.equal(Object.hasOwn(h.calls.filter(call => call.name === 'settings').at(-1).input, 'adapter'), false);
    assert.match(h.text(), /FinalRequestProcessing.script/);
    assert.match(h.text(), /静态检查/);
  } finally { h.destroy(); }
});

test('native settings configures presets and models without a game and unregisters on unload', async () => {
  const h = harness();
  try {
    assert.equal(h.settingsSpec.id, 'dsh-tavern-stcontext');
    assert.equal(h.settingsSpec.label(), 'STcontext');
    await h.mount('settings');
    await h.input(file(JSON.stringify(simplePreset)));
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }));
    await h.choose('推理等级', 'high');
    await h.click('保存设置');
    assert.equal(h.saved.presets.length, 1);
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'story', reasoningEffort: 'high' });
    assert.match(h.text(), /设置已保存/);
    assert.match(h.text(), /打开游戏后/);
    assert.equal(h.disabled('重新生成最新正文'), undefined);
    assert.equal(h.disabled('查看本次请求'), undefined);
    assert.equal(h.calls.some(call => ['status', 'start', 'cancel', 'request'].includes(call.name)), false);
  } finally { h.destroy(); }
  assert.equal(h.settingsSpec, null);
});

test('client imports, exports, saves controls and directs generation to upstream host', async () => {
  const h = harness();
  try {
    await h.mount(true);
    assert.equal(h.disabled('重新生成最新正文'), undefined);
    const source = JSON.stringify(simplePreset) + ' '.repeat(110000);
    await h.input(file(source));
    assert.equal(h.calls.filter(call => call.name === 'upload/chunk').length, 3);
    assert.match(h.text(), /预设已导入/);
    assert.equal(h.disabled('重新生成最新正文'), undefined);
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }));
    await h.choose('推理等级', 'high');
    assert.equal(h.disabled('重新生成最新正文'), undefined);
    await h.click('导出预设');
    assert.equal(await h.downloads[0].blob.text(), source);
    assert.equal(h.numberInputs(), 0);
    assert.doesNotMatch(h.text(), /输出\s*token\s*上限|上下文预算|温度/);
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'story', reasoningEffort: 'high' });
    assert.match(h.text(), /插件直接生成/);
    assert.match(h.text(), /前台检索后由插件生成/);
    assert.match(h.text(), /使用宿主的发送、重生成、失败重试和停止按钮/);
    assert.equal(h.disabled('取消生成'), undefined);
    assert.equal(h.calls.some(call => ['start', 'status', 'cancel'].includes(call.name)), false);
    await h.click('移除');
    assert.equal(h.disabled('重新生成最新正文'), undefined);
  } finally { h.destroy(); }
});

test('request preview reports an absent request without polling fork task APIs', async () => {
  const h = harness({ initialModel: { provider: 'own', model: 'story' } });
  try {
    await h.mount(); await h.input(file(JSON.stringify(simplePreset)));
    await h.click('查看本次请求'); assert.match(h.text(), /还没有已编译请求/);
    assert.equal(h.calls.some(call => ['start', 'status', 'cancel'].includes(call.name)), false);
  } finally { h.destroy(); }
});

test('client reports invalid imports and keeps unsupported hosts unable to generate', async () => {
  const h = harness({ hostReady: false });
  try {
    await h.mount(); assert.match(h.text(), /宿主尚未提供插件正文生成接口/);
    await h.input(file('{ broken')); assert.match(h.text(), /JSON/);
    await h.input(file(JSON.stringify(simplePreset))); assert.match(h.text(), /预设已导入/);
    assert.equal(h.disabled('重新生成最新正文'), undefined);
    assert.equal(h.calls.some(call => call.name === 'status'), false);
  } finally { h.destroy(); }
});

test('legacy selection requires a new choice; catalog failure can be refreshed without losing settings', async () => {
  const h = harness({ initialModel: 'background', catalogFailure: true });
  try {
    await h.mount(); await h.input(file(JSON.stringify(simplePreset)));
    assert.match(h.text(), /旧版前台\/后台跟随设置需重新选择/);
    assert.match(h.text(), /模型列表读取失败/);
    assert.equal(h.selectValue('插件正文模型'), '');
    assert.equal(h.disabled('重新生成最新正文'), undefined);
    h.modelFailure = false;
    await h.click('刷新模型列表');
    assert.doesNotMatch(h.text(), /模型列表读取失败/);
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }));
    await h.choose('推理等级', 'high');
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'other' }));
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'other' });
    assert.equal(h.saved.settings.adapter, undefined);
  } finally { h.destroy(); }
});

test('saved unavailable models stay visible instead of silently selecting another route', async () => {
  const model = { provider: 'removed-provider', model: 'saved-story' };
  const h = harness({ initialModel: model });
  try {
    await h.mount();
    assert.equal(h.selectValue('插件正文模型'), JSON.stringify(model));
    assert.match(h.text(), /saved-story（未在列表中找到）/);
    await h.click('刷新模型列表'); await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, model);
  } finally { h.destroy(); }
});

test('preset import keeps unsaved model and persona edits and saving preserves hidden sampling settings', async () => {
  const sampling = { maxTokens: 2048, contextLimit: 32768, temperature: .7 };
  const personaDescription = '姓名：林舟\n身份：旅行者';
  const h = harness({ initialSettings: sampling });
  try {
    await h.mount();
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }));
    await h.choose('推理等级', 'high');
    await h.field('玩家设定', personaDescription);
    await h.input(file(JSON.stringify(simplePreset)));
    assert.match(h.text(), /有未保存的更改/);
    assert.equal(h.selectValue('推理等级'), 'high');
    assert.equal(h.fieldValue('玩家设定'), personaDescription);
    assert.equal(h.selectValue('请求模式'), undefined);
    assert.equal(h.numberInputs(), 0);
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings, { ...sampling, personaDescription, model: { provider: 'own', model: 'story', reasoningEffort: 'high' } });
    const patch = h.calls.filter(call => call.name === 'settings').at(-1).input;
    for (const key of Object.keys(sampling)) assert.equal(Object.hasOwn(patch, key), false);
    assert.doesNotMatch(h.text(), /有未保存的更改/);
  } finally { h.destroy(); }
});

for (const surface of [false, true, 'settings']) {
  test(`player persona can be loaded, saved and cleared in the ${surface || 'sidebar'} panel`, async () => {
    const h = harness({ initialSettings: { personaDescription: '已保存的玩家设定' } });
    try {
      await h.mount(surface);
      assert.equal(h.fieldValue('玩家设定'), '已保存的玩家设定');
      assert.doesNotMatch(h.text(), /有未保存的更改/);
      const personaDescription = '  姓名：林舟\n身份：旅行者\n';
      await h.field('玩家设定', personaDescription);
      assert.match(h.text(), /有未保存的更改/);
      await h.click('保存设置');
      assert.equal(h.saved.settings.personaDescription, personaDescription);
      assert.equal(h.fieldValue('玩家设定'), personaDescription);
      assert.doesNotMatch(h.text(), /有未保存的更改/);
      await h.field('玩家设定', '');
      await h.click('保存设置');
      assert.equal(h.saved.settings.personaDescription, undefined);
      assert.equal(h.fieldValue('玩家设定'), '');
      assert.doesNotMatch(h.text(), /有未保存的更改/);
    } finally { h.destroy(); }
  });
}

test('reasoning selector stays visible and disabled for models without levels', async () => {
  const h = harness();
  try {
    await h.mount();
    assert.equal(h.selectValue('推理等级'), '');
    assert.equal(h.selectDisabled('推理等级'), true);
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }));
    assert.equal(h.selectDisabled('推理等级'), false);
    await h.choose('推理等级', 'high');
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'other' }));
    assert.equal(h.selectValue('推理等级'), '');
    assert.equal(h.selectDisabled('推理等级'), true);
    assert.match(h.text(), /该模型未提供可选推理等级，使用模型默认/);
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'other' });
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }));
    assert.equal(h.selectDisabled('推理等级'), false);
    await h.choose('推理等级', 'high');
    await h.choose('推理等级', '');
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'story' });
  } finally { h.destroy(); }
});

test('confirmed models without levels clear an obsolete saved override', async () => {
  const h = harness({ initialModel: { provider: 'own', model: 'other', reasoningEffort: 'high' } });
  try {
    await h.mount();
    assert.equal(h.selectValue('推理等级'), '');
    assert.equal(h.selectDisabled('推理等级'), true);
    assert.match(h.text(), /有未保存的更改/);
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'other' });
  } finally { h.destroy(); }
});

test('capability failure keeps saved effort, reports an error and can be retried', async () => {
  let failure = true;
  const model = { provider: 'own', model: 'story', reasoningEffort: 'high' };
  const h = harness({ initialModel: model, resolveModelInfo: async () => {
    if (failure) throw new Error('Authorization: secret');
    return { id: 'story', reasoning: { efforts: [{ id: 'high' }] } };
  } });
  try {
    await h.mount();
    assert.equal(h.selectDisabled('推理等级'), true);
    assert.equal(h.selectValue('推理等级'), 'high');
    assert.match(h.text(), /推理等级读取失败/);
    assert.doesNotMatch(h.text(), /该模型未提供|secret/);
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, model);
    failure = false;
    await h.click('刷新模型列表');
    assert.equal(h.selectDisabled('推理等级'), false);
    assert.equal(h.selectValue('推理等级'), 'high');
    assert.doesNotMatch(h.text(), /推理等级读取失败/);
  } finally { h.destroy(); }
});

test('late capability responses cannot enable reasoning for a subsequently selected model', async () => {
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  const h = harness({ resolveModelInfo: async (_provider, model) => model === 'story' ? delayed : { id: model } });
  try {
    await h.mount();
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'story' }), false);
    assert.equal(h.selectDisabled('推理等级'), true);
    assert.equal(h.disabled('保存设置'), true);
    await h.choose('插件正文模型', JSON.stringify({ provider: 'own', model: 'other' }), false);
    finish({ id: 'story', reasoning: { efforts: [{ id: 'high' }] } });
    await h.flush();
    assert.equal(h.selectValue('推理等级'), '');
    assert.equal(h.selectDisabled('推理等级'), true);
    assert.match(h.text(), /该模型未提供可选推理等级/);
    await h.click('保存设置');
    assert.deepEqual(h.saved.settings.model, { provider: 'own', model: 'other' });
  } finally { finish({ id: 'story' }); h.destroy(); }
});
