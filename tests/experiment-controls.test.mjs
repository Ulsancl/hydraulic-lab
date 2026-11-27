import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExperiment, instantSnapshot, normalizeSettings, reconfigureExperiment, setCommand, step,
  MAX_STEP_SECONDS, RETURN_REFERENCE_FLOW_M3S, SETTINGS_LIMITS_SI,
} from '../src/model.js';
import { createGuide, observeGuide } from '../src/guide.js';
import { createProject, parseProject, serializeProject } from '../src/project.js';

const restriction = 5e5 / RETURN_REFERENCE_FLOW_M3S;
const near = (actual, expected) => assert.ok(
  Math.abs(actual - expected) <= 1e-9 + Math.abs(expected) * 1e-12, `${actual} != ${expected}`,
);

test('pump speed command scales measured flow, travel and accumulated pump volume at a fixed load', () => {
  const full = setCommand(createExperiment(), 'extend');
  const half = setCommand(createExperiment({ pumpCommandRatio: .5 }), 'extend');
  const a = instantSnapshot(full), b = instantSnapshot(half);
  near(b.flowsM3s.pumpFromTank * 60000, 3);
  near(b.velocityMps, a.velocityMps / 2);
  assert.deepEqual(b.portsPa, a.portsPa);
  near(b.powerW.pump, a.powerW.pump / 2);
  const advanced = step(half, .5).state;
  near(advanced.positionM - half.positionM, b.velocityMps * .5);
  near(advanced.cumulativeVolumeM3.pump, b.flowsM3s.pumpFromTank * .5);
  assert.equal(normalizeSettings({ pumpCommandRatio: .1 }).pumpCommandRatio, SETTINGS_LIMITS_SI.pumpCommandRatio.min);
  assert.equal(normalizeSettings({ pumpCommandRatio: 1.5 }).pumpCommandRatio, undefined);
});

test('return restriction raises chamber and pump pressure in both directions at the requested flow', () => {
  for (const command of ['extend', 'retract']) {
    const state = setCommand(createExperiment({ returnRestrictionPaPerM3s: restriction }), command);
    const point = instantSnapshot(state);
    const { capAreaM2, rodAreaM2 } = point.geometry;
    const [driveArea, returnArea, returnPort, sign] = command === 'extend'
      ? [capAreaM2, rodAreaM2, 'B', 1] : [rodAreaM2, capAreaM2, 'A', -1];
    const flow = state.settings.pumpFlowM3s;
    const backpressure = restriction * returnArea * flow / driveArea;
    assert.equal(point.status, 'moving');
    near(point.returnBackpressurePa, backpressure);
    near(point.portsPa[returnPort], backpressure);
    assert.equal(point.portsPa.T, 0);
    near(point.portsPa.P, (4000 + backpressure * returnArea) / driveArea);
    near(point.hydraulicForceN, sign * 4000);
    near(point.velocityMps, sign * flow / driveArea);
    near(point.powerW.returnLoss, backpressure * point.flowsM3s.valveToTank);
    near(point.powerW.pump, point.powerW.load + point.powerW.returnLoss);
    near(step(state, .5).state.energyJ.returnLoss, point.powerW.returnLoss * .5);
  }
});

test('return restriction can divide flow with relief while moving and keep end-stop integration exact', () => {
  const settings = { pumpFlowM3s: 12 / 60000, reliefPressurePa: 3e6, returnRestrictionPaPerM3s: restriction };
  const state = setCommand(createExperiment(settings), 'retract');
  const point = instantSnapshot(state);
  const { capAreaM2, rodAreaM2 } = point.geometry;
  const expectedSupply = (settings.reliefPressurePa - 4000 / rodAreaM2) / (restriction * (capAreaM2 / rodAreaM2) ** 2);
  assert.equal(point.status, 'moving');
  assert.equal(point.portsPa.P, settings.reliefPressurePa);
  assert.ok(point.flowsM3s.reliefToTank > 0);
  near(point.flowsM3s.supplyToValve, expectedSupply);
  near(point.flowsM3s.reliefToTank + expectedSupply, settings.pumpFlowM3s);
  near(point.powerW.pump, point.powerW.load + point.powerW.relief + point.powerW.returnLoss);
  const result = step(state, MAX_STEP_SECONDS);
  const [moving, stopped] = result.interval.segments;
  assert.equal(moving.status, 'moving');
  assert.equal(stopped.status, 'end-stop');
  near(moving.durationS, state.positionM * rodAreaM2 / expectedSupply);
  assert.equal(stopped.powerW.returnLoss, 0);
  assert.equal(stopped.flowsM3s.reliefToTank, settings.pumpFlowM3s);
  near(result.state.energyJ.returnLoss, moving.durationS * point.powerW.returnLoss);
  const blocked = instantSnapshot(setCommand(createExperiment({ ...settings, reliefPressurePa: 2e6 }), 'retract'));
  assert.equal(blocked.status, 'pressure-limit');
  assert.equal(blocked.returnBackpressurePa, 0);
  assert.equal(blocked.powerW.returnLoss, 0);
  assert.equal(blocked.flowsM3s.reliefToTank, settings.pumpFlowM3s);
});

test('neutral keeps both trapped chamber pressures and accounts for the return branch only', () => {
  const configured = createExperiment({ pumpCommandRatio: .75, returnRestrictionPaPerM3s: restriction });
  const moved = step(setCommand(configured, 'extend'), 2).state;
  const held = setCommand(moved, 'neutral');
  const point = instantSnapshot(held);
  near(point.portsPa.A, moved.pressureAPa);
  near(point.portsPa.B, moved.pressureBPa);
  assert.ok(moved.pressureAPa > 0 && moved.pressureBPa > 0);
  near(point.portsPa.P, 3.75e5);
  assert.equal(point.portsPa.P, point.returnBackpressurePa);
  assert.equal(point.powerW.pump, point.powerW.returnLoss);
  assert.equal(point.powerW.load, 0);
  assert.equal(point.powerW.relief, 0);
  const timed = step(held, 2).state;
  assert.equal(timed.positionM, held.positionM);
  near(timed.energyJ.returnLoss - held.energyJ.returnLoss, point.powerW.returnLoss * 2);
  const project = createProject({ state: timed, playbackRate: 2 });
  const restored = parseProject(serializeProject(project));
  assert.deepEqual(restored, project);
  assert.deepEqual(step(restored.state, .5), step(timed, .5));
});

test('stored overrides require bounded SI numbers and coherent energy, and default records load unchanged', () => {
  const legacy = createProject({ state: step(setCommand(createExperiment(), 'extend'), 1).state });
  assert.deepEqual(Object.keys(legacy.state.settings), ['pumpFlowM3s', 'reliefPressurePa', 'resistingForceN']);
  assert.deepEqual(parseProject(JSON.stringify(legacy)), legacy);
  const defaults = structuredClone(legacy);
  Object.assign(defaults.state.settings, { pumpCommandRatio: 1, returnRestrictionPaPerM3s: 0 });
  assert.deepEqual(parseProject(JSON.stringify(defaults)), legacy);
  const extended = createProject({ state: step(createExperiment({ pumpCommandRatio: .75, returnRestrictionPaPerM3s: restriction }), 1).state });
  for (const change of [
    s => { s.settings.pumpCommandRatio = .49; },
    s => { s.settings.pumpCommandRatio = '0.75'; },
    s => { s.settings.returnRestrictionPaPerM3s = restriction + 1; },
    s => { delete s.settings.pumpCommandRatio; },
    s => { delete s.settings.returnRestrictionPaPerM3s; },
    s => { delete s.energyJ.returnLoss; },
    s => { s.energyJ.returnLoss += 1; },
  ]) {
    const invalid = structuredClone(extended);
    change(invalid.state);
    assert.throws(() => parseProject(JSON.stringify(invalid)), { code: 'INVALID_STATE' });
  }
});

test('a guided comparison cannot approve changing the pressure and an experimental adjustment together', () => {
  const guide = createGuide('pressure-limit');
  guide.stepIndex = 2;
  const before = createExperiment({ reliefPressurePa: 2e6 });
  for (const extra of [{ pumpCommandRatio: .5 }, { returnRestrictionPaPerM3s: restriction }]) {
    const after = reconfigureExperiment(before, { reliefPressurePa: 5e6, ...extra });
    const compared = observeGuide(guide, { type: 'settings', before, after });
    assert.equal(compared.status, 'interrupted');
    assert.equal(compared.pressureChangeApplied, false);
  }
});
