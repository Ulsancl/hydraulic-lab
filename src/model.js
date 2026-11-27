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
export const EXPERIMENT_SETTING_DEFAULTS = Object.freeze({ pumpCommandRatio: 1, returnRestrictionPaPerM3s: 0 });
export const RETURN_REFERENCE_FLOW_M3S = 6 / 60000;
export const SETTINGS_LIMITS_SI = Object.freeze({
  pumpFlowM3s: Object.freeze({ min: 2 / 60000, max: 12 / 60000 }),
  reliefPressurePa: Object.freeze({ min: 2e6, max: 1e7 }),
  resistingForceN: Object.freeze({ min: 0, max: 10000 }),
  pumpCommandRatio: Object.freeze({ min: .5, max: 1 }),
  returnRestrictionPaPerM3s: Object.freeze({ min: 0, max: 5e5 / RETURN_REFERENCE_FLOW_M3S }),
});
export const MAX_STEP_SECONDS = 3600;
export const MAX_SIMULATION_TIME_S = 1e9;
export const PRESSURE_EPSILON_PA = .01;
const COMMANDS = ['extend', 'neutral', 'retract'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const energyKeys = ['pump', 'load', 'relief'];
const zeroTotals = settings => ({
  pump: 0, load: 0, relief: 0, ...(settings.returnRestrictionPaPerM3s > 0 ? { returnLoss: 0 } : {}),
});
const clone = value => structuredClone(value);
const pumpFlow = settings => settings.pumpFlowM3s * (settings.pumpCommandRatio ?? EXPERIMENT_SETTING_DEFAULTS.pumpCommandRatio);

export function normalizeSettings(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const bounded = (key, fallback) => {
    const { min, max } = SETTINGS_LIMITS_SI[key];
    return clamp(finite(value[key]) ? value[key] : fallback, min, max);
  };
  const settings = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, fallback]) => [key, bounded(key, fallback)]));
  // The original schema represents default conditions without override fields.
  for (const [key, fallback] of Object.entries(EXPERIMENT_SETTING_DEFAULTS)) {
    const setting = bounded(key, fallback);
    if (setting !== fallback) settings[key] = setting;
  }
  return settings;
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
  const Q = pumpFlow(settings), limit = settings.reliefPressurePa, F = settings.resistingForceN;
  const resistance = settings.returnRestrictionPaPerM3s ?? EXPERIMENT_SETTING_DEFAULTS.returnRestrictionPaPerM3s;
  // The restriction is in the valve return branch, upstream of the relief tee.
  // Even the largest neutral drop is below the lowest supported relief setting.
  let returnBackpressurePa = resistance * Q;
  let status = 'neutral', velocityMps = 0, P = returnBackpressurePa, A = state.pressureAPa, B = state.pressureBPa;
  let requiredPressurePa = null, availableForceN = null;
  let connections = ['P-T'];
  const flows = { pumpFromTank: Q, supplyToValve: Q, valveToTank: Q, reliefToTank: 0,
    capIntoCylinder: 0, rodIntoCylinder: 0, tankNetInto: 0 };
  if (command !== 'neutral') {
    const extend = command === 'extend', area = extend ? capAreaM2 : rodAreaM2;
    const returnArea = extend ? rodAreaM2 : capAreaM2;
    const areaRatio = returnArea / area;
    requiredPressurePa = F / area; availableForceN = limit * area;
    connections = extend ? ['P-A', 'B-T'] : ['P-B', 'A-T'];
    const atStop = extend ? positionM === DIMENSIONS_SI.strokeM : positionM === 0;
    status = atStop ? 'end-stop' : requiredPressurePa < limit - PRESSURE_EPSILON_PA ? 'moving' : 'pressure-limit';
    if (status === 'moving') {
      // Force balance gives P = F/area + (returnArea/area)^2 × R × supply.
      // At the pressure cap the excess pump flow takes the separate relief branch.
      const restrictionAtSupply = areaRatio ** 2 * resistance;
      const fullFlowPressurePa = requiredPressurePa + restrictionAtSupply * Q;
      if (fullFlowPressurePa > limit) {
        flows.supplyToValve = Math.min(Q, (limit - requiredPressurePa) / restrictionAtSupply);
        flows.reliefToTank = Q - flows.supplyToValve;
        P = limit;
      } else P = fullFlowPressurePa;
      velocityMps = (extend ? 1 : -1) * flows.supplyToValve / area;
      flows.capIntoCylinder = capAreaM2 * velocityMps;
      flows.rodIntoCylinder = -rodAreaM2 * velocityMps;
      flows.valveToTank = returnArea * Math.abs(velocityMps);
      returnBackpressurePa = resistance * flows.valveToTank;
      flows.tankNetInto = -displacedRodAreaM2 * velocityMps;
    } else {
      P = limit; returnBackpressurePa = 0;
      flows.supplyToValve = 0; flows.valveToTank = 0; flows.reliefToTank = Q;
    }
    A = extend ? P : returnBackpressurePa;
    B = extend ? returnBackpressurePa : P;
  }
  return {
    positionM, velocityMps, status, direction: Math.sign(velocityMps),
    portsPa: { P, T: 0, A, B }, returnBackpressurePa,
    chamberPressureMeaning: command === 'neutral' ? 'isolated-ideal-hold' : 'active-steady',
    requiredPressurePa, hydraulicForceN: A * capAreaM2 - B * rodAreaM2, availableForceN,
    flowsM3s: flows, volumesM3: volumesAt(positionM),
    powerW: {
      pump: P * Q, load: F * Math.abs(velocityMps), relief: P * flows.reliefToTank,
      ...(resistance > 0 ? { returnLoss: returnBackpressurePa * flows.valveToTank } : {}),
    },
    geometry: { capAreaM2, rodAreaM2, displacedRodAreaM2 }, connections,
  };
}

function objectWithKeys(value, keys, label, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label} fields`);
  const actual = Object.keys(value);
  if (keys.some(key => !actual.includes(key)) || actual.some(key => !keys.includes(key) && !optional.includes(key))) {
    throw new TypeError(`Invalid ${label} fields`);
  }
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
  objectWithKeys(state.settings, Object.keys(DEFAULT_SETTINGS), 'settings', Object.keys(EXPERIMENT_SETTING_DEFAULTS));
  for (const key of Object.keys(state.settings)) {
    const { min, max } = SETTINGS_LIMITS_SI[key];
    numberIn(state.settings[key], min, max, key);
  }
  if (!COMMANDS.includes(state.command)) throw new RangeError('Unknown valve command');
  numberIn(state.positionM, 0, DIMENSIONS_SI.strokeM, 'positionM');
  numberIn(state.timeS, 0, MAX_SIMULATION_TIME_S, 'timeS');
  for (const key of ['pressureAPa', 'pressureBPa']) numberIn(state[key], 0, state.settings.reliefPressurePa, key);
  const resistance = state.settings.returnRestrictionPaPerM3s ?? EXPERIMENT_SETTING_DEFAULTS.returnRestrictionPaPerM3s;
  objectWithKeys(state.energyJ, resistance > 0 ? [...energyKeys, 'returnLoss'] : energyKeys, 'energyJ');
  objectWithKeys(state.cumulativeVolumeM3, ['pump', 'relief'], 'cumulativeVolumeM3');
  for (const [key, value] of Object.entries(state.energyJ)) numberIn(value, 0, Number.MAX_VALUE, `energyJ.${key}`);
  for (const [key, value] of Object.entries(state.cumulativeVolumeM3)) numberIn(value, 0, Number.MAX_VALUE, `cumulativeVolumeM3.${key}`);
  const { reliefPressurePa: limit, resistingForceN: F } = state.settings;
  const Q = pumpFlow(state.settings);
  const V = state.cumulativeVolumeM3, E = state.energyJ, returnLoss = E.returnLoss ?? 0;
  requireNear(V.pump, Q * state.timeS, 'pumped volume / time', 1e-12, 1e-9);
  if (V.relief > V.pump && !near(V.relief, V.pump, 1e-12, 1e-9)) throw new RangeError('Relief volume exceeds pump volume');
  requireNear(E.relief, limit * V.relief, 'relief energy / volume', 1e-8, 1e-9);
  requireNear(E.pump, E.load + E.relief + returnLoss, 'energy balance', 1e-8, 1e-9);
  if (E.pump > limit * V.pump && !near(E.pump, limit * V.pump, 1e-8, 1e-9)) throw new RangeError('Energy exceeds pressure-limited pump input');
  const valveSupplyVolumeM3 = Math.max(0, V.pump - V.relief);
  const maximumLoadWork = F * valveSupplyVolumeM3 / rodAreaM2;
  if (E.load > maximumLoadWork && !near(E.load, maximumLoadWork, 1e-8, 1e-9)) throw new RangeError('Load work exceeds supplied displacement');
  const maximumReturnLoss = resistance * (capAreaM2 / rodAreaM2) ** 2 * Q * valveSupplyVolumeM3;
  if (returnLoss > maximumReturnLoss && !near(returnLoss, maximumReturnLoss, 1e-8, 1e-9)) throw new RangeError('Return loss exceeds supplied flow');
  if (state.command === 'neutral') {
    const a = state.pressureAPa, b = state.pressureBPa;
    // Initially both chambers are at zero. Otherwise they retain the pair from
    // the last powered command, including any return-side backpressure.
    if ((a !== 0 || b !== 0) && !['extend', 'retract'].some(command => {
      const previous = operatingPoint({ ...state, command }).portsPa;
      return pressureNear(a, previous.A) && pressureNear(b, previous.B);
    })) throw new RangeError('Isolated pressure pair is not possible at this position and setting');
  } else {
    const expected = operatingPoint(state).portsPa;
    if (!pressureNear(state.pressureAPa, expected.A) || !pressureNear(state.pressureBPa, expected.B)) throw new RangeError('Active chamber pressures disagree with the circuit');
  }
  return state;
}

export function createExperiment(settings = {}, options = {}) {
  const candidate = options && typeof options === 'object' ? options.positionM : undefined;
  const positionM = clamp(finite(candidate) ? candidate : DIMENSIONS_SI.strokeM / 2, 0, DIMENSIONS_SI.strokeM);
  const normalizedSettings = normalizeSettings(settings);
  return {
    modelVersion: MODEL_VERSION, settings: normalizedSettings, command: 'neutral',
    positionM, timeS: 0, pressureAPa: 0, pressureBPa: 0,
    energyJ: zeroTotals(normalizedSettings), cumulativeVolumeM3: { pump: 0, relief: 0 },
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
    deltaEnergyJ: zeroTotals(state.settings), deltaVolumeM3: { pump: 0, relief: 0, tankNetInto: 0 } };
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
  const totals = Object.keys(interval.deltaEnergyJ);
  for (const segment of segments) {
    for (const key of totals) interval.deltaEnergyJ[key] += segment.powerW[key] * segment.durationS;
    interval.deltaVolumeM3.pump += segment.flowsM3s.pumpFromTank * segment.durationS;
    interval.deltaVolumeM3.relief += segment.flowsM3s.reliefToTank * segment.durationS;
  }
  interval.deltaVolumeM3.tankNetInto = volumesAt(next.positionM).tank - first.volumesM3.tank;
  next.timeS += dtSeconds;
  for (const key of totals) next.energyJ[key] += interval.deltaEnergyJ[key];
  for (const key of ['pump', 'relief']) next.cumulativeVolumeM3[key] += interval.deltaVolumeM3[key];
  const last = operatingPoint(next);
  next.pressureAPa = last.portsPa.A; next.pressureBPa = last.portsPa.B;
  assertValidState(next);
  return { state: next, interval };
}
