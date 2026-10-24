import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutcomes } from '../extension/outcomes.js';

test('post-action probes follow structured uncertainty and dispatch evidence rather than error wording', async () => {
  let probes = 0;
  const observations = { version: () => 1, mainFrame: () => 'main', frameVersion: () => 1 };
  const outcomes = createOutcomes(null, null, null, observations, async () => { probes++; return { url: 'https://fixture.test/' }; }, () => null);
  for (const [properties, message, expected] of [
    [{ outcome_unknown: true, input_dispatched: true }, '字段状态无法确认', true],
    [{ outcome_unknown: true, input_dispatched: false }, 'Outcome is unknown', false],
    [{ input_dispatched: true }, 'Outcome is unknown; timed out', false],
  ]) {
    const outcome = await outcomes.begin(9, 'fill', {}), before = probes;
    const error = Object.assign(new Error(message), properties);
    assert.equal(await outcome.enrich(error, []), expected);
    assert.equal(probes - before, expected ? 1 : 0);
    assert.equal(!!error.post_action, expected);
    if (expected) assert.equal(error.post_action.assessment, 'observation_unavailable');
    await outcome.stop();
  }
});
