import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePreset, parsePreset, inspectPreset } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { materials, preset } from './fixtures/materials.mjs';
import { inspectWorkbenchSource, projectWorkbenchReport } from '../lib/workbench-report.mjs';

const id = 'x.y[3]/~ (name)', secret = 'DO_NOT_ECHO_SOURCE';
function fixture() {
  return { prompts: [{ identifier: id, name: 'misleading).role', role: 'model', content: '{{unknown::' + secret + '}}' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: id }] }], top_k: 0, request_images: true,
    extensions: { 'odd.~field/key': { enabled: true, private: secret }, SPreset: { RegexBinding: {},
      ToolBindings: { [id]: { enabled: true, code: 'return (' } },
      MessageInjections: { [id]: { enabled: true } }, 'odd.SPreset~/': { private: secret },
      OutputPreprocessing: { enabled: true } }, regex_scripts: [{ placement: [1] }, { placement: [1], findRegex: '[' + secret }],
      tavern_helper: { scripts: [{ enabled: false }, { type: 'folder', scripts: [{ enabled: false },
        { enabled: true, content: `throw new Error('${secret}');` }] }] } } };
}
const inspect = (doc, options) => inspectWorkbenchSource(JSON.stringify(doc), options);
const resolve = (doc, pointer) => pointer.slice(1).split('/').reduce((obj, key) => {
  key = key.replaceAll('~1', '/').replaceAll('~0', '~');
  assert.ok(Object.hasOwn(obj, key), pointer);
  return obj[key];
}, doc);

test('static projection uses both legacy diagnostic channels, static-only, without exposing script, regex, configuration or macro bodies', () => {
  const doc = fixture(), text = JSON.stringify(doc), report = inspectPreset(parsePreset(text));
  const page = inspectWorkbenchSource(text, { limit: 40 });
  assert.deepEqual(page, projectWorkbenchReport(JSON.parse(JSON.stringify(report)), { limit: 40 }));
  assert.equal(page.validation, 'static');
  assert.equal(page.blockerCount, report.blockers.length);
  assert.equal(page.warningCount, report.warnings.length); // Includes the helper's info.
  assert.equal(page.issueCount, page.issues.length);
  assert.equal(page.nextOffset, null);
  assert.ok(page.issues.some(x => x.message.includes('未映射的采样项')));
  assert.ok(page.issues.some(x => x.message.includes('RegexBinding')));
  assert.equal(page.issues.filter(x => x.severity === 'error').length, page.blockerCount);
  assert.ok(!JSON.stringify(page).includes(secret));
  assert.ok(!Object.hasOwn(page, 'scripts') && !Object.hasOwn(page, 'historyRules'));
});

test('locations come from actual source indices and RFC 6901 keys, not labels, logical script indices or missing fields', () => {
  const doc = fixture(), page = inspect(doc, { limit: 40 });
  const pointers = page.issues.filter(x => x.locatable).map(x => x.pointer);
  assert.ok(pointers.every(p => resolve(doc, p) !== undefined));
  for (const expected of ['/prompts/0/content', '/prompts/0/role', '/extensions/odd.~0field~1key', '/extensions/SPreset/odd.SPreset~0~1',
    '/extensions/SPreset/ToolBindings/x.y[3]~1~0 (name)/code', '/extensions/SPreset/MessageInjections/x.y[3]~1~0 (name)',
    '/extensions/tavern_helper/scripts/1/scripts/1/content', '/extensions/regex_scripts/1/findRegex']) assert.ok(pointers.includes(expected), expected);
  for (const path of ['request_images/enable_web_search/n', 'extensions.regex_scripts[0].findRegex', 'extensions.SPreset.OutputPreprocessing.script']) {
    assert.ok(page.issues.some(x => x.path === path && !x.locatable && !Object.hasOwn(x, 'pointer')), path);
  }
  assert.ok(page.issues.filter(x => x.stage === 'preset').every(x => !x.locatable));
});

test('structure/parse errors return a useful blocker in the same shape and never echo JSON parser snippets', () => {
  for (const [source, re] of [[`{"prompts": ${secret}}`, /JSON 无效/], ['{}', /prompts/],
    [JSON.stringify({ prompts: [{ identifier: 'x', role: secret }] }), /消息角色/],
    [JSON.stringify({ ...fixture(), extensions: { tavern_helper: { scripts: 12 } } }), /scripts 必须是数组/],
    [null, /JSON/]]) {
    const page = inspectWorkbenchSource(source);
    assert.equal(page.blockerCount, 1); assert.equal(page.warningCount, 0);
    assert.equal(page.issues[0].stage, 'structure'); assert.match(page.issues[0].message, re);
    assert.equal(page.issues[0].locatable, false); assert.equal(page.nextOffset, null);
    assert.ok(!JSON.stringify(page).includes(secret));
  }
  assert.equal(inspectWorkbenchSource('{}', { offset: 1 }).issues.length, 0);
  const malformed = inspect({ ...fixture(), extensions: secret.repeat(10000) });
  assert.equal(malformed.issueCount, 1); assert.equal(malformed.issues[0].pointer, '/extensions');
  assert.ok(!JSON.stringify(malformed).includes(secret));
});

test('trigger is the same static filter as inspectPreset, not a compiler or a script call', () => {
  const doc = fixture(); delete doc.extensions; delete doc.request_images; delete doc.top_k;
  doc.prompts[0].injection_trigger = ['regenerate'];
  assert.equal(inspect(doc, { trigger: 'normal' }).issueCount, 0);
  assert.equal(inspect(doc, { trigger: 'regenerate' }).blockerCount, 1);
  const code = `throw new Error('${secret}');`;
  doc.prompts[0].content = `<% ${code} %>`;
  doc.extensions = { SPreset: { FinalRequestProcessing: { enabled: true, script: `() => { ${code} }` } },
    tavern_helper: { scripts: [{ enabled: true, content: code }] } };
  const page = inspect(doc);
  assert.equal(page.blockerCount, 0); assert.ok(page.warningCount > 0); assert.ok(!JSON.stringify(page).includes(secret));
});

test('effective numeric controls: exact fallback, source typing, override attribution and compiler first-error parity', () => {
  const data = compilerMaterials(materials);
  const cases = [
    [{ temperature: '0.7', openai_max_tokens: 0, max_tokens: 512 }, {}, ['/openai_max_tokens', '/temperature']],
    [{ temperature: -1, openai_max_tokens: null, max_tokens: '512' }, { temperature: '0', maxTokens: '' }, ['/max_tokens']],
    [{ temperature: 0, max_tokens: 8 }, { temperature: 3, maxTokens: 'bad', contextLimit: 1.5 }, ['settings.maxTokens', 'settings.contextLimit', 'settings.temperature']],
    [{ temperature: 0.7, max_tokens: 8, openai_max_context: 1024 }, { contextLimit: '8' }, ['settings.contextLimit']],
    [{}, { contextLimit: 8192 }, ['settings.contextLimit']],
    [{ max_tokens: 5.5, temperature: 2.1 }, { temperature: null, maxTokens: null }, ['/max_tokens', '/temperature']],
    [{ openai_max_tokens: 64, max_tokens: -1, temperature: 2 }, { temperature: '' }, []],
    [{ openai_max_tokens: -5, temperature: 'invalid' }, { maxTokens: '32', temperature: '0', contextLimit: '33' }, []],
  ];
  for (const [source, settings, expected] of cases) {
    const doc = { ...preset, ...source };
    const page = inspect(doc, { settings, trigger: 'normal' });
    assert.deepEqual(page, projectWorkbenchReport(inspectPreset(doc, { ...settings, trigger: 'normal' })));
    const errors = page.issues.filter(x => x.severity === 'error');
    assert.deepEqual(errors.map(x => x.pointer ?? x.path), expected);
    for (const row of errors) assert.equal(row.locatable, !!row.pointer);
    if (errors.length) assert.throws(() => compilePreset(doc, data, settings), { message: errors[0].message });
    else {
      const { request } = compilePreset(doc, data, settings);
      assert.equal(request.maxTokens, settings.maxTokens ? Number(settings.maxTokens) : 64);
      assert.equal(request.temperature, settings.temperature === '0' ? 0 : 2);
    }
  }
});

test('legacy output is never interpreted as a pointer and deduplication subtracts mirror multiplicity only', () => {
  const d = { severity: 'warning', stage: 'helper', path: 'extensions.tavern_helper.scripts[0] (nested)', message: 'notice' };
  const mirror = d.path + '：' + d.message;
  const report = { diagnostics: [d, { ...d }], warnings: [mirror, 'general', mirror, mirror], blockers: ['setup'] };
  const page = projectWorkbenchReport(report);
  assert.deepEqual(page.issues.map(x => x.message), ['setup', 'notice', 'notice', 'general', mirror]);
  assert.ok(page.issues.every(x => !x.locatable && !Object.hasOwn(x, 'pointer')));
  const legacy = projectWorkbenchReport({ diagnostics: ['/constructor/value', '/x/bad~2', '/prototype', '/__proto__', '/' + 'k'.repeat(400)].map(pointer => ({ ...d, pointer })) });
  assert.ok(legacy.issues.every(x => !x.locatable && !Object.hasOwn(x, 'pointer')));
});

test('cursor covers all occurrences once, with hard row, string and JSON byte bounds and finite invalid options', () => {
  const report = { diagnostics: Array.from({ length: 150 }, (_, i) => ({ severity: 'warning', stage: 'native',
    pointer: '/' + '\u0001'.repeat(310), path: 'k'.repeat(500), message: String(i) + '\u0000'.repeat(5000) })) };
  let offset = 0, count = 0;
  do {
    const page = projectWorkbenchReport(report, { offset, limit: 9999 });
    assert.ok(page.issues.length > 0 && page.issues.length <= 40);
    assert.equal(page.issueCount, 150); assert.equal(page.warningCount, 150);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 24 * 1024);
    for (const i of page.issues) { assert.equal(parseInt(i.message), count++); assert.ok(i.message.length <= 240); }
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(count, 150);
  assert.deepEqual(projectWorkbenchReport(report, { offset: Number.MAX_SAFE_INTEGER }).issues, []);
  assert.equal(projectWorkbenchReport(report, { offset: NaN, limit: -1 }).offset, 0);
  assert.equal(projectWorkbenchReport(report, { limit: Infinity }).limit, 20);
});
