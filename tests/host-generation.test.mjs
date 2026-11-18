import test from 'node:test';
import assert from 'node:assert/strict';
import { bundledHelper } from './fixtures/bundled-helper.mjs';
import { preset } from './fixtures/materials.mjs';
import { runHostGeneration, hostRules } from './fixtures/host-harness.mjs';

// Uses production host preparation/commit and the real plugin compiler with a
// deterministic model response. No imported preset or paid request is needed.
for (const mode of ['plugin-direct', 'plugin-tool-call']) test(`upstream ${mode}: frozen config -> STcontext -> reusable receipt -> one settlement`, {
  skip: !process.env.STCONTEXT_HOST_REPO,
}, async () => {
  let requests = 0;
  const presetText = JSON.stringify({ notes: 'x'.repeat(3 * 1024 * 1024), prompts: [{ identifier: 'chatHistory', marker: true },
    { identifier: 'normal', role: 'system', content: 'normal-only', injection_trigger: ['normal'] },
    { identifier: 'regen', role: 'system', content: 'regenerate-only', injection_trigger: ['regenerate'] }],
    prompt_order: [{ character_id: 100001, order: ['normal', 'regen', 'chatHistory'].map(identifier => ({ identifier, enabled: true })) }],
    extensions: { regex_scripts: [{ id: 'once', placement: [2], findRegex: '/X/g', replaceString: 'XX', markdownOnly: true, promptOnly: true }] } });
  const result = await runHostGeneration({ mode, presetText, async *stream(request) {
    requests++;
    assert.equal(request.provider, 'independent');
    assert.equal(request.model, 'plugin-story');
    const wire = JSON.stringify(request.messages);
    for (const value of ['完整历史正文', '已解析人物设定', '继续', '起点', 'normal-only']) assert.ok(wire.includes(value), value);
    assert.doesNotMatch(wire, /regenerate-only|summary|不可传入的读取结果/);
    assert.equal(wire.split('本轮查询补充').length - 1, mode === 'plugin-tool-call' ? 1 : 0);
    yield { type: 'text-delta', index: 0, text: '<div>X</div>' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  const { receipt, supportsHostRegex, saved, projected } = result;
  assert.equal(JSON.parse(receipt).text, '<div>X</div>');
  assert.equal(requests, 1); assert.equal(result.concludes, 1); assert.equal(result.settlements, 1);
  const state = result.state();
  assert.equal(state.messages.length, 3);
  assert.equal(saved.sourceText, '<div>X</div>');
  assert.equal(saved.text, '<div>X</div>');
  assert.equal(saved.displayText, supportsHostRegex ? '<div>DISPLAY</div>' : '<div>XX</div>');
  assert.equal(saved.bodyRegenerationProcessed, true);
  assert.equal(projected, saved.text);
  const reopened = JSON.parse(JSON.stringify(state));
  const { global, preset, context, card } = hostRules;
  assert.equal(result.projectReplyHistory(reopened.messages, { regexScripts: [global, preset, context, card] }).projections.at(-1).text, saved.displayText);
  assert.equal((await result.call('request', { gameId: 'session' })).report.outputProcessing?.hostRegex, supportsHostRegex ? true : undefined);
});

// Exercise a large bundled script on the real host path without private fixtures.
for (const mode of ['plugin-direct', 'plugin-tool-call']) test(`upstream ${mode}: bundled helper uploads, freezes, formats and settles once`, {
  skip: !process.env.STCONTEXT_HOST_REPO,
}, async () => {
  const document = structuredClone(preset);
  document.prompts.push({ identifier: 'tool-switch', role: 'system', content: '启用工具[ANTI_ROUTE_TAG]' });
  document.prompt_order[0].order.push({ identifier: 'tool-switch', enabled: true });
  document.extensions.tavern_helper = { scripts: [{ id: 'bundle', name: 'Bundled helper', enabled: true, content: bundledHelper }] };
  let requests = 0;
  const result = await runHostGeneration({ mode, presetText: JSON.stringify(document), async *stream(request) {
    requests++;
    assert.deepEqual((request.tools || []).map(tool => tool.name), ['structured_reply']);
    const wire = JSON.stringify(request.messages);
    for (const value of ['完整历史正文', '已解析人物设定', '继续', '起点']) assert.ok(wire.includes(value), value);
    yield { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'structured_reply',
      argumentsDelta: JSON.stringify({ content: '测试正文X' }) };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  } });
  assert.equal(requests, 1);
  assert.equal(JSON.parse(result.receipt).text, '测试正文X');
  assert.equal(result.concludes, 1); assert.equal(result.settlements, 1);
  assert.equal(result.state().messages.length, 3);
  assert.equal(result.saved.sourceText, '测试正文X');
  assert.equal(result.projected, result.saved.text);
});
