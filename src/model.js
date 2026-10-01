// Ideal incompressible, inertia-free, quasi-static hydraulic learning circuit.
// Internal units: metres, seconds, pascals, cubic metres per second, newtons.
export const MODEL_VERSION = 'hydraulic-quasistatic-1';
const boreM = .060, rodDiameterM = .035, deadLengthM = .006;
const capAreaM2 = Math.PI * boreM ** 2 / 4;
const rodAreaM2 = Math.PI * (boreM ** 2 - rodDiameterM ** 2) / 4;
const displacedRodAreaM2 = capAreaM2 - rodAreaM2;
export const DIMENSIONS_SI = Object.freeze({
  boreM, rodDiameterM, strokeM: .300, pistonThicknessM: .018,
  capDeadLengthM: deadLengthM, rodDeadLengthM: deadLengthM,
  capDeadVolumeM3: capAreaM2 * deadLengthM,
  rodDeadVolumeM3: rodAreaM2 * deadLengthM,
  tankVolumeAtRetractedM3: .006,
});
export const DEFAULT_SETTINGS = Object.freeze({ pumpFlowM3s: .0001, reliefPressurePa: 5e6, resistingForceN: 4000 });
export const SETTINGS_LIMITS_SI = Object.freeze({
  pumpFlowM3s: Object.freeze({ min: 2 / 60000, max: 12 / 60000 }),
  reliefPressurePa: Object.freeze({ min: 2e6, max: 1e7 }),
  resistingForceN: Object.freeze({ min: 0, max: 10000 }),
});
export const MAX_STEP_SECONDS = 3600;
export const MAX_SIMULATION_TIME_S = 1e9;
export const PRESSURE_EPSILON_PA = .01;
const COMMANDS = ['extend', 'neutral', 'retract'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const zeroTotals = () => ({ pump: 0, load: 0, relief: 0 });
const clone = value => structuredClone(value);

export function normalizeSettings(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => {
    const { min, max } = SETTINGS_LIMITS_SI[key];
    return [key, clamp(finite(value[key]) ? value[key] : fallback, min, max)];
  }));
}

function volumesAt(positionM) {
  const d = DIMENSIONS_SI;
  return {
    cap: d.capDeadVolumeM3 + capAreaM2 * positionM,
    rod: d.rodDeadVolumeM3 + rodAreaM2 * (d.strokeM - positionM),
    tank: d.tankVolumeAtRetractedM3 - displacedRodAreaM2 * positionM,
    totalFluid: d.capDeadVolumeM3 + d.rodDeadVolumeM3 + rodAreaM2 * d.strokeM + d.tankVolumeAtRetractedM3,
  };
}

// This internal evaluator assumes an already validated state; public entry points validate.
function operatingPoint(state) {
  const { command, positionM, settings } = state;
  const Q = settings.pumpFlowM3s, limit = settings.reliefPressurePa, F = settings.resistingForceN;
  let status = 'neutral', velocityMps = 0, P = 0, A = state.pressureAPa, B = state.pressureBPa;
  let requiredPressurePa = null, availableForceN = null;
  let connections = ['P-T'];
  const flows = { pumpFromTank: Q, supplyToValve: Q, valveToTank: Q, reliefToTank: 0,
    capIntoCylinder: 0, rodIntoCylinder: 0, tankNetInto: 0 };
  if (command !== 'neutral') {
    const extend = command === 'extend', area = extend ? capAreaM2 : rodAreaM2;
    requiredPressurePa = F / area; availableForceN = limit * area;
    connections = extend ? ['P-A', 'B-T'] : ['P-B', 'A-T'];
    const atStop = extend ? positionM === DIMENSIONS_SI.strokeM : positionM === 0;
    status = atStop ? 'end-stop' : requiredPressurePa < limit - PRESSURE_EPSILON_PA ? 'moving' : 'pressure-limit';
    P = status === 'moving' ? requiredPressurePa : limit;
    A = extend ? P : 0; B = extend ? 0 : P;
    if (status === 'moving') {
      velocityMps = (extend ? 1 : -1) * Q / area;
      flows.capIntoCylinder = capAreaM2 * velocityMps;
      flows.rodIntoCylinder = -rodAreaM2 * velocityMps;
      flows.valveToTank = (extend ? rodAreaM2 : capAreaM2) * Math.abs(velocityMps);
      flows.tankNetInto = -displacedRodAreaM2 * velocityMps;
    } else {
      flows.supplyToValve = 0; flows.valveToTank = 0; flows.reliefToTank = Q;
    }
  }
  return {
    positionM, velocityMps, status, direction: Math.sign(velocityMps),
    portsPa: { P, T: 0, A, B },
    chamberPressureMeaning: command === 'neutral' ? 'isolated-ideal-hold' : 'active-steady',
    requiredPressurePa, hydraulicForceN: A * capAreaM2 - B * rodAreaM2, availableForceN,
    flowsM3s: flows, volumesM3: volumesAt(positionM),
    powerW: { pump: P * Q, load: F * Math.abs(velocityMps), relief: P * flows.reliefToTank },
    geometry: { capAreaM2, rodAreaM2, displacedRodAreaM2 }, connections,
  };
}

function objectWithKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) throw new TypeError(`Invalid ${label} fields`);
}
function numberIn(value, min, max, label) {
  if (!finite(value) || Object.is(value, -0) || value < min || value > max) throw new RangeError(`Invalid ${label}`);
}
function near(a, b, absolute = 1e-9, relative = 1e-9) {
  return Math.abs(a - b) <= absolute + relative * Math.max(Math.abs(a), Math.abs(b));
}
function requireNear(a, b, label, absolute, relative) {
  if (!near(a, b, absolute, relative)) throw new RangeError(`Inconsistent ${label}`);
}
const pressureNear = (a, b) => near(a, b, 1e-7, 1e-12);

// Strict validation, also used by the experiment file codec. Does not coerce/reset.
export function assertValidState(state) {
  objectWithKeys(state, ['modelVersion', 'settings', 'command', 'positionM', 'timeS', 'pressureAPa', 'pressureBPa', 'energyJ', 'cumulativeVolumeM3'], 'state');
  if (state.modelVersion !== MODEL_VERSION) throw new RangeError('Unsupported model version');
  objectWithKeys(state.settings, Object.keys(DEFAULT_SETTINGS), 'settings');
  for (const [key, { min, max }] of Object.entries(SETTINGS_LIMITS_SI)) numberIn(state.settings[key], min, max, key);
  if (!COMMANDS.includes(state.command)) throw new RangeError('Unknown valve command');
  numberIn(state.positionM, 0, DIMENSIONS_SI.strokeM, 'positionM');
  numberIn(state.timeS, 0, MAX_SIMULATION_TIME_S, 'timeS');
  for (const key of ['pressureAPa', 'pressureBPa']) numberIn(state[key], 0, state.settings.reliefPressurePa, key);
  objectWithKeys(state.energyJ, ['pump', 'load', 'relief'], 'energyJ');
  objectWithKeys(state.cumulativeVolumeM3, ['pump', 'relief'], 'cumulativeVolumeM3');
  for (const [key, value] of Object.entries(state.energyJ)) numberIn(value, 0, Number.MAX_VALUE, `energyJ.${key}`);
  for (const [key, value] of Object.entries(state.cumulativeVolumeM3)) numberIn(value, 0, Number.MAX_VALUE, `cumulativeVolumeM3.${key}`);
  const { pumpFlowM3s: Q, reliefPressurePa: limit, resistingForceN: F } = state.settings;
  const V = state.cumulativeVolumeM3, E = state.energyJ;
  requireNear(V.pump, Q * state.timeS, 'pumped volume / time', 1e-12, 1e-9);
  if (V.relief > V.pump && !near(V.relief, V.pump, 1e-12, 1e-9)) throw new RangeError('Relief volume exceeds pump volume');
  requireNear(E.relief, limit * V.relief, 'relief energy / volume', 1e-8, 1e-9);
  requireNear(E.pump, E.load + E.relief, 'energy balance', 1e-8, 1e-9);
  if (E.pump > limit * V.pump && !near(E.pump, limit * V.pump, 1e-8, 1e-9)) throw new RangeError('Energy exceeds pressure-limited pump input');
  const maximumLoadWork = F * Math.max(0, V.pump - V.relief) / Math.min(capAreaM2, rodAreaM2);
  if (E.load > maximumLoadWork && !near(E.load, maximumLoadWork, 1e-8, 1e-9)) throw new RangeError('Load work exceeds supplied displacement');
  if (state.command === 'neutral') {
    // Only the last powered chamber may retain a pressure. Settings changes reset.
    const a = state.pressureAPa, b = state.pressureBPa;
    if (a !== 0 && b !== 0) throw new RangeError('Both isolated chambers cannot be pressurized by this circuit history');
    for (const [pressure, command, port] of [[a, 'extend', 'A'], [b, 'retract', 'B']]) {
      const previous = operatingPoint({ ...state, command }).portsPa[port];
      if (pressure !== 0 && !pressureNear(pressure, previous)) throw new RangeError('Isolated pressure is not possible at this position and setting');
    }
  } else {
    const expected = operatingPoint(state).portsPa;
    if (!pressureNear(state.pressureAPa, expected.A) || !pressureNear(state.pressureBPa, expected.B)) throw new RangeError('Active chamber pressures disagree with the circuit');
  }
  return state;
}

export function createExperiment(settings = {}, options = {}) {
  const candidate = options && typeof options === 'object' ? options.positionM : undefined;
  const positionM = clamp(finite(candidate) ? candidate : DIMENSIONS_SI.strokeM / 2, 0, DIMENSIONS_SI.strokeM);
  return {
    modelVersion: MODEL_VERSION, settings: normalizeSettings(settings), command: 'neutral',
    positionM, timeS: 0, pressureAPa: 0, pressureBPa: 0,
    energyJ: zeroTotals(), cumulativeVolumeM3: { pump: 0, relief: 0 },
  };
}

export function instantSnapshot(state) {
  assertValidState(state);
  return operatingPoint(state);
}

export function setCommand(state, command) {
  assertValidState(state);
  if (!COMMANDS.includes(command)) throw new RangeError('Unknown valve command');
  const result = clone(state);
  result.command = command;
  const point = operatingPoint(result);
  result.pressureAPa = point.portsPa.A; result.pressureBPa = point.portsPa.B;
  return result;
}

// Explicit new comparison experiment, not a simulated pressure-release event.
export function reconfigureExperiment(state, settingsPatch = {}) {
  assertValidState(state);
  const patch = settingsPatch && typeof settingsPatch === 'object' ? settingsPatch : {};
  return createExperiment({ ...state.settings, ...patch }, { positionM: state.positionM });
}

function makeSegment(point, durationS, startPositionM, endPositionM) {
  return { durationS, status: point.status, startPositionM, endPositionM,
    portsPa: point.portsPa, flowsM3s: point.flowsM3s, powerW: point.powerW };
}

export function step(state, dtSeconds) {
  assertValidState(state);
  if (!finite(dtSeconds) || dtSeconds < 0 || dtSeconds > MAX_STEP_SECONDS) throw new RangeError('dtSeconds must be finite and within 0..3600');
  if (state.timeS + dtSeconds > MAX_SIMULATION_TIME_S) throw new RangeError('Simulation time limit exceeded');
  const next = clone(state), segments = [];
  const interval = { durationS: dtSeconds === 0 ? 0 : dtSeconds, segments,
    deltaEnergyJ: zeroTotals(), deltaVolumeM3: { pump: 0, relief: 0, tankNetInto: 0 } };
  if (dtSeconds === 0) return { state: next, interval };
  const first = operatingPoint(state);
  if (first.status === 'moving') {
    const remaining = first.velocityMps > 0 ? DIMENSIONS_SI.strokeM - state.positionM : state.positionM;
    const tHit = remaining / Math.abs(first.velocityMps), tMove = Math.min(dtSeconds, tHit);
    next.positionM = dtSeconds >= tHit ? first.velocityMps > 0 ? DIMENSIONS_SI.strokeM : 0 : state.positionM + first.velocityMps * tMove;
    if (tMove > 0) segments.push(makeSegment(first, tMove, state.positionM, next.positionM));
    const rest = dtSeconds - tMove;
    if (rest > 0) segments.push(makeSegment(operatingPoint(next), rest, next.positionM, next.positionM));
  } else segments.push(makeSegment(first, dtSeconds, state.positionM, state.positionM));
  for (const segment of segments) {
    for (const key of ['pump', 'load', 'relief']) interval.deltaEnergyJ[key] += segment.powerW[key] * segment.durationS;
    interval.deltaVolumeM3.pump += segment.flowsM3s.pumpFromTank * segment.durationS;
    interval.deltaVolumeM3.relief += segment.flowsM3s.reliefToTank * segment.durationS;
  }
  interval.deltaVolumeM3.tankNetInto = volumesAt(next.positionM).tank - first.volumesM3.tank;
  next.timeS += dtSeconds;
  for (const key of ['pump', 'load', 'relief']) next.energyJ[key] += interval.deltaEnergyJ[key];
  for (const key of ['pump', 'relief']) next.cumulativeVolumeM3[key] += interval.deltaVolumeM3[key];
  const last = operatingPoint(next);
  next.pressureAPa = last.portsPa.A; next.pressureBPa = last.portsPa.B;
  assertValidState(next);
  return { state: next, interval };
}
