import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHelpers, MAX_BUNDLED_HELPER_BYTES, MAX_ORDINARY_HELPER_BYTES } from '../lib/helper.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { materials, preset } from './fixtures/materials.mjs';

const documentFor = (...scripts) => ({ ...preset, extensions: { ...preset.extensions,
  tavern_helper: { scripts: scripts.map((content, index) => ({ enabled: true, name: 'same name', id: String(index), content })) } } });
const inspect = (...scripts) => inspectHelpers(documentFor(...scripts));
const kind = source => inspect(source).reports[0].supported;
const compile = (...scripts) => compilePreset(documentFor(...scripts), compilerMaterials(materials), { model: { provider: 'fixture', model: 'story' } });
const button = "document.querySelector('#menu').addEventListener('click', () => generate({}));";

test('follows local calls, aliases, IIFEs and eager ready callbacks without running click code', () => {
  for (const mount of [button, '/* 改文案 */\n' + button.replace('#menu', '#新菜单'),
    'function mount() {' + button + '} mount();',
    '(() => { function mount() {' + button + '} mount(); })();',
    'const bind = (el, fn) => el.addEventListener("change", fn); $(() => bind(document.body, () => setChatMessages([])));',
    'document.addEventListener("DOMContentLoaded", () => {' + button + '});',
    'const mount = async () => {' + button + '}; $(async () => {await mount();});',
    '$(document).ready(() => {' + button + '});',
    'eventOn(getButtonEvent("菜单"), () => generate({}));']) {
    assert.equal(kind(mount), 'ui-only', mount);
    assert.equal(compile(mount).helperState, undefined);
  }
});

test('read-only request and prompt statistics qualify, but colocated mutations reach the real request', () => {
  const contextStats = `const ctx=SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, r => $('#stats').text(r.messages.length));`;
  assert.equal(kind(contextStats), 'ui-only');
  for (const [hook, key] of [['CHAT_COMPLETION_SETTINGS_READY', 'messages'], ['CHAT_COMPLETION_PROMPT_READY', 'chat']]) {
    const observer = effect => `(() => {
      const label = document.createElement('span');
      eventOn(tavern_events.${hook}, input => {
        const rows = input.${key};
        label.textContent = String(rows.reduce((total, row) => total + row.content.length, 0));
        ${effect}
      });
    })();`;
    const info = inspect(observer(''));
    assert.equal(info.reports[0].kind, 'ui-only');
    assert.match(info.diagnostics[0].message, /统计/);
    const mixed = observer("rows.push({role:'user',content:'kept'});");
    assert.equal(kind(mixed), 'restricted');
    assert.equal(compile(mixed).request.messages.at(-1).content, 'kept');
  }
});

test('argument evaluation, shadowing and shared state cannot hide a generation hook', () => {
  const hook = "eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY,r=>r.messages.push({role:'user',content:'kept'}));";
  const cases = [
    `const makeHandler=()=>{${hook} return ()=>{};}; document.createElement('button').addEventListener('click',makeHandler());`,
    `$(document).ready(() => {document.createElement('span'); ${hook}});`,
    `(() => {const document = {createElement() {${hook}}}; document.createElement('div');})();`,
    `(() => {const callbacks = {install:()=>{${hook}}}; document.createElement('div'); callbacks['install']();})();`,
  ];
  for (const source of cases) {
    assert.equal(kind(source), 'restricted');
    assert.equal(compile(source).request.messages.at(-1).content, 'kept');
  }
  const writer = "document.addEventListener('DOMContentLoaded', () => replaceVariables({label:'kept'}));";
  const reader = "eventOn(tavern_events.CHAT_COMPLETION_SETTINGS_READY,r=>r.messages.push({role:'user',content:getVariables().label}));";
  assert.equal(compile(writer, reader).request.messages.at(-1).content, 'kept');
  for (const effect of ["window.fetch = () => {};", "registerMacroLike(/x/, ()=>'y');",
    "localStorage.setItem('panel','ready');", "document.createElement('script');",
    "SillyTavern.getContext().ToolManager.registerFunctionTool({});",
    "eventOn(tavern_events.MESSAGE_RECEIVED, fn);"]) {
    assert.equal(kind(button + effect), 'restricted', effect);
  }
});

test('analysis is bounded, never executes unknown code and does not widen ordinary execution limits', () => {
  const pad = (source, bytes) => source + '//' + 'x'.repeat(bytes - Buffer.byteLength(source) - 2);
  assert.equal(kind(pad(button, MAX_BUNDLED_HELPER_BYTES)), 'ui-only');
  assert.match(inspect(pad(button, MAX_BUNDLED_HELPER_BYTES) + '中').diagnostics[0].message, /4 MiB/);
  assert.match(inspect(pad(button, MAX_BUNDLED_HELPER_BYTES) + '\r\n').diagnostics[0].message, /4 MiB/);
  const unknown = pad(button + 'someUnknownCall();', MAX_ORDINARY_HELPER_BYTES + 1);
  assert.throws(() => compile(unknown), /512 KiB/);
  assert.throws(() => compile(unknown + ' // ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_DATA, cb)'), /512 KiB/);
  assert.equal(kind('(() => {function loop(){loop()} loop();' + button + '})();'), 'restricted');
  assert.equal(inspect('function exported() {' + button + '} exported();', 'exported();').reports[0].supported, 'restricted');
});

test('the ordinary helper runs at the UTF-8 byte limit without switching to bundled mode', () => {
  const source = "const original=fetch; fetch=(url,init)=>{const req=JSON.parse(init.body);" +
    "req.messages.push({role:'user',content:'普通助手已执行'});return original(url,{...init,body:JSON.stringify(req)});}; //";
  const boundary = source + 'x'.repeat(MAX_ORDINARY_HELPER_BYTES - Buffer.byteLength(source) - Buffer.byteLength('中')) + '中';
  const result = compile(boundary);
  assert.equal(result.report.scripts[0].bundled, undefined);
  assert.equal(result.request.messages.at(-1).content, '普通助手已执行');
  assert.throws(() => compile(boundary + 'x'), /512 KiB/);
});

test('a large mounted UI with a genuine after-data hook preserves its generation behavior', () => {
  const source = `(() => {
    const root = document.createElement('section').attachShadow({mode:'open'});
    root.append(document.createElement('span'));
    window.dispatchEvent(new Event('ui-mounted'));
    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.GENERATE_AFTER_DATA, request => {
      request.messages.push({role:'user', content:'after data'});
    });
  })(); //` + 'x'.repeat(MAX_ORDINARY_HELPER_BYTES);
  assert.equal(inspect(source).reports[0].kind, 'bundled');
  assert.equal(compile(source).request.messages.at(-1).content, 'after data');
});
