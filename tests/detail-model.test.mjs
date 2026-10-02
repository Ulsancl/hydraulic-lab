import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, setCommand, reconfigureExperiment, instantSnapshot, step, DIMENSIONS_SI,
  SETTINGS_LIMITS_SI, PRESSURE_EPSILON_PA } from '../src/model.js';
import { COMPONENTS } from '../src/geometry.js';
import { hydraulicDetail } from '../src/detail-model.js';
import { describeHydraulicDetail } from '../src/detail-readouts.js';

const near = (actual, expected, absolute = 1e-10, relative = 1e-10) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= absolute + relative * Math.max(Math.abs(actual), Math.abs(expected)), `${actual} != ${expected}`);
const active = (command = 'extend', settings = {}, positionM = .15) => setCommand(createExperiment(settings, { positionM }), command);
const values = result => Object.fromEntries(result.facts.map(f => [f.label, f]));
const Ac = Math.PI * 30 ** 2 / 1e6, Ar = Math.PI * (30 ** 2 - 17.5 ** 2) / 1e6;

test('actual signed face forces reconstruct net force while pressure-limit capacities stay separate', () => {
  for (const command of ['extend', 'retract']) for (const forceN of [0, 4000, 10000]) {
    const state = active(command, { resistingForceN: forceN }), s = instantSnapshot(state), d = hydraulicDetail(state, s);
    near(d.geometry.capAreaM2, Ac); near(d.geometry.rodAreaM2, Ar);
    near(d.force.capN, s.portsPa.A * Ac); near(d.force.rodN, -s.portsPa.B * Ar);
    near(d.force.netHydraulicN, d.force.capN + d.force.rodN); near(d.force.netHydraulicN, s.hydraulicForceN);
    near(d.force.extendLimitN, 5e6 * Ac); near(d.force.retractLimitN, 5e6 * Ar);
    near(d.force.commandLimitN, command === 'extend' ? d.force.extendLimitN : d.force.retractLimitN);
    if (s.status === 'moving') near(d.force.netHydraulicN, (command === 'extend' ? 1 : -1) * forceN);
    else assert.ok(Math.abs(d.force.netHydraulicN) < forceN);
    if (forceN === 4000) assert.ok(Math.abs(d.force.netHydraulicN) < d.force.commandLimitN);
    near(d.force.pressureMarginPa, state.settings.reliefPressurePa - s.requiredPressurePa);
  }
});

test('equal supplied volume produces different travel and return volume with the same area ratio', () => {
  const dt = .5, extension = active('extend'), retraction = active('retract');
  const a = step(extension, dt).state, b = step(retraction, dt).state;
  const dxA = a.positionM - extension.positionM, dxB = retraction.positionM - b.positionM;
  const d = hydraulicDetail(extension), Q = extension.settings.pumpFlowM3s;
  near(dxB / dxA, d.geometry.retractToExtendSpeedRatio);
  near(Q * dt, Ac * dxA); near(Q * dt, Ar * dxB);
  for (const [state, next] of [[extension, a], [retraction, b]]) {
    const start = instantSnapshot(state), finish = instantSnapshot(next), details = hydraulicDetail(state);
    const returned = state.command === 'extend' ? start.volumesM3.rod - finish.volumesM3.rod : start.volumesM3.cap - finish.volumesM3.cap;
    near(details.circuit.returnCombinedM3s * dt, returned);
    near(finish.volumesM3.tank - start.volumesM3.tank, returned - Q * dt);
  }
  assert.ok(hydraulicDetail(retraction).circuit.returnCombinedM3s > Q);
  assert.ok(hydraulicDetail(extension).circuit.returnCombinedM3s < Q);
});

test('chamber and tank rates match finite changes in independently stepped volumes', () => {
  const states = [createExperiment(), active('extend'), active('retract'), active('retract', { resistingForceN: 10000 }), active('extend', {}, .3), active('retract', {}, 0)];
  const h = 1e-4;
  for (const state of states) {
    const s = instantSnapshot(state), d = hydraulicDetail(state), next = instantSnapshot(step(state, h).state);
    near((next.volumesM3.cap - s.volumesM3.cap) / h, d.chambers.cap.volumeRateM3s, 2e-15);
    near((next.volumesM3.rod - s.volumesM3.rod) / h, d.chambers.rod.volumeRateM3s, 2e-15);
    near((next.volumesM3.tank - s.volumesM3.tank) / h, d.tank.rateM3s, 2e-14);
    near(d.balance.volumeResidualM3, 0); near(d.balance.rateResidualM3s, 0);
    near(d.balance.pumpBranchResidualM3s, 0); near(d.balance.tankResidualM3s, 0);
    near(d.balance.cylinderPowerResidualW, 0);
    near(d.power.cylinderW, d.chambers.cap.signedPowerIntoW + d.chambers.rod.signedPowerIntoW);
    near(d.power.cylinderW, d.force.netHydraulicN * d.motion.velocityMps);
    near(d.power.cylinderW, d.power.loadW);
  }
});

test('time to end predicts the exact model event and is absent when no travel occurs', () => {
  for (const command of ['extend', 'retract']) for (const positionM of [0, .071, .299, .3]) {
    const state = active(command, {}, positionM), d = hydraulicDetail(state);
    if (!d.motion.moving) {
      assert.equal(d.motion.distanceToStopM, null); assert.equal(d.motion.timeToStopS, null); continue;
    }
    const distance = command === 'extend' ? .3 - positionM : positionM;
    near(d.motion.distanceToStopM, distance);
    near(d.motion.timeToStopS, distance * (command === 'extend' ? Ac : Ar) / state.settings.pumpFlowM3s);
    const before = step(state, d.motion.timeToStopS * .999).state;
    assert.equal(instantSnapshot(before).status, 'moving');
    const arrived = step(state, d.motion.timeToStopS).state;
    assert.equal(arrived.positionM, command === 'extend' ? .3 : 0);
    assert.equal(hydraulicDetail(arrived).motion.timeToStopS, null);
  }
  for (const state of [createExperiment(), active('retract', { resistingForceN: 10000 })]) {
    const rows = values(describeHydraulicDetail('load-carriage', state));
    assert.equal(rows['행정 끝 도달 예상'].value, '이동 중 아님');
    assert.equal(rows['이동 방향 끝까지 거리'].value, '이동 중 아님');
  }
});

test('held neutral retains signed force and chamber pressure with zero chamber flow and hydraulic power', () => {
  for (const powered of [active('extend'), active('retract'), active('extend', {}, .3), active('retract', { resistingForceN: 10000 })]) {
    const before = hydraulicDetail(powered), state = setCommand(powered, 'neutral'), d = hydraulicDetail(state);
    assert.equal(d.circuit.isolatedHold, true);
    near(d.force.netHydraulicN, before.force.netHydraulicN);
    near(d.chambers.cap.pressurePa, before.chambers.cap.pressurePa);
    near(d.chambers.rod.pressurePa, before.chambers.rod.pressurePa);
    assert.equal(d.force.commandLimitN, null); assert.equal(d.force.pressureMarginPa, null);
    assert.equal(d.chambers.cap.volumeRateM3s, 0); assert.equal(d.chambers.rod.volumeRateM3s, 0);
    assert.equal(d.power.pumpW, 0); assert.equal(d.power.loadW, 0); assert.equal(d.power.reliefW, 0);
    near(d.power.cylinderW, 0); assert.equal(d.power.loadShare, null);
    near(d.circuit.flowsM3s.supplyToValve, state.settings.pumpFlowM3s);
    near(d.circuit.returnCombinedM3s, state.settings.pumpFlowM3s);
    const later = step(state, 2).state;
    assert.equal(later.pressureAPa, state.pressureAPa); assert.equal(later.pressureBPa, state.pressureBPa);
    assert.deepEqual(later.energyJ, state.energyJ);
    assert.match(describeHydraulicDetail('piston', state).note, /압력.*유지/);
  }
});

test('a step that crosses the end splits load work and relief work instead of using the final power for all time', () => {
  for (const command of ['extend', 'retract']) {
    const state = active(command, {}, command === 'extend' ? .295 : .005), d = hydraulicDetail(state), extra = .3;
    const result = step(state, d.motion.timeToStopS + extra), after = hydraulicDetail(result.state);
    const loadWork = state.settings.resistingForceN * .005;
    const reliefWork = state.settings.reliefPressurePa * state.settings.pumpFlowM3s * extra;
    near(after.energy.loadJ, loadWork); near(after.energy.reliefJ, reliefWork);
    near(after.energy.pumpJ, loadWork + reliefWork); near(after.balance.energyResidualJ, 0);
    assert.equal(after.power.loadW, 0); near(after.power.reliefW, after.power.pumpW);
    assert.ok(Math.abs(after.energy.pumpJ - after.power.pumpW * result.interval.durationS) > 1);
    assert.equal(after.motion.timeToStopS, null);
    near(after.circuit.flowsM3s.supplyToValve, 0); near(after.circuit.flowsM3s.valveToTank, 0);
    near(after.circuit.returnCombinedM3s, state.settings.pumpFlowM3s);
  }
});

test('pressure tolerance and unloaded motion keep finite limits without inventing a zero-over-zero efficiency', () => {
  for (const command of ['extend', 'retract']) {
    const area = command === 'extend' ? Ac : Ar, limit = 2e6;
    const boundary = active(command, { reliefPressurePa: limit, resistingForceN: (limit - PRESSURE_EPSILON_PA / 2) * area });
    const blocked = hydraulicDetail(boundary);
    assert.equal(blocked.status, 'pressure-limit'); assert.equal(blocked.power.loadShare, 0);
    assert.equal(blocked.motion.timeToStopS, null);
    const moving = hydraulicDetail(active(command, { reliefPressurePa: limit, resistingForceN: (limit - PRESSURE_EPSILON_PA * 2) * area }));
    assert.equal(moving.status, 'moving'); near(moving.power.loadShare, 1);
    const unloaded = hydraulicDetail(active(command, { resistingForceN: 0 }));
    assert.ok(Math.abs(unloaded.motion.velocityMps) > 0); near(unloaded.force.netHydraulicN, 0);
    assert.equal(unloaded.power.pumpW, 0); assert.equal(unloaded.power.loadShare, null);
    assert.equal(Object.hasOwn(unloaded.power, 'efficiency'), false);
  }
});

test('line and port facts distinguish the pump tee and combined return in correct displayed units', () => {
  for (const state of [active('extend'), active('retract'), createExperiment(), active('extend', {}, .3)]) {
    const d = hydraulicDetail(state), p = values(describeHydraulicDetail('line-P', state));
    near(p['펌프에서 분기 전 유량'].value, state.settings.pumpFlowM3s * 60000);
    near(p['방향밸브 P로 들어가는 유량'].value + p['릴리프로 나뉘는 유량'].value, p['펌프에서 분기 전 유량'].value);
    for (const [id, chamber, force] of [['line-A', 'cap', d.force.capN], ['line-B', 'rod', d.force.rodN]]) {
      const rows = values(describeHydraulicDetail(id, state));
      near(rows['액실 유량 · 유입 +'].value, d.chambers[chamber].volumeRateM3s * 60000);
      near(rows['연결 액실 현재 체적'].value, d.chambers[chamber].volumeM3 * 1e6);
      near(rows['피스톤에 기여하는 힘'].value, force / 1000);
      assert.equal(rows['연결 액실 현재 체적'].unit, 'mL');
    }
    const portT = values(describeHydraulicDetail('port-T', state)), filter = values(describeHydraulicDetail('return-filter', state));
    near(portT['방향밸브 T 복귀 유량'].value + portT['외부에서 합류하는 릴리프'].value, filter['필터·탱크 합류 유량'].value);
    near(filter['필터·탱크 합류 유량'].value, d.circuit.returnCombinedM3s * 60000);
  }
});

test('full command histories close volume, branch power and cumulative energy across valid setting boundaries', () => {
  for (const Q of Object.values(SETTINGS_LIMITS_SI.pumpFlowM3s)) for (const limit of Object.values(SETTINGS_LIMITS_SI.reliefPressurePa)) for (const F of [0, 4000, 10000]) {
    let state = createExperiment({ pumpFlowM3s: Q, reliefPressurePa: limit, resistingForceN: F });
    for (const [command, seconds] of [['extend', 15], ['neutral', 3], ['retract', 15], ['neutral', 2], ['extend', .17]]) {
      state = setCommand(state, command);
      const before = hydraulicDetail(state), next = step(state, seconds).state, after = hydraulicDetail(next);
      near(after.energy.loadJ - before.energy.loadJ, F * Math.abs(next.positionM - state.positionM), 1e-8);
      near(after.energy.reliefJ, limit * next.cumulativeVolumeM3.relief, 1e-8);
      near(after.power.residualW, 0, 1e-8); near(after.balance.energyResidualJ, 0, 1e-8);
      near(after.balance.volumeResidualM3, 0); near(after.balance.rateResidualM3s, 0);
      near(after.balance.cylinderPowerResidualW, 0, 1e-8);
      state = next;
    }
  }
});

test('all 34 component facts and derived results preserve strict original state and snapshots', () => {
  assert.equal(COMPONENTS.length, 34);
  const freeze = object => { Object.freeze(object); for (const child of Object.values(object)) if (child && typeof child === 'object') freeze(child); return object; };
  for (const command of ['extend', 'retract', 'neutral']) {
    const state = freeze(setCommand(step(active('extend'), .7).state, command));
    const snapshot = freeze(instantSnapshot(state)), savedState = structuredClone(state), savedSnapshot = structuredClone(snapshot);
    for (const { id } of COMPONENTS) {
      const r = describeHydraulicDetail(id, state, snapshot);
      assert.ok(r.facts.length >= 3 && r.facts.length <= 6, id);
      assert.equal(new Set(r.facts.map(f => f.label)).size, r.facts.length);
      for (const f of r.facts) assert.ok(Number.isFinite(f.value) || typeof f.value === 'string', `${id} ${f.label}`);
      assert.ok(r.note.length > 30, id);
    }
    const d = hydraulicDetail(state, snapshot);
    d.circuit.pressuresPa.A = 123; d.circuit.flowsM3s.pumpFromTank = 999; d.circuit.connections.push('invalid'); d.energy.loadJ = 9;
    assert.deepEqual(state, savedState); assert.deepEqual(snapshot, savedSnapshot);
    const reset = reconfigureExperiment(state, { pumpFlowM3s: 12 / 60000 }), resetDetail = hydraulicDetail(reset);
    near(resetDetail.tank.volumeM3, hydraulicDetail(state).tank.volumeM3); assert.equal(resetDetail.force.netHydraulicN, 0);
  }
  const invalid = createExperiment(); invalid.positionM = DIMENSIONS_SI.strokeM + 1;
  assert.throws(() => hydraulicDetail(invalid), RangeError);
  assert.throws(() => hydraulicDetail({ ...createExperiment(), extra: 1 }), TypeError);
});
