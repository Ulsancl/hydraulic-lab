import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, setCommand, step, reconfigureExperiment } from '../src/model.js';
import { LESSONS } from '../src/lessons.js';
import { createGuide, observeGuide } from '../src/guide.js';

const near = (a, b, tolerance = 1e-10) => assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function experiment(id) {
  const lesson = LESSONS.find(value => value.id === id);
  let state = setCommand(createExperiment(lesson.settings, { positionM: lesson.positionM }), lesson.initialCommand), guide = createGuide(id);
  const apply = (type, after, interval) => {
    const before = state, event = { type, before, after, interval };
    const savedState = structuredClone(state), savedGuide = structuredClone(guide), savedEvent = structuredClone(event);
    const updated = observeGuide(guide, event);
    assert.deepEqual(state, savedState); assert.deepEqual(guide, savedGuide); assert.deepEqual(event, savedEvent);
    state = after; guide = updated;
  };
  return {
    get state() { return state; }, get guide() { return guide; },
    command(value) { apply('command', setCommand(state, value)); },
    advance(seconds) { const result = step(state, seconds); apply('advance', result.state, result.interval); },
    settings(patch) { apply('settings', reconfigureExperiment(state, patch)); },
  };
}

test('reading a guide, zero-duration steps, or cycling commands never confirms an experiment', () => {
  for (const lesson of LESSONS) {
    const run = experiment(lesson.id);
    for (const command of ['neutral', 'retract', 'extend', lesson.initialCommand]) run.command(command);
    run.advance(0);
    assert.equal(run.guide.stepIndex, 0); assert.equal(run.guide.status, 'active'); assert.deepEqual(run.guide.evidence, []);
  }
});

test('full strokes use only moving segments when a frame also contains end-stop relief', () => {
  const run = experiment('speed-ratio'); run.advance(20);
  assert.equal(run.guide.stepIndex, 1); assert.equal(run.guide.status, 'active');
  const outward = run.guide.evidence[0], cap = Math.PI * .06 ** 2 / 4, annular = Math.PI * (.06 ** 2 - .035 ** 2) / 4;
  near(outward.distanceM, .3); near(outward.movingTimeS, .3 * cap / .0001); near(outward.speedMps, .0001 / cap);
  assert(outward.movingTimeS < 20); near(outward.areaM2, cap);
  run.command('retract'); run.advance(20);
  const inward = run.guide.evidence[1];
  assert.equal(run.guide.status, 'completed'); assert.equal(run.guide.stepIndex, 2);
  near(inward.distanceM, .3); near(inward.movingTimeS, .3 * annular / .0001); near(inward.speedMps, .0001 / annular);
  near(inward.speedMps / outward.speedMps, cap / annular);
});

test('partitioned strokes and a neutral pause give the same observed speeds', () => {
  const run = experiment('speed-ratio');
  run.advance(.7); run.command('neutral'); run.advance(100); run.command('extend');
  for (const duration of [.031, .82, .49, 20]) run.advance(duration);
  run.command('retract'); for (const duration of [.007, .21, .051, 20]) run.advance(duration);
  assert.equal(run.guide.status, 'completed');
  near(run.guide.evidence[0].speedMps, .0001 / (Math.PI * .06 ** 2 / 4));
  near(run.guide.evidence[1].speedMps, .0001 / (Math.PI * (.06 ** 2 - .035 ** 2) / 4));
});

test('an actual reversal or changed conditions interrupt a full-stroke comparison', () => {
  const reversed = experiment('speed-ratio'); reversed.advance(1); reversed.command('retract'); reversed.advance(.1);
  assert.equal(reversed.guide.status, 'interrupted'); assert.match(reversed.guide.notice, /반대 방향/);
  reversed.command('extend'); reversed.advance(20); assert.equal(reversed.guide.stepIndex, 0);
  const changed = experiment('speed-ratio'); changed.settings({ pumpFlowM3s: .00015 });
  changed.command('extend'); changed.advance(20); assert.equal(changed.guide.status, 'interrupted');
});

test('force-limit guidance requires observed relief, forward displacement, and explicit 50 bar comparison', () => {
  const run = experiment('pressure-limit');
  assert.equal(run.guide.stepIndex, 0); run.advance(.1);
  assert.equal(run.guide.stepIndex, 1);
  const blocked = run.guide.evidence[0];
  near(blocked.forceLimitN, 2e6 * Math.PI * (.06 ** 2 - .035 ** 2) / 4); assert(blocked.forceLimitN < blocked.loadN);
  near(blocked.reliefEnergyJ, 20); near(blocked.reliefFlowM3s, .0001);
  run.command('extend'); run.advance(.1); assert.equal(run.guide.stepIndex, 2);
  assert(run.guide.evidence[1].forceLimitN > blocked.loadN);
  run.command('retract'); run.advance(2); assert.equal(run.guide.status, 'active'); assert.equal(run.guide.stepIndex, 2);
  run.settings({ reliefPressurePa: 5e6 }); assert.equal(run.guide.pressureChangeApplied, true);
  run.command('retract'); run.advance(.1); assert.equal(run.guide.status, 'completed');
  near(run.guide.evidence[2].forceLimitN, 5e6 * Math.PI * (.06 ** 2 - .035 ** 2) / 4);
});

test('unrelated or out-of-order settings do not satisfy the force comparison', () => {
  const early = experiment('pressure-limit'); early.settings({ reliefPressurePa: 5e6 });
  assert.equal(early.guide.status, 'interrupted'); assert.equal(early.guide.stepIndex, 0);
  const changedLoad = experiment('pressure-limit'); changedLoad.advance(.1); changedLoad.command('extend'); changedLoad.advance(.1);
  changedLoad.settings({ reliefPressurePa: 5e6, resistingForceN: 3000 });
  assert.equal(changedLoad.guide.status, 'interrupted'); assert.equal(changedLoad.guide.pressureChangeApplied, false);
});

test('initial neutral at zero chamber pressure cannot pass the pressure-hold lesson', () => {
  const run = experiment('neutral-hold'); run.command('neutral'); run.advance(120);
  assert.equal(run.guide.stepIndex, 0); assert.equal(run.guide.status, 'active');
  run.command('extend'); run.command('neutral'); run.advance(.1);
  assert.equal(run.guide.stepIndex, 0);
});

test('pressure hold confirms motion, explicit isolation, and unchanged pressure during actual circulation', () => {
  const run = experiment('neutral-hold'); run.advance(.1);
  assert.equal(run.guide.stepIndex, 1); assert(run.guide.evidence[0].pressureAPa > 0);
  run.command('neutral'); assert.equal(run.guide.stepIndex, 2);
  const isolation = structuredClone(run.guide.evidence[1]); run.advance(.1);
  assert.equal(run.guide.status, 'completed');
  const held = run.guide.evidence[2]; near(held.pressureAPa, 4000 / (Math.PI * .06 ** 2 / 4));
  assert.equal(held.positionM, isolation.positionM); assert.equal(held.pressureAPa, isolation.pressureAPa);
  assert.equal(held.pumpPressurePa, 0); near(held.returnFlowM3s, .0001);
});

test('releasing neutral discards the old isolation step instead of reusing it', () => {
  const run = experiment('neutral-hold'); run.advance(.1); run.command('neutral'); run.command('extend');
  assert.equal(run.guide.stepIndex, 1); assert.equal(run.guide.evidence.length, 1);
  run.advance(.1); assert.equal(run.guide.status, 'active');
  run.command('neutral'); run.advance(.1); assert.equal(run.guide.status, 'completed');
});

test('a new guide never infers completion from a loaded states historical totals', () => {
  const run = experiment('pressure-limit'); run.advance(120);
  const freshGuide = createGuide('pressure-limit');
  const unchanged = observeGuide(freshGuide, { type: 'command', before: run.state, after: run.state });
  assert.equal(unchanged.stepIndex, 0); assert.deepEqual(unchanged.evidence, []);
  assert.throws(() => createGuide('missing'), RangeError);
});
