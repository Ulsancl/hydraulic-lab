import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VERSION, DIMENSIONS_SI, DEFAULT_SETTINGS, SETTINGS_LIMITS_SI,
  MAX_STEP_SECONDS, MAX_SIMULATION_TIME_S, PRESSURE_EPSILON_PA,
  normalizeSettings, createExperiment, setCommand, reconfigureExperiment,
  instantSnapshot, step, assertValidState } from '../src/model.js';

const Ac = Math.PI * .060 ** 2 / 4, Ar = Math.PI * (.060 ** 2 - .035 ** 2) / 4;
const Ad = Math.PI * .035 ** 2 / 4, stroke = .300;
const close = (a, b, abs = 1e-10, rel = 1e-10) => assert(Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b)), `${a} != ${b}`);
const active = (command = 'extend', settings = {}, positionM = .15) => setCommand(createExperiment(settings, { positionM }), command);
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };

test('fixed SI dimensions derive actual end chamber volumes and immutable settings limits', () => {
  assert.equal(MODEL_VERSION, 'hydraulic-quasistatic-1');
  assert.equal(DIMENSIONS_SI.boreM, .060); assert.equal(DIMENSIONS_SI.rodDiameterM, .035);
  assert.equal(DIMENSIONS_SI.strokeM, .300); assert.equal(DIMENSIONS_SI.pistonThicknessM, .018);
  assert.equal(DIMENSIONS_SI.capDeadLengthM, .006); assert.equal(DIMENSIONS_SI.rodDeadLengthM, .006);
  close(DIMENSIONS_SI.capDeadVolumeM3, Ac * .006); close(DIMENSIONS_SI.rodDeadVolumeM3, Ar * .006);
  assert(Object.isFrozen(DIMENSIONS_SI)); assert(Object.isFrozen(DEFAULT_SETTINGS));
  assert(Object.values(SETTINGS_LIMITS_SI).every(Object.isFrozen));
  assert.equal(MAX_STEP_SECONDS, 3600); assert.equal(MAX_SIMULATION_TIME_S, 1e9); assert.equal(PRESSURE_EPSILON_PA, .01);
});

test('live normalization is finite, bounded, noncoercive and independent of its source', () => {
  assert.deepEqual(normalizeSettings(), { pumpFlowM3s: .0001, reliefPressurePa: 5e6, resistingForceN: 4000 });
  assert.deepEqual(normalizeSettings(null), normalizeSettings());
  assert.deepEqual(normalizeSettings({ pumpFlowM3s: '0.0002', reliefPressurePa: NaN, resistingForceN: Infinity }), normalizeSettings());
  const source = freeze({ pumpFlowM3s: 1, reliefPressurePa: -1, resistingForceN: 20000 });
  assert.deepEqual(normalizeSettings(source), { pumpFlowM3s: 12 / 60000, reliefPressurePa: 2e6, resistingForceN: 10000 });
  assert.equal(normalizeSettings({ pumpFlowM3s: -1 }).pumpFlowM3s, 2 / 60000);
  assert.equal(normalizeSettings({ resistingForceN: -1 }).resistingForceN, 0);
  assert.equal(source.pumpFlowM3s, 1);
});

test('new experiments begin neutral and normalize only their live initial position', () => {
  const state = createExperiment(); assert.equal(assertValidState(state), state);
  assert.equal(state.command, 'neutral'); assert.equal(state.positionM, .15); assert.equal(state.timeS, 0);
  assert.equal(state.pressureAPa, 0); assert.equal(state.pressureBPa, 0);
  assert.deepEqual(state.energyJ, { pump: 0, load: 0, relief: 0 });
  assert.equal(createExperiment({}, { positionM: -1 }).positionM, 0);
  assert.equal(createExperiment({}, { positionM: 1 }).positionM, .3);
  assert.equal(createExperiment({}, { positionM: '0.2' }).positionM, .15);
  assert.equal(Object.is(createExperiment({}, { positionM: -0 }).positionM, -0), false);
});

test('tandem-centre neutral circulates pump flow without moving either chamber', () => {
  const s = instantSnapshot(createExperiment());
  assert.deepEqual(s.connections, ['P-T']); assert.equal(s.status, 'neutral'); assert.equal(s.direction, 0);
  assert.deepEqual(s.portsPa, { P: 0, T: 0, A: 0, B: 0 });
  assert.deepEqual(s.flowsM3s, { pumpFromTank: .0001, supplyToValve: .0001, valveToTank: .0001, reliefToTank: 0, capIntoCylinder: 0, rodIntoCylinder: 0, tankNetInto: 0 });
  assert.deepEqual(s.powerW, { pump: 0, load: 0, relief: 0 });
  assert.equal(s.requiredPressurePa, null); assert.equal(s.availableForceN, null);
  assert.equal(s.chamberPressureMeaning, 'isolated-ideal-hold');
});

test('forward and reverse pressure, speed, force and return flow use their different effective areas', () => {
  for (const [command, sign, area, returnArea, links] of [
    ['extend', 1, Ac, Ar, ['P-A', 'B-T']], ['retract', -1, Ar, Ac, ['P-B', 'A-T']],
  ]) {
    const s = instantSnapshot(active(command));
    assert.equal(s.status, 'moving'); assert.equal(s.direction, sign); assert.deepEqual(s.connections, links);
    close(s.velocityMps, sign * .0001 / area); close(s.portsPa.P, 4000 / area);
    close(s.hydraulicForceN, sign * 4000); close(s.availableForceN, 5e6 * area);
    close(s.flowsM3s.valveToTank, .0001 * returnArea / area);
    close(s.flowsM3s.capIntoCylinder, Ac * s.velocityMps);
    close(s.flowsM3s.rodIntoCylinder, -Ar * s.velocityMps);
    assert.equal(s.flowsM3s.reliefToTank, 0);
    close(s.powerW.pump, 4000 * Math.abs(s.velocityMps)); close(s.powerW.load, s.powerW.pump);
    assert.equal(s.powerW.relief, 0);
  }
  close(instantSnapshot(active()).velocityMps * 1000, 35.3677651315323);
  close(Math.abs(instantSnapshot(active('retract')).velocityMps) * 1000, 53.61008609411213);
});

test('fluid inventory and tank displacement equal the explicit cylinder geometry at every position', () => {
  const total = Ac * .006 + Ar * .006 + Ar * .3 + .006;
  for (const x of [0, .03, .15, .27, .3]) {
    const s = instantSnapshot(createExperiment({}, { positionM: x })), v = s.volumesM3;
    close(v.cap, Ac * (.006 + x)); close(v.rod, Ar * (.006 + .3 - x));
    close(v.tank, .006 - Ad * x); close(v.cap + v.rod + v.tank, total); close(v.totalFluid, total);
    assert(v.cap > 0 && v.rod > 0 && v.tank > 0);
    close(s.geometry.capAreaM2, Ac); close(s.geometry.rodAreaM2, Ar); close(s.geometry.displacedRodAreaM2, Ad);
  }
});

test('port flow balances hold for motion, neutral, pressure stall and an end stop', () => {
  const states = [createExperiment(), active(), active('retract'), active('retract', { reliefPressurePa: 2e6 }), active('extend', {}, .3)];
  for (const state of states) {
    const s = instantSnapshot(state), q = s.flowsM3s;
    close(q.pumpFromTank, q.supplyToValve + q.reliefToTank);
    close(q.supplyToValve, q.valveToTank + q.capIntoCylinder + q.rodIntoCylinder);
    close(q.tankNetInto, q.valveToTank + q.reliefToTank - q.pumpFromTank);
    close(q.tankNetInto + q.capIntoCylinder + q.rodIntoCylinder, 0);
    close(q.tankNetInto, -Ad * s.velocityMps);
  }
});

test('pressure is set by the resisting load and does not default to the relief limit', () => {
  for (const force of [0, 1000, 4000]) {
    const s = instantSnapshot(active('extend', { resistingForceN: force }));
    close(s.portsPa.P, force / Ac); assert(s.portsPa.P < 5e6);
    close(s.velocityMps, .0001 / Ac);
  }
  const result = step(active('extend', { resistingForceN: 0 }), .1);
  assert(result.state.positionM > .15); assert.deepEqual(result.state.energyJ, { pump: 0, load: 0, relief: 0 });
});

test('pressure-limited capacity can move forward while reverse remains stalled at the same load', () => {
  const settings = { resistingForceN: 4000, reliefPressurePa: 2e6 };
  assert.equal(instantSnapshot(active('extend', settings)).status, 'moving');
  const state = active('retract', settings), s = instantSnapshot(state), result = step(state, 2);
  assert.equal(s.status, 'pressure-limit'); assert.equal(s.velocityMps, 0);
  assert.equal(s.portsPa.B, 2e6); assert.equal(s.portsPa.A, 0); assert.equal(s.flowsM3s.reliefToTank, .0001);
  assert.equal(result.state.positionM, state.positionM);
  close(result.interval.deltaEnergyJ.relief, 2e6 * .0001 * 2); assert.equal(result.interval.deltaEnergyJ.load, 0);
});

test('the exact force limit and 0.01 Pa numerical boundary choose the documented stationary branch', () => {
  for (const [command, area] of [['extend', Ac], ['retract', Ar]]) {
    for (const offset of [0, -.005, .02]) {
      const s = instantSnapshot(active(command, { reliefPressurePa: 2e6, resistingForceN: (2e6 + offset) * area }));
      assert.equal(s.status, 'pressure-limit'); assert.equal(s.velocityMps, 0);
    }
    assert.equal(instantSnapshot(active(command, { reliefPressurePa: 2e6, resistingForceN: (2e6 - .02) * area })).status, 'moving');
  }
});

test('an end stop blocks only the outward command and reports its own reason', () => {
  for (const [x, outward, inward] of [[0, 'retract', 'extend'], [.3, 'extend', 'retract']]) {
    const held = active(outward, {}, x), s = instantSnapshot(held);
    assert.equal(s.status, 'end-stop'); assert.equal(s.velocityMps, 0); assert.equal(s.portsPa.P, 5e6);
    assert.equal(step(held, 1).state.positionM, x);
    assert.equal(instantSnapshot(setCommand(held, inward)).status, 'moving');
  }
});

test('a moving interval before the end uses load work and conserves fluid volume', () => {
  const state = active(), { state: after, interval } = step(state, .75), distance = .0001 / Ac * .75;
  assert.equal(interval.segments.length, 1); assert.equal(interval.segments[0].status, 'moving');
  close(after.positionM, .15 + distance); close(after.energyJ.load, 4000 * distance);
  close(after.energyJ.pump, after.energyJ.load); assert.equal(after.energyJ.relief, 0);
  close(interval.deltaVolumeM3.tankNetInto, -Ad * distance); close(after.cumulativeVolumeM3.pump, .0001 * .75);
});

test('exact end arrival has zero relief duration even though the final snapshot shows full relief flow', () => {
  for (const [command, start] of [['extend', 0], ['retract', .3]]) {
    const state = active(command, {}, start), speed = Math.abs(instantSnapshot(state).velocityMps);
    const result = step(state, .3 / speed);
    assert.equal(result.interval.segments.length, 1); assert.equal(result.interval.segments[0].status, 'moving');
    assert.equal(result.interval.deltaVolumeM3.relief, 0); assert.equal(result.interval.deltaEnergyJ.relief, 0);
    assert.equal(result.state.positionM, command === 'extend' ? .3 : 0);
    assert.equal(instantSnapshot(result.state).status, 'end-stop');
    assert.equal(instantSnapshot(result.state).flowsM3s.reliefToTank, .0001);
    close(result.state.energyJ.load, 4000 * .3);
  }
});

test('a frame spanning end arrival splits movement and relief and integrates each power for its duration', () => {
  for (const [command, area] of [['extend', Ac], ['retract', Ar]]) {
    const distance = .0001 / area;
    const start = command === 'extend' ? .3 - distance : distance;
    const { state, interval } = step(active(command, {}, start), 2);
    assert.equal(interval.segments.length, 2); assert.deepEqual(interval.segments.map(s => s.status), ['moving', 'end-stop']);
    close(interval.segments[0].durationS, 1); close(interval.segments[1].durationS, 1);
    close(interval.deltaEnergyJ.load, 4000 * distance); close(interval.deltaEnergyJ.relief, 5e6 * .0001);
    close(interval.deltaEnergyJ.pump, 4000 * distance + 500);
    close(interval.deltaVolumeM3.pump, .0002); close(interval.deltaVolumeM3.relief, .0001);
    close(interval.deltaVolumeM3.tankNetInto, -Ad * (state.positionM - start));
    assert(interval.deltaEnergyJ.pump < instantSnapshot(state).powerW.pump * 2, 'Final snapshot must not be applied to the entire frame');
  }
});

test('neutral preserves isolated chamber pressure while circulation adds no ideal hydraulic energy', () => {
  for (const command of ['extend', 'retract']) {
    const running = step(active(command), .2).state, neutral = setCommand(running, 'neutral'), after = step(neutral, 30).state;
    assert.equal(after.positionM, running.positionM); assert.equal(after.pressureAPa, running.pressureAPa); assert.equal(after.pressureBPa, running.pressureBPa);
    assert.deepEqual(after.energyJ, running.energyJ); close(after.cumulativeVolumeM3.pump - running.cumulativeVolumeM3.pump, .003);
    assert.equal(instantSnapshot(after).portsPa.P, 0); assert.equal(instantSnapshot(after).chamberPressureMeaning, 'isolated-ideal-hold');
  }
});

test('command transitions change steady pressures without time, invented vent energy or loss of accumulated work', () => {
  const old = step(active(), .25).state, reversed = setCommand(old, 'retract');
  assert.equal(reversed.positionM, old.positionM); assert.equal(reversed.timeS, old.timeS);
  assert.deepEqual(reversed.energyJ, old.energyJ); assert.deepEqual(reversed.cumulativeVolumeM3, old.cumulativeVolumeM3);
  assert.equal(reversed.pressureAPa, 0); close(reversed.pressureBPa, 4000 / Ar);
});

test('isolated pressure must be attainable at the saved position while genuine stops and new experiments remain valid', () => {
  for (const [command, pressureKey, end] of [['extend', 'pressureAPa', .3], ['retract', 'pressureBPa', 0]]) {
    const impossible = createExperiment({}, { positionM: .15 }); impossible[pressureKey] = 5e6;
    assert.throws(() => assertValidState(impossible), RangeError);
    const endNeutral = setCommand(active(command, {}, end), 'neutral');
    assert.equal(endNeutral[pressureKey], 5e6); assertValidState(endNeutral);
    const stalledNeutral = setCommand(active(command, { resistingForceN: 10000, reliefPressurePa: 2e6 }, .15), 'neutral');
    assert.equal(stalledNeutral[pressureKey], 2e6); assertValidState(stalledNeutral);
    assertValidState(createExperiment({}, { positionM: end }));
  }
});

test('new comparison settings explicitly reset the experiment at the same position and preserve the old state', () => {
  const old = freeze(setCommand(step(active(), 10).state, 'neutral')), before = structuredClone(old);
  const reset = reconfigureExperiment(old, { resistingForceN: 7000, pumpFlowM3s: 3 / 60000 });
  assert.deepEqual(old, before); assert.equal(reset.positionM, old.positionM); assert.equal(reset.command, 'neutral');
  assert.equal(reset.settings.resistingForceN, 7000); assert.equal(reset.settings.reliefPressurePa, old.settings.reliefPressurePa);
  assert.equal(reset.timeS, 0); assert.equal(reset.pressureAPa, 0); assert.equal(reset.pressureBPa, 0);
  assert.deepEqual(reset.energyJ, { pump: 0, load: 0, relief: 0 });
  assert.deepEqual(instantSnapshot(reset).volumesM3, instantSnapshot(old).volumesM3);
});

test('irregular frame partitions preserve position, energy and cumulative volume across end arrival', () => {
  for (const command of ['extend', 'retract']) {
    const start = active(command, { pumpFlowM3s: 7 / 60000, resistingForceN: 4321 }), whole = step(start, 17.25).state;
    const weights = Array.from({ length: 401 }, (_, i) => i % 11 + 1), total = weights.reduce((a, b) => a + b, 0);
    let divided = start;
    for (const weight of weights) divided = step(divided, 17.25 * weight / total).state;
    close(divided.positionM, whole.positionM); close(divided.timeS, whole.timeS);
    for (const key of ['pump', 'load', 'relief']) close(divided.energyJ[key], whole.energyJ[key], 1e-7);
    for (const key of ['pump', 'relief']) close(divided.cumulativeVolumeM3[key], whole.cumulativeVolumeM3[key], 1e-12);
    assert.deepEqual(instantSnapshot(divided).volumesM3, instantSnapshot(whole).volumesM3);
  }
});

test('many full strokes keep geometry bounded and independent energy and fluid balances consistent', () => {
  let state = createExperiment({}, { positionM: 0 });
  for (let i = 0; i < 1000; i++) {
    state = step(setCommand(state, i % 2 === 0 ? 'extend' : 'retract'), 10).state;
    assert.equal(state.positionM, i % 2 === 0 ? .3 : 0);
    const snapshot = instantSnapshot(state), volumes = snapshot.volumesM3;
    close(volumes.cap + volumes.rod + volumes.tank, volumes.totalFluid);
    close(state.energyJ.load, (i + 1) * 4000 * .3, 1e-6);
    close(state.energyJ.pump, state.energyJ.load + state.energyJ.relief, 1e-6);
    close(state.energyJ.relief, state.cumulativeVolumeM3.relief * 5e6, 1e-6);
    assert(Number.isFinite(state.energyJ.pump));
  }
  close(state.cumulativeVolumeM3.pump, 1);
});

test('zero time changes nothing and invalid durations or time overflow reject without partial mutation', () => {
  const state = freeze(active()), before = structuredClone(state), zero = step(state, 0);
  assert.deepEqual(zero.state, state); assert.deepEqual(zero.interval.segments, []);
  assert.deepEqual(zero.interval.deltaEnergyJ, { pump: 0, load: 0, relief: 0 });
  for (const dt of [-1, Infinity, NaN, '1', 3600.01]) assert.throws(() => step(state, dt), RangeError);
  assert.deepEqual(state, before);
  const atLimit = createExperiment(); atLimit.timeS = 1e9; atLimit.cumulativeVolumeM3.pump = .0001 * 1e9;
  assertValidState(atLimit); assert.throws(() => step(atLimit, 1), RangeError);
  assert.deepEqual(step(atLimit, 0).state, atLimit);
});

test('strict state validation rejects inconsistent file values instead of normalizing them', () => {
  const baseline = step(active(), .5).state;
  const edits = [
    s => { s.extra = 1; }, s => { s.settings.resistingForceN = '4000'; },
    s => { s.modelVersion = 'unknown'; }, s => { s.command = 'float'; },
    s => { s.positionM = .31; }, s => { s.timeS = -0; }, s => { s.energyJ.pump = Infinity; },
    s => { s.pressureAPa = 1; }, s => { s.pressureBPa = 1; },
    s => { s.cumulativeVolumeM3.pump *= 2; }, s => { s.cumulativeVolumeM3.relief = .001; },
    s => { s.energyJ.load += 10; }, s => { s.energyJ.relief = 10; },
  ];
  for (const edit of edits) { const state = structuredClone(baseline); edit(state); assert.throws(() => assertValidState(state), error => error instanceof TypeError || error instanceof RangeError); }
  const neutral = setCommand(baseline, 'neutral'); neutral.pressureBPa = 1;
  assert.throws(() => assertValidState(neutral), RangeError);
  const changedLoad = setCommand(baseline, 'neutral'); changedLoad.settings.resistingForceN = 5000;
  assert.throws(() => assertValidState(changedLoad), RangeError);
  assert.throws(() => setCommand(baseline, 'constructor'), RangeError);
});

test('snapshots, outputs and nested settings never share mutable state with their inputs', () => {
  const state = freeze(active()), before = structuredClone(state), snap = instantSnapshot(state);
  snap.portsPa.A = -1; snap.flowsM3s.pumpFromTank = -1; snap.geometry.capAreaM2 = -1; snap.connections[0] = 'wrong';
  const result = step(state, .1); result.state.settings.pumpFlowM3s = 10; result.interval.segments[0].portsPa.A = -1;
  assert.deepEqual(state, before); assertValidState(state);
  const another = createExperiment(); another.energyJ.load = 5;
  assert.equal(createExperiment().energyJ.load, 0); assert.equal(DEFAULT_SETTINGS.pumpFlowM3s, .0001);
});
