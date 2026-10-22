import test from 'node:test';
import assert from 'node:assert/strict';
import { timingOption, sampleTiming, trajectoryOption, dragPath, pause } from '../extension/motion.js';
import { clippedPoint, clickOptions } from '../extension/click.js';
import { typeOptions } from '../extension/input.js';
import { dragOptions } from '../extension/drag.js';
import { validateSteps } from '../extension/batch.js';
import { deadline } from '../extension/actionability.js';

test('timing pairs are bounded, ordered and sampled inclusively; fixed delays stay fixed', () => {
  for (const delay of [0, 1000, [40, 180], [0, 0]]) {
    timingOption(delay, 'delay_ms');
    typeOptions({ text: 'abc', delay_ms: delay });
    const min = Array.isArray(delay) ? delay[0] : delay, max = Array.isArray(delay) ? delay[1] : delay;
    for (let i = 0; i < 100; i++) { const ms = sampleTiming(delay); assert.ok(ms >= min && ms <= max && Number.isInteger(ms)); }
  }
  for (const value of [-1, 1001, NaN, [180, 40], [1], [1, 2, 3], [0, 1.5], '40', {}]) {
    assert.throws(() => timingOption(value, 'delay_ms'));
    assert.throws(() => typeOptions({ text: 'x', delay_ms: value }));
  }
});

test('offset follows transformed quads and refuses offscreen points without a center fallback', () => {
  const view = { width: 100, height: 100 }, quad = [-20, 10, 60, 10, 60, 50, -20, 50];
  assert.deepEqual(clippedPoint(quad, view, { x_ratio: .75, y_ratio: .25 }), { x: 40, y: 20 });
  assert.equal(clippedPoint(quad, view, { x_ratio: 0, y_ratio: .5 }), null);
  assert.deepEqual(clippedPoint([10, 0, 50, 40, 30, 60, -10, 20], view, { x_ratio: .75, y_ratio: .25 }), { x: 35, y: 35 });
  assert.deepEqual(clippedPoint(quad, view), { x: 30, y: 30 });
  for (const args of [{ x: 10, y: 10, offset: { x_ratio: .5, y_ratio: .5 } },
    { selector: 'button', mode: 'dom', offset: { x_ratio: .5, y_ratio: .5 } },
    { selector: 'button', offset: { x_ratio: 1.1, y_ratio: .5 } },
    { selector: 'button', offset: { x_ratio: .5 } }, { selector: 'button', mode: 'dom', settle_ms: 20 }]) assert.throws(() => clickOptions(args));
});

test('default drag path consumes no randomness and retains the original interpolation and 16ms waits', t => {
  t.mock.method(Math, 'random', () => { throw new Error('Unexpected randomness'); });
  assert.deepEqual(dragPath({ x: 10, y: 20 }, { x: 40, y: 80 }, 3), [
    { point: { x: 20, y: 40 }, dt: 16 }, { point: { x: 30, y: 60 }, dt: 16 }, { point: { x: 40, y: 80 }, dt: 16 },
  ]);
  assert.equal(sampleTiming(40), 40);
});

test('opted-in drag bends perpendicular to movement, varies intervals and finishes exactly at the target', t => {
  let n = 0; t.mock.method(Math, 'random', () => (++n % 5) / 5);
  for (const to of [{ x: 100, y: 0 }, { x: 0, y: 100 }]) {
    const samples = dragPath({ x: 0, y: 0 }, to, 20, { curve_px: 12, duration_ms: 600 });
    assert.equal(samples.length, 20); assert.deepEqual(samples.at(-1).point, to);
    assert.ok(Math.abs(samples.reduce((sum, s) => sum + s.dt, 0) - 600) < 1e-8);
    assert.ok(new Set(samples.map(s => s.dt)).size > 1);
    assert.ok(samples.slice(0, -1).some(s => to.x ? s.point.y > 0 : s.point.x < 0));
  }
  for (const trajectory of [{}, { curve_px: 101, duration_ms: 600 }, { curve_px: 10, duration_ms: 99 }, { curve_px: 10, duration_ms: [300, 900] }]) assert.throws(() => trajectoryOption(trajectory));
  dragOptions({ source: { selector: '#a', offset: { x_ratio: .25, y_ratio: .75 } }, destination: { x: 10, y: 10 }, trajectory: { curve_px: -12, duration_ms: 600 }, settle_ms: [80, 250] });
});

test('batch validates optional pointer and typing parameters before any step; waits share dispatch-aware deadlines', async () => {
  const steps = [{ action: 'click', selector: '#a', offset: { x_ratio: .25, y_ratio: .75 }, settle_ms: [80, 250] },
    { action: 'type', selector: '#b', text: 'abc', delay_ms: [40, 180] }];
  validateSteps(steps);
  assert.throws(() => validateSteps([...steps, { action: 'hover', selector: '#a', offset: { x_ratio: -1, y_ratio: .5 } }]));
  for (const dispatched of [false, true]) {
    const budget = deadline(100); if (dispatched) budget.dispatch();
    await assert.rejects(pause(budget, 200), error => error.input_dispatched === dispatched);
  }
});
