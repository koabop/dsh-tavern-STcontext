import test from 'node:test';
import assert from 'node:assert/strict';
import { hostModule, runHostGeneration } from './fixtures/host-harness.mjs';
import { preset } from './fixtures/materials.mjs';

for (const mode of ['plugin-direct', 'plugin-tool-call']) test(`upstream ${mode}: both rulings reach only this turn's model input`, {
  skip: !process.env.STCONTEXT_HOST_REPO,
}, async () => {
  const { compileTurnRuling } = await hostModule('domain/narrative-damper.js');
  const userText = '我再听一听门后的声音。', answerText = '门廊里传来脚步声。';
  // A deterministic dice callback, and the host's actual prompt renderer with
  // a canned decision. Neither the decision model nor a writing model is called.
  const dice = '【本轮客观检定已由系统真骰裁定（严禁模型重投、篡改结果或编造外挂翻转）】\n- 检定项目：聆听检定\n- 掷骰结果：2d6 骰出 [3 + 5] = 8（难度「中等」目标 ≥ 7） → 【代价成功】';
  const ruling = { rulingTier: 'costly_advance', deltaBudget: 'micro_step', leverageScore: 1.75,
    diceShift: { check: '聆听', tier: 'costly' } };
  const rulingText = compileTurnRuling(ruling, { posture: '门廊', stateSnapshot: { data: { noise: 7 } } });
  const sent = [];
  const result = await runHostGeneration({ mode, presetText: JSON.stringify(preset), userText,
    settings: { injectNarrativeDamper: true, injectFateDice: true },
    rulings: { 2: { dice, damper: { ruling, rulingText } } },
    async *stream(request) {
      sent.push(structuredClone(request.messages));
      yield { type: 'text-delta', index: 0, text: answerText };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  // Same live game, same input, settings still enabled, old frame still in
  // storage. Nothing produced for turn 3 means no ruling, not turn 2's ruling.
  await result.nextTurn(userText);
  assert.equal(sent.length, 2);
  const turns = sent.map(messages => messages.map(({ role, content }) => ({ role, text: content.map(part => part.text).join('') })));
  const heading = '【以下为本轮系统裁定，非玩家台词】';
  const current = turns[0].findLast(m => m.role === 'user');
  assert.equal(current?.text, `${userText}\n\n${heading}\n${dice}\n\n${rulingText}`);
  assert.ok(turns[1].some(m => m.role === 'assistant' && m.text === answerText), 'turn 2 must be visible in turn 3 history');
  assert.equal(turns[1].findLast(m => m.role === 'user')?.text, userText);
  const playerRows = result.state().messages.filter(row => row.role === 'user');
  assert.deepEqual(playerRows.map(row => row.text), [userText, userText]);
  for (const fragment of [heading, '[3 + 5]', '1.75/3.00']) {
    assert.equal(turns[0].map(m => m.text).join('\n').split(fragment).length - 1, 1, `duplicate in first request: ${fragment}`);
    assert.ok(turns[1].every(m => !m.text.includes(fragment)), `leaked into following request: ${fragment}`);
    assert.ok(!JSON.stringify(playerRows).includes(fragment), `saved on player row: ${fragment}`);
  }
});
