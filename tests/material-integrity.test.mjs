import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMaterialsPreserved } from '../lib/request.mjs';
import { compilePreset } from '../lib/preset.mjs';
import { compilerMaterials } from '../lib/materials.mjs';
import { createMaterialProtection } from '../lib/material-protection.mjs';
import { materials, preset } from './fixtures/materials.mjs';

const captured = texts => texts.map(content => ({ content, source: 'history' }));
const request = (texts, descriptions = []) => ({ messages: texts.map(content => ({ role: 'user', content })),
  tools: descriptions.map(description => ({ description })) });

test('moving frozen literal expressions into a tool argument preserves JSON quoting and source text', () => {
  const protection = createMaterialProtection(), literal = 'x <% print("hi\\there") %> {{user}}';
  const [{ content }] = protection.protectMessages([{ source: 'history', content: literal }]);
  const wire = { messages: [{ role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify({ story: content }) } }] }] };
  const args = protection.restore(wire).messages[0].tool_calls[0].function.arguments;
  assert.deepEqual(JSON.parse(args), { story: literal });
  assert.doesNotMatch(args, /STCONTEXT_MATERIAL_/);
});
test('tool message and arguments retain authored JSON formatting and escaping through nested encoding', () => {
  const protection = createMaterialProtection();
  const literal = '引号 <% print("hi\\there") %> &quot; {{user}}\n下一行';
  const [{ content }] = protection.protectMessages([{ source: 'history', content: literal }]);
  const inner = value => '{ "pre" : "\\u003c&amp;\\/", "story" : ' + JSON.stringify(value) + ' }';
  const outer = value => '{\n "nested": ' + JSON.stringify(inner(value)) + ', "plain": ' + JSON.stringify(value) + '\n}';
  const restored = protection.restore({ messages: [
    { role: 'tool', content: inner(content) },
    { role: 'assistant', content: '', tool_calls: [{ function: { arguments: outer(content) } }] },
  ] });
  assert.equal(restored.messages[0].content, inner(literal));
  const args = restored.messages[1].tool_calls[0].function.arguments;
  assert.equal(args, outer(literal));
  assert.equal(JSON.parse(JSON.parse(args).nested).story, literal);
  assert.equal(JSON.parse(JSON.parse(args).nested).pre, '<&amp;/');
  // JSON text saved in a real chat message already owns its escapes.
  const [saved] = protection.protectMessages([{ source: 'history', content: inner(literal) }]);
  assert.equal(protection.restore({ messages: [saved] }).messages[0].content, inner(literal));
});

test('a final request hook can select historical rows without editing the captured conversation', () => {
  const host = structuredClone(materials), document = structuredClone(preset);
  host.history = [{ role: 'user', text: '好的' }, { role: 'assistant', text: '他说：“好的。”' }];
  document.extensions.SPreset = { FinalRequestProcessing: { enabled: true,
    script: '({ request }) => ({ ...request, messages: request.messages.filter(message => message.content !== "好的") })' } };
  const compiled = compilePreset(document, compilerMaterials(host));
  assert.ok(!compiled.request.messages.some(message => message.content === '好的'));
  assert.ok(compiled.request.messages.some(message => message.content === '他说：“好的。”'));
  assert.equal(host.history[0].text, '好的');
  document.extensions.SPreset.FinalRequestProcessing.script = '({ request }) => request';
  assert.doesNotThrow(() => compilePreset(document, compilerMaterials(host)));
});

test('overlapping substrings and repeated materials require separate output intervals', () => {
  for (const [source, sent] of [
    [['好的', '他说：“好的。”'], ['他说：“好的。”']],
    [['abc', 'bcd'], ['abcd']],
    [['aa', 'aa'], ['aaa']],
    [['重复', '重复', '这里有重复'], ['重复', '这里有重复']],
  ]) assert.throws(() => assertMaterialsPreserved(captured(source), request(sent)), /完整历史保护/);
});

test('complete materials can be reordered, merged or moved between messages and tools', () => {
  const source = captured(['好的', '他说：“好的。”', '重复', '重复']);
  for (const sent of [
    request(['好的\n他说：“好的。”\n重复\n重复']),
    request(['重复', '他说：“好的。”'], ['好的\n重复']),
    request([], ['重复\n重复\n他说：“好的。”\n好的']),
  ]) assert.doesNotThrow(() => assertMaterialsPreserved(source, sent));
  assert.throws(() => assertMaterialsPreserved(captured(['完整材料']), request(['完整'], ['材料'])), /完整历史保护/);
});

test('ambiguous matches backtrack instead of rejecting an intact reordered request', () => {
  // The first abc overlaps the only cde. Reserve the second abc and then cde.
  assert.doesNotThrow(() => assertMaterialsPreserved(captured(['abc', 'cde']), request(['abcde/abc'])));
  // Equal materials use distinct positions, including when a longer one shares
  // their text, and do not need to explore duplicate permutations.
  assert.doesNotThrow(() => assertMaterialsPreserved(captured(['aa', 'aa', 'aab']), request(['aab/aaaa'])));
});

test('large unchanged histories use the ordered path and wrappers preserve raw input', () => {
  const source = captured(Array.from({ length: 20000 }, (_, index) => index % 2 ? '好的' : '他说：“好的。”'));
  assert.doesNotThrow(() => assertMaterialsPreserved(source, request([source.map(message => message.content).join('\n')])));
  assert.doesNotThrow(() => assertMaterialsPreserved([{ source: 'input', rawContent: '输入', content: '<input>输入</input>' }], request(['输入'])));
});

test('pathological overlap reports an explicit verification limit instead of accepting it', () => {
  const source = captured([...Array(14).fill('aa'), ...Array(14).fill('a')]);
  assert.throws(() => assertMaterialsPreserved(source, request(['a'.repeat(40) + 'x'.repeat(8)])), /校验预算.*完整历史保护/);
});
