import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createPresetStore } from '../lib/store.mjs';

// Reuse the host's development dependencies; the distributed plugin stays dependency-free.
test('sidebar, overlay and native settings reach all content in short and narrow windows', {
  skip: !process.env.STCONTEXT_HOST_REPO,
}, async t => {
  const require = createRequire(resolve(process.env.STCONTEXT_HOST_REPO, 'package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.STCONTEXT_BROWSER_EXECUTABLE ? { executablePath: process.env.STCONTEXT_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  let react = 'const modules = {};\n';
  for (const [name, file] of [['react', 'react.production.js'], ['scheduler', 'scheduler.production.js'],
    ['react-dom', 'react-dom.production.js'], ['react-dom/client', 'react-dom-client.production.js']]) {
    react += `modules[${JSON.stringify(name)}] = (() => { const module = { exports: {} }, exports = module.exports, require = name => modules[name];\n`
      + await readFile(join(dirname(require.resolve(name)), 'cjs', file), 'utf8') + '\nreturn module.exports; })();\n';
  }
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  for (const surface of ['sidebar', 'overlay', 'settings']) {
    for (const viewport of [{ width: 300, height: 420 }, { width: 1000, height: 360 }]) {
      await t.test(`${surface} ${viewport.width}×${viewport.height}`, async () => {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
          let data;
          const sharedId = 'presets/shared.json';
          const store = createPresetStore({ readPluginData: async () => structuredClone(data), savePluginData: async input => { data = structuredClone(input.data); },
            capabilities: { generationPresets: 1 },
            listGenerationPresets: async () => [{ id: sharedId, name: '宿主预设' }],
            readGenerationPreset: async () => ({ name: '宿主预设', text }),
          });
          const doc = { temperature: .75, top_p: .9, prompts: [
            { identifier: 'main', name: '主提示词', role: 'system', content: '你是叙事助手。保持人物动机一致，沿用 {{user}} 的视角。', injection_trigger: ['regenerate'] },
            ...Array.from({ length: 10 }, (_, i) => ({ identifier: 'rule-' + i, name: '叙事规则 ' + (i + 1), role: 'system', content: '规则 ' + i })),
            { identifier: 'chatHistory', marker: true, name: '聊天历史' },
          ], notes: '保留扩展和未知字段', extensions: {
            regex_scripts: [{ scriptName: '清理输出', findRegex: '/X/g', replaceString: 'Y', placement: [2] }],
            tavern_helper: { scripts: [{ type: 'folder', name: '助手目录', scripts: [{ id: 'child', name: '内嵌脚本', enabled: true, content: 'void 0;' }] }] },
          } };
          doc.prompt_order = [{ character_id: 100001, order: doc.prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })) }];
          const text = JSON.stringify(doc), upload = await store.begin({ name: '测试预设.json', size: text.length });
          store.chunk({ id: upload.id, index: 0, text }); await store.finish(upload);
          await store.settings({ model: { provider: 'own', model: 'story' } });
          await page.exposeFunction('hostCall', async (name, input) => {
            const method = name.replace('dsh-tavern-stcontext/', '');
            if (method === 'config') {
              const config = await store.list();
              return { ...config, ...await store.listHostPresets(), hostReady: true };
            }
            if (method === 'preset/report') {
              const part = await store.report(input), report = JSON.parse(part.text);
              report.warnings.push(...Array.from({ length: 25 }, (_, i) => `兼容提示 ${i + 1}：这是一条用于检查完整内容可达性的说明。`));
              const text = JSON.stringify(report);
              return { ...part, text, total: text.length };
            }
            if (method === 'models') return { groups: [{ provider: 'own', providerName: 'Own', models: [{ id: 'story', name: 'Story' }] }] };
            if (method === 'model-reasoning') return { efforts: [] };
            if (method === 'request') return { createdAt: 1, report: JSON.parse((await store.report({ id: data.activeId })).text), total: 2, text: '{}' };
            const routes = { 'preset/read': 'read', 'upload/begin': 'begin', 'upload/chunk': 'chunk', 'upload/finish': 'finish', 'upload/cancel': 'cancel', settings: 'settings', export: 'export', select: 'select', remove: 'remove' };
            if (routes[method]) return store[routes[method]](input);
            throw Error('Unexpected call: ' + method);
          });
          await page.setContent(`<style>
            html,body{margin:0;height:100%;overflow:hidden;font:14px sans-serif}
            body{display:flex;flex-direction:column}header.fixture{height:56px;flex:none}
            /* Same flex/overflow contract as better-sidebar's paneContent. */
            main{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
            main.settings{display:block;overflow:auto;padding:16px}
            main.overlay{position:fixed;inset:0;overflow:auto}
          </style><header class="fixture">Harness</header><main class="${surface}"></main>`);
          await page.addScriptTag({ content: react + '\nwindow.__ModuleLoader__ = { load: value => { window.plugin = value.factory(name => modules[name]); } };' });
          await page.addScriptTag({ content: source });
          await page.evaluate(surface => {
            const { createElement: h } = modules.react;
            let panel, action, overlay, Settings;
            window.calls = [];
            plugin.apply({
              effect: run => run(),
              slots: { inject: (_name, run) => run(), register: (_spec, render) => { Settings = render; } },
              tavernUi: {
                registerPanel: entry => { panel = entry; }, registerComposerAction: entry => { action = entry; },
                openOverlay: entry => { overlay = entry; },
                async callHost(name, input) {
                  const method = name.replace('dsh-tavern-stcontext/', ''); window.calls.push({ method, input });
                  return window.hostCall(name, input);
                },
              },
            });
            action.run({ gameId: 'game' });
            const element = surface === 'settings' ? h(Settings)
              : surface === 'overlay' ? overlay.render({ close() {} }) : panel.render({ gameId: 'game' });
            let root = modules['react-dom/client'].createRoot(document.querySelector('main'));
            root.render(element);
            window.remount = () => { root.unmount(); root = modules['react-dom/client'].createRoot(document.querySelector('main')); root.render(element); };
          }, surface);
          await page.waitForFunction(() => document.querySelector('.stc-header-status')?.textContent === '配置就绪');
          await page.getByText('兼容报告', { exact: false }).click();
          if (surface !== 'settings') await page.getByRole('button', { name: '查看本次请求' }).click();
          const selector = surface === 'settings' ? 'main' : '.stc-scroll';
          const area = page.locator(selector);
          await area.evaluate(element => { element.scrollTop = 0; });
          await page.mouse.move(viewport.width / 2, 100);
          await page.mouse.wheel(0, 260);
          await page.waitForFunction(selector => document.querySelector(selector).scrollTop > 0, selector);
          await area.evaluate(element => { element.scrollTop = element.scrollHeight; });
          const metrics = await area.evaluate(element => {
            const bottom = document.querySelector('.stc-panel').lastElementChild.getBoundingClientRect();
            return { top: element.scrollTop, height: element.clientHeight, scrollHeight: element.scrollHeight,
              width: element.clientWidth, scrollWidth: element.scrollWidth, bottom: bottom.bottom, edge: element.getBoundingClientRect().bottom };
          });
          assert.ok(metrics.top > 0 && metrics.height < metrics.scrollHeight, JSON.stringify(metrics));
          assert.ok(metrics.bottom <= metrics.edge + 1, 'last section must fit inside the visible scroll area');
          assert.ok(metrics.scrollWidth <= metrics.width + 1, 'no horizontal overflow');
          await area.evaluate(element => { element.scrollTop = 0; });
          const personaDescription = '姓名：林舟\n身份：旅行者';
          await page.getByRole('textbox', { name: '玩家设定', exact: true }).fill(personaDescription);
          await page.getByRole('button', { name: '保存设置', exact: true }).click();
          await page.getByText('设置已保存', { exact: true }).waitFor();
          assert.equal(data.settings.personaDescription, personaDescription);
          await page.evaluate(() => window.remount());
          await page.waitForFunction(() => document.querySelector('.stc-header-status')?.textContent === '配置就绪');
          assert.equal(await page.getByRole('textbox', { name: '玩家设定', exact: true }).inputValue(), personaDescription);
          if (process.env.STCONTEXT_SCREENSHOT_DIR && surface === 'settings') {
            const section = page.getByRole('region', { name: '生成设置', exact: true });
            const height = await section.evaluate(element => Math.ceil(element.getBoundingClientRect().height) + 180);
            await page.setViewportSize({ width: viewport.width, height });
            await section.screenshot({ path: join(process.env.STCONTEXT_SCREENSHOT_DIR, `persona-settings-${viewport.width}.png`) });
            await page.setViewportSize(viewport);
          }
          await page.getByRole('button', { name: '编辑预设', exact: true }).click();
          const editor = page.getByRole('region', { name: '预设编辑器' });
          await editor.getByRole('textbox', { name: '提示词内容', exact: true }).fill('修改后的叙事规则 {{user}}');
          await editor.getByRole('button', { name: '下移 主提示词', exact: true }).click();
          await editor.getByRole('combobox', { name: '注入位置' }).selectOption('1');
          await editor.getByRole('spinbutton', { name: '注入深度' }).fill('3');
          assert.equal(await editor.getByRole('checkbox', { name: /^(正常生成|重生成|继续|滑动|静默|扮演用户)$/ }).count(), 0);
          const editorMetrics = await area.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
          assert.ok(editorMetrics.scrollWidth <= editorMetrics.width + 1, 'editor must not overflow horizontally');
          if (process.env.STCONTEXT_SCREENSHOT_DIR && surface === 'settings') {
            // Expand only for the artifact capture: an element taller than its
            // scroll container would otherwise be clipped in the screenshot.
            const height = await editor.evaluate(element => Math.ceil(element.getBoundingClientRect().height) + 180);
            await page.setViewportSize({ width: viewport.width, height });
            await editor.screenshot({ path: join(process.env.STCONTEXT_SCREENSHOT_DIR, `preset-editor-${viewport.width}.png`) });
            await page.setViewportSize(viewport);
          }
          assert.equal(await editor.getByRole('tab', { name: '生成参数', exact: true }).count(), 0);
          assert.equal(await editor.getByRole('spinbutton', { name: '温度', exact: true }).count(), 0);
          await editor.getByRole('checkbox', { name: '合并相邻系统消息', exact: true }).check();
          await editor.getByRole('tab', { name: '正则规则', exact: true }).click();
          await editor.getByRole('textbox', { name: '替换文本', exact: true }).fill('ZZ');
          await editor.getByRole('tab', { name: '助手脚本', exact: true }).click();
          const folder = editor.getByRole('checkbox', { name: '启用 助手目录', exact: true });
          const script = editor.getByRole('checkbox', { name: '启用 助手目录 / 内嵌脚本', exact: true });
          assert.equal(await folder.isChecked(), true);
          await folder.uncheck(); assert.equal(await script.isDisabled(), true);
          await folder.check(); await script.uncheck();
          const scriptMetrics = await area.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
          assert.ok(scriptMetrics.scrollWidth <= scriptMetrics.width + 1, 'script tree must not overflow horizontally');
          await editor.getByRole('tab', { name: '完整 JSON', exact: true }).click();
          const raw = editor.getByRole('textbox', { name: '预设 JSON', exact: true });
          const draft = await raw.inputValue();
          await raw.fill('{invalid'); await editor.getByRole('button', { name: '保存预设', exact: true }).click();
          await editor.getByRole('alert').filter({ hasText: 'JSON 无效' }).waitFor();
          assert.equal(await raw.inputValue(), '{invalid');
          await raw.fill(draft); await editor.getByRole('button', { name: '保存预设', exact: true }).click();
          await page.getByText('预设已保存，下次生成生效', { exact: true }).waitFor();
          const savedDoc = (await store.active()).document;
          assert.equal(savedDoc.prompts[0].content, '修改后的叙事规则 {{user}}');
          assert.equal(savedDoc.prompts[0].injection_depth, 3);
          assert.deepEqual(savedDoc.prompts[0].injection_trigger, ['regenerate']);
          assert.equal(savedDoc.prompt_order[0].order[0].identifier, 'rule-0');
          assert.equal(savedDoc.temperature, .75); assert.equal(savedDoc.top_p, .9); assert.equal(savedDoc.squash_system_messages, true);
          assert.equal(savedDoc.extensions.regex_scripts[0].replaceString, 'ZZ');
          assert.equal(savedDoc.extensions.tavern_helper.scripts[0].scripts[0].enabled, false);
          assert.equal(savedDoc.notes, doc.notes);
          const unsaved = JSON.stringify({ ...savedDoc, notes: '暂存草稿' });
          await raw.fill(unsaved);
          await page.evaluate(() => window.remount());
          await editor.getByRole('textbox', { name: '预设 JSON', exact: true }).waitFor();
          assert.equal(await raw.inputValue(), unsaved, 'draft survives host panel unmount');
          await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
          await page.getByRole('button', { name: '继续编辑', exact: true }).click();
          assert.equal(await raw.inputValue(), unsaved);
          await editor.getByRole('button', { name: '关闭编辑器', exact: true }).click();
          await page.getByRole('button', { name: '放弃更改并继续', exact: true }).click();
          assert.equal((await store.active()).document.notes, doc.notes);
          await page.evaluate(() => window.remount());
          await page.getByRole('button', { name: '编辑预设', exact: true }).waitFor();
          assert.equal(await page.getByRole('region', { name: '预设编辑器' }).count(), 0, 'discarded draft must not be restored');
          const selection = page.getByRole('combobox', { name: '当前预设' });
          await selection.selectOption('host:' + sharedId);
          await page.getByText('宿主预设在 DSH Tavern 预设库中编辑', { exact: false }).waitFor();
          assert.equal(data.hostPreset, sharedId);
          assert.equal(await page.getByRole('button', { name: '编辑预设', exact: true }).isDisabled(), true);
          await selection.selectOption('host:current');
          await page.waitForFunction(() => !document.querySelector('select[aria-label="当前预设"]').disabled);
          assert.equal(data.hostPreset, 'current');
          if (surface === 'settings') {
            assert.equal(await page.getByRole('button', { name: '重新生成最新正文' }).count(), 0);
            assert.equal(await page.evaluate(() => calls.some(call => ['status', 'start', 'cancel', 'request'].includes(call.method))), false);
          }
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      });
    }
  }
});
