import { DIMENSIONS_SI, assertValidState, instantSnapshot } from './model.js';

/** Pure SI observations of the existing quasi-static operating point.
 * A supplied snapshot must be instantSnapshot(state) for this same state. */
export function hydraulicDetail(state, snapshot = instantSnapshot(state)) {
  assertValidState(state);
  const s = snapshot, p = s.portsPa, q = s.flowsM3s, v = s.volumesM3;
  const { capAreaM2, rodAreaM2, displacedRodAreaM2 } = s.geometry;
  const limit = state.settings.reliefPressurePa;
  const capN = p.A * capAreaM2, rodN = -p.B * rodAreaM2, netHydraulicN = capN + rodN;
  const returnCombinedM3s = q.valveToTank + q.reliefToTank;
  const moving = s.status === 'moving';
  const distanceToStopM = moving ? s.velocityMps > 0 ? DIMENSIONS_SI.strokeM - s.positionM : s.positionM : null;
  const cylinderW = netHydraulicN * s.velocityMps;
  const chamberPowerW = p.A * q.capIntoCylinder + p.B * q.rodIntoCylinder;
  return {
    command: state.command, status: s.status,
    geometry: { capAreaM2, rodAreaM2, displacedRodAreaM2, retractToExtendSpeedRatio: capAreaM2 / rodAreaM2 },
    force: {
      capN, rodN, netHydraulicN,
      extendLimitN: limit * capAreaM2, retractLimitN: limit * rodAreaM2,
      commandLimitN: s.availableForceN, resistingLoadMagnitudeN: state.settings.resistingForceN,
      requiredPressurePa: s.requiredPressurePa,
      pressureMarginPa: s.requiredPressurePa === null ? null : limit - s.requiredPressurePa,
    },
    motion: { positionM: s.positionM, velocityMps: s.velocityMps, moving,
      distanceToStopM, timeToStopS: moving ? distanceToStopM / Math.abs(s.velocityMps) : null },
    chambers: {
      cap: { pressurePa: p.A, volumeM3: v.cap, volumeRateM3s: q.capIntoCylinder, signedPowerIntoW: p.A * q.capIntoCylinder },
      rod: { pressurePa: p.B, volumeM3: v.rod, volumeRateM3s: q.rodIntoCylinder, signedPowerIntoW: p.B * q.rodIntoCylinder },
    },
    circuit: { pressuresPa: { ...p }, flowsM3s: { ...q }, returnCombinedM3s,
      connections: [...s.connections], isolatedHold: s.chamberPressureMeaning === 'isolated-ideal-hold' },
    power: { pumpW: s.powerW.pump, loadW: s.powerW.load, reliefW: s.powerW.relief, cylinderW,
      residualW: s.powerW.pump - s.powerW.load - s.powerW.relief,
      loadShare: s.powerW.pump > 0 ? s.powerW.load / s.powerW.pump : null },
    balance: {
      fluidVolumeM3: v.cap + v.rod + v.tank, referenceFluidVolumeM3: v.totalFluid,
      volumeResidualM3: v.cap + v.rod + v.tank - v.totalFluid,
      rateResidualM3s: q.capIntoCylinder + q.rodIntoCylinder + q.tankNetInto,
      pumpBranchResidualM3s: q.pumpFromTank - q.supplyToValve - q.reliefToTank,
      tankResidualM3s: q.tankNetInto - (returnCombinedM3s - q.pumpFromTank),
      cylinderPowerResidualW: chamberPowerW - cylinderW,
      energyResidualJ: state.energyJ.pump - state.energyJ.load - state.energyJ.relief,
    },
    energy: { pumpJ: state.energyJ.pump, loadJ: state.energyJ.load, reliefJ: state.energyJ.relief },
    tank: { volumeM3: v.tank, rateM3s: q.tankNetInto },
  };
}
