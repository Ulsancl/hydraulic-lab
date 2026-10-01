import { DIMENSIONS_SI, instantSnapshot } from './model.js';
import { LESSONS } from './lessons.js';

export const GUIDE_STEP_COUNTS = Object.freeze({ 'speed-ratio': 2, 'pressure-limit': 3, 'neutral-hold': 3 });
const close = (a, b, tolerance = 1e-10) => Math.abs(a - b) <= tolerance;
const strokeM = DIMENSIONS_SI.strokeM;
const observedTravelM = .001;
const matches = (state, pressurePa = 5e6) => close(state.settings.pumpFlowM3s, .0001, 1e-14)
  && close(state.settings.resistingForceN, 4000, 1e-8) && close(state.settings.reliefPressurePa, pressurePa, .01);

export function createGuide(lessonId) {
  if (!LESSONS.some(lesson => lesson.id === lessonId)) throw new RangeError('Unknown guided experiment');
  return { lessonId, stepIndex: 0, status: 'active', evidence: [], tracking: null, notice: null, pressureChangeApplied: false };
}
function interrupt(guide, notice) {
  guide.status = 'interrupted'; guide.notice = notice; guide.tracking = null; return guide;
}
function confirmed(guide, evidence) {
  guide.evidence.push(evidence); guide.stepIndex++; guide.tracking = null; guide.notice = null;
  if (guide.stepIndex === GUIDE_STEP_COUNTS[guide.lessonId]) guide.status = 'completed';
  return guide;
}
function movement(guide, event, command, requiredStart = null) {
  if (event.before.command !== command || event.type !== 'advance') return null;
  const segments = event.interval.segments.filter(segment => segment.status === 'moving');
  if (!segments.length) return null;
  if (!guide.tracking) {
    if (requiredStart !== null && !close(event.before.positionM, requiredStart)) {
      interrupt(guide, '행정 시작 위치가 달라졌습니다. 안내를 다시 시작해 같은 거리에서 비교하세요.'); return null;
    }
    guide.tracking = { startPositionM: event.before.positionM, positionM: event.before.positionM, distanceM: 0, movingTimeS: 0 };
  }
  if (!close(guide.tracking.positionM, event.before.positionM)) {
    interrupt(guide, '관찰 중 위치가 달라졌습니다. 안내를 다시 시작해 연속된 이동을 비교하세요.'); return null;
  }
  for (const segment of segments) {
    guide.tracking.distanceM += Math.abs(segment.endPositionM - segment.startPositionM);
    guide.tracking.movingTimeS += segment.durationS;
  }
  guide.tracking.positionM = event.after.positionM;
  return guide.tracking;
}
function motionEvidence(tracking, snapshot, command) {
  return {
    kind: 'movement', command, distanceM: tracking.distanceM, movingTimeS: tracking.movingTimeS,
    speedMps: tracking.distanceM / tracking.movingTimeS,
    areaM2: command === 'extend' ? snapshot.geometry.capAreaM2 : snapshot.geometry.rodAreaM2,
    forceLimitN: snapshot.availableForceN,
  };
}

/** Consume explicit model transitions; observation metadata never advances the model. */
export function observeGuide(guide, event) {
  if (!guide || guide.status !== 'active') return guide;
  if (!['command', 'advance', 'settings'].includes(event?.type) || !event.before || !event.after) return guide;
  const next = structuredClone(guide), { before, after, type } = event;
  if (type === 'settings') {
    if (next.lessonId === 'pressure-limit' && next.stepIndex === 2 && matches(before, 2e6) && matches(after, 5e6)
      && before.positionM === after.positionM && after.command === 'neutral' && after.timeS === 0) {
      next.pressureChangeApplied = true; next.tracking = null;
      next.notice = '50 bar 새 조건을 적용했습니다. 후진을 선택하고 재생하거나 +0.1초를 누르세요.';
      return next;
    }
    return interrupt(next, '안내의 비교 조건이 바뀌었습니다. 현재 실험은 유지됩니다. 안내를 다시 시작하거나 자유 탐구로 이어가세요.');
  }
  const expectedPressure = next.lessonId === 'pressure-limit' && !next.pressureChangeApplied ? 2e6 : 5e6;
  if (!matches(before, expectedPressure) || !matches(after, expectedPressure)) return interrupt(next, '이 안내의 유량·부하·압력 조건과 다릅니다. 안내를 다시 시작해 비교하세요.');
  if (next.lessonId === 'neutral-hold' && type === 'command') {
    if (next.stepIndex === 1 && before.command === 'extend' && after.command === 'neutral'
      && before.pressureAPa > 0 && before.positionM === after.positionM
      && before.pressureAPa === after.pressureAPa && before.pressureBPa === after.pressureBPa) {
      return confirmed(next, { kind: 'isolation', positionM: after.positionM, pressureAPa: after.pressureAPa, pressureBPa: after.pressureBPa });
    }
    if (next.stepIndex === 2 && after.command !== 'neutral') {
      next.stepIndex = 1; next.evidence = next.evidence.slice(0, 1); next.tracking = null;
      next.notice = '중립을 해제했습니다. 전진을 선택한 뒤 중립으로 바꾸어 고립 상태를 다시 확인하세요.';
    }
    return next;
  }
  if (type !== 'advance' || !event.interval || event.interval.durationS <= 0 || after.timeS <= before.timeS) return next;
  const snapshot = instantSnapshot(after);
  const hasReverseMovement = expected => event.interval.segments.some(segment => segment.status === 'moving'
    && (expected === 'extend' ? segment.endPositionM < segment.startPositionM : segment.endPositionM > segment.startPositionM));

  if (next.lessonId === 'speed-ratio') {
    const command = next.stepIndex === 0 ? 'extend' : 'retract';
    if (hasReverseMovement(command)) return interrupt(next, '행정 도중 반대 방향으로 움직였습니다. 안내를 다시 시작해 전진·후진 한 행정을 비교하세요.');
    const tracking = movement(next, event, command, command === 'extend' ? 0 : strokeM);
    if (tracking && close(after.positionM, command === 'extend' ? strokeM : 0) && close(tracking.distanceM, strokeM)) {
      return confirmed(next, motionEvidence(tracking, snapshot, command));
    }
  } else if (next.lessonId === 'pressure-limit') {
    if (next.stepIndex === 0) {
      if (hasReverseMovement('retract')) return interrupt(next, '정지 조건을 확인하기 전에 전진했습니다. 안내를 다시 시작해 20 bar 후진부터 비교하세요.');
      if (before.command === 'retract' && snapshot.status === 'pressure-limit' && before.positionM === after.positionM
        && snapshot.flowsM3s.reliefToTank > 0 && after.energyJ.relief > before.energyJ.relief) {
        return confirmed(next, { kind: 'pressure-limit', pressurePa: snapshot.portsPa.P, forceLimitN: snapshot.availableForceN,
          loadN: after.settings.resistingForceN, reliefFlowM3s: snapshot.flowsM3s.reliefToTank,
          observedDurationS: event.interval.durationS, reliefEnergyJ: after.energyJ.relief - before.energyJ.relief });
      }
    } else {
      const command = next.stepIndex === 1 ? 'extend' : 'retract';
      if (next.stepIndex === 2 && !next.pressureChangeApplied) return next;
      if (hasReverseMovement(command)) return interrupt(next, '안내와 반대 방향으로 움직였습니다. 안내를 다시 시작하거나 자유 탐구로 이어가세요.');
      const tracking = movement(next, event, command);
      if (tracking && tracking.distanceM >= observedTravelM) return confirmed(next, { ...motionEvidence(tracking, snapshot, command), pressureLimitPa: after.settings.reliefPressurePa });
    }
  } else if (next.lessonId === 'neutral-hold') {
    if (next.stepIndex === 0) {
      if (hasReverseMovement('extend')) return interrupt(next, '전진 압력을 관찰하기 전에 후진했습니다. 안내를 다시 시작해 전진부터 관찰하세요.');
      const tracking = movement(next, event, 'extend');
      if (tracking && tracking.distanceM >= observedTravelM && after.pressureAPa > 0) return confirmed(next, {
        ...motionEvidence(tracking, snapshot, 'extend'), pressureAPa: after.pressureAPa, pressureBPa: after.pressureBPa,
      });
    } else if (next.stepIndex === 1 && hasReverseMovement('extend')) {
      return interrupt(next, '압력을 고립시키기 전에 후진했습니다. 안내를 다시 시작해 전진 다음 중립을 비교하세요.');
    } else if (next.stepIndex === 2) {
      const isolation = next.evidence[1];
      if (before.command === 'neutral' && after.command === 'neutral' && after.positionM === isolation.positionM
        && before.positionM === after.positionM && after.pressureAPa === isolation.pressureAPa && after.pressureBPa === isolation.pressureBPa
        && snapshot.portsPa.P === 0 && snapshot.flowsM3s.valveToTank > 0
        && snapshot.flowsM3s.capIntoCylinder === 0 && snapshot.flowsM3s.rodIntoCylinder === 0) {
        return confirmed(next, { ...isolation, kind: 'neutral-hold', observedDurationS: event.interval.durationS,
          pumpPressurePa: snapshot.portsPa.P, returnFlowM3s: snapshot.flowsM3s.valveToTank });
      }
    }
  }
  return next;
}
