import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS } from '../src/lessons.js';
import { createExperiment, setCommand, instantSnapshot, step } from '../src/model.js';

const near = (actual, expected, tolerance = 1e-10) => assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const begin = id => {
  const lesson = LESSONS.find(value => value.id === id);
  return setCommand(createExperiment(lesson.settings, { positionM: lesson.positionM }), lesson.initialCommand);
};

test('speed lesson completes both physical strokes with faster retraction and unchanged total oil', () => {
  const initial = begin('speed-ratio'), original = instantSnapshot(initial);
  // Independent circular-area calculation using the specified 60/35 mm geometry.
  const cap = Math.PI * .06 ** 2 / 4, rod = Math.PI * (.06 ** 2 - .035 ** 2) / 4;
  const outwardTime = cap * .3 / .0001, inwardTime = rod * .3 / .0001;
  assert(inwardTime < outwardTime);
  const extended = step(initial, outwardTime + 1e-8).state;
  near(extended.positionM, .3); near(extended.energyJ.load, 4000 * .3, 1e-8);
  const returning = setCommand(extended, 'retract');
  near(Math.abs(instantSnapshot(returning).velocityMps) / original.velocityMps, cap / rod);
  const retracted = step(returning, inwardTime + 1e-8).state;
  near(retracted.positionM, 0); near(retracted.energyJ.load, 2 * 4000 * .3, 1e-8);
  near(instantSnapshot(retracted).volumesM3.totalFluid, original.volumesM3.totalFluid);
  near(instantSnapshot(retracted).volumesM3.tank, original.volumesM3.tank);
});

test('pressure-limit lesson stalls in retraction but can extend against the same resistance', () => {
  const initial = begin('pressure-limit'), stalled = instantSnapshot(initial);
  assert.equal(stalled.status, 'pressure-limit'); near(stalled.velocityMps, 0);
  near(stalled.portsPa.P, 2000000); near(stalled.flowsM3s.reliefToTank, .0001);
  const held = step(initial, 2).state;
  near(held.positionM, .15); near(held.energyJ.relief, 2000000 * .0001 * 2);
  const extending = setCommand(held, 'extend'), moving = instantSnapshot(extending);
  assert.equal(moving.status, 'moving'); assert(moving.velocityMps > 0);
  assert(moving.portsPa.P < 2000000); near(moving.hydraulicForceN, 4000, 1e-8);
  assert(step(extending, 2).state.positionM > .15);
});

test('neutral lesson retains chamber pressure while the pump circulates to the tank', () => {
  const moving = step(begin('neutral-hold'), 2).state;
  const before = instantSnapshot(moving);
  const neutral = setCommand(moving, 'neutral'), held = step(neutral, 120).state;
  const after = instantSnapshot(held);
  assert.equal(after.status, 'neutral'); near(held.positionM, moving.positionM);
  near(after.portsPa.P, 0); near(after.portsPa.A, before.portsPa.A); near(after.portsPa.B, before.portsPa.B);
  near(after.flowsM3s.supplyToValve, .0001); near(after.flowsM3s.valveToTank, .0001);
  near(after.flowsM3s.tankNetInto, 0);
  assert.deepEqual(held.energyJ, moving.energyJ);
  near(after.volumesM3.totalFluid, before.volumesM3.totalFluid);
});
