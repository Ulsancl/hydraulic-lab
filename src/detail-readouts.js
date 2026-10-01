import { DIMENSIONS_SI } from './model.js';
import { hydraulicDetail } from './detail-model.js';
export { hydraulicDetail } from './detail-model.js';

const toLpm = value => value * 60000;
const holdNote = '중립에서는 P→T가 순환하고 A·B 유량은 0입니다. 마지막 액실 압력과 그 압력의 힘은 이상적으로 유지됩니다. 압축성 저장 에너지·누설·압력 완화는 계산하지 않습니다.';
const motionNote = '전진이 양수입니다. 힘 한계는 설정 압력에서 가능한 크기이며 현재 압력의 실제 힘과 다릅니다. 도달 예상은 현재 명령·조건을 계속 적용할 때의 모형 시간입니다.';

export function describeHydraulicDetail(partId, state, snapshot) {
  const d = hydraulicDetail(state, snapshot), { force: f, motion: m, geometry: g, power: w } = d;
  const p = d.circuit.pressuresPa, q = d.circuit.flowsM3s;
  const facts = [], add = (label, value, unit = '', digits = 1) => facts.push({ label, value, unit, digits });
  const flow = (label, value) => add(label, toLpm(value), 'L/min', 2);
  const pressure = (label, value) => add(label, value / 1e5, 'bar', 1);
  const force = (label, value) => add(label, value / 1000, 'kN', 2);
  let note;
  if (partId === 'piston') {
    add('캡측 유효 면적', g.capAreaM2 * 1e4, 'cm²', 2);
    add('로드측 환형 면적', g.rodAreaM2 * 1e4, 'cm²', 2);
    force('A 압력의 힘 · 전진 +', f.capN);
    force('B 압력의 힘 · 후진 −', f.rodN);
    force('현재 순유압력', f.netHydraulicN);
    add('현재 명령의 힘 한계', f.commandLimitN === null ? '중립 · 명령 없음' : f.commandLimitN / 1000, f.commandLimitN === null ? '' : 'kN', 2);
    note = d.circuit.isolatedHold ? holdNote : '현재 순유압력은 pA×캡측 면적 − pB×로드측 환형 면적입니다. ' + motionNote + ' 정지에서는 시험 저항 또는 끝 지지가 반력을 담당하며 가속도는 계산하지 않습니다.';
  } else if (partId === 'rod') {
    add('로드 단면적', g.displacedRodAreaM2 * 1e4, 'cm²', 2);
    add('로드측 환형 면적', g.rodAreaM2 * 1e4, 'cm²', 2);
    add('후진 / 전진 속력비', g.retractToExtendSpeedRatio, '', 3);
    add('현재 위치', m.positionM * 1000, 'mm');
    add('현재 속도 · 전진 +', m.velocityMps * 1000, 'mm/s', 2);
    force('현재 순유압력', f.netHydraulicN);
    note = '속력비는 같은 공급 유량으로 양방향 모두 이동 가능한 경우의 캡 면적 / 환형 면적입니다. 막힘·중립의 실제 속도를 나눈 값이 아닙니다. 로드 응력·좌굴·마찰은 계산하지 않습니다.';
  } else if (partId === 'cylinder-barrel') {
    add('보어 지름', DIMENSIONS_SI.boreM * 1000, 'mm');
    add('전체 행정', DIMENSIONS_SI.strokeM * 1000, 'mm');
    add('캡측 현재 체적', d.chambers.cap.volumeM3 * 1e6, 'mL');
    add('로드측 현재 체적', d.chambers.rod.volumeM3 * 1e6, 'mL');
    add('캡측 유효 면적', g.capAreaM2 * 1e4, 'cm²', 2);
    add('로드측 환형 면적', g.rodAreaM2 * 1e4, 'cm²', 2);
    note = '두 액실 체적에는 실제 표시 치수인 각 6 mm 끝 공간이 포함됩니다. 배럴 응력·변형·유체 압축성은 계산하지 않습니다.';
  } else if (['port-A', 'line-A', 'cap-end', 'port-B', 'line-B', 'rod-gland'].includes(partId)) {
    const cap = ['port-A', 'line-A', 'cap-end'].includes(partId), c = cap ? d.chambers.cap : d.chambers.rod;
    pressure(cap ? 'A 액실 압력' : 'B 액실 압력', c.pressurePa);
    add('연결 액실 유효 면적', (cap ? g.capAreaM2 : g.rodAreaM2) * 1e4, 'cm²', 2);
    force('피스톤에 기여하는 힘', cap ? f.capN : f.rodN);
    flow('액실 유량 · 유입 +', c.volumeRateM3s);
    add('연결 액실 현재 체적', c.volumeM3 * 1e6, 'mL');
    add('액실로 들어가는 유압 동력', c.signedPowerIntoW, 'W');
    note = '유량은 해당 액실로 들어갈 때 양수, 배출할 때 음수입니다. 힘은 피스톤의 전진 방향이 양수입니다. 포트·배관의 국부 하중이나 압력 손실을 뜻하지 않습니다. ' + (d.circuit.isolatedHold ? holdNote : '힘과 유량의 부호 기준은 서로 다릅니다.');
  } else if (['load-carriage', 'load-guide'].includes(partId)) {
    force('현재 순유압력', f.netHydraulicN);
    force('설정 저항력 크기', f.resistingLoadMagnitudeN);
    add('현재 명령의 힘 한계', f.commandLimitN === null ? '중립 · 명령 없음' : f.commandLimitN / 1000, f.commandLimitN === null ? '' : 'kN', 2);
    add('현재 속도 · 전진 +', m.velocityMps * 1000, 'mm/s', 2);
    add('이동 방향 끝까지 거리', m.distanceToStopM === null ? '이동 중 아님' : m.distanceToStopM * 1000, m.distanceToStopM === null ? '' : 'mm', 1);
    add('행정 끝 도달 예상', m.timeToStopS === null ? '이동 중 아님' : m.timeToStopS, m.timeToStopS === null ? '' : 's', 2);
    note = motionNote + ' 수평 저항 부하는 이동을 거스르며 정지 중에는 설정값까지 반력을 제공합니다. 행정 끝에서는 끝 지지도 반력을 담당합니다. 중립·압력 제한·행정 끝에는 도달 시간을 만들지 않습니다. 관찰 일시정지는 회로 명령 변경이 아닙니다.';
  } else if (['tank', 'tank-oil'].includes(partId)) {
    add('탱크 현재 체적', d.tank.volumeM3 * 1000, 'L', 3);
    add('캡측 현재 체적', d.chambers.cap.volumeM3 * 1e6, 'mL');
    add('로드측 현재 체적', d.chambers.rod.volumeM3 * 1e6, 'mL');
    flow('합류 복귀 유량', d.circuit.returnCombinedM3s);
    flow('펌프로 나가는 유량', q.pumpFromTank);
    flow('탱크 순유입 · 증가 +', d.tank.rateM3s);
    note = '탱크 순유입은 방향밸브 복귀 + 릴리프 복귀 − 펌프 흡입입니다. 로드가 전진하면 두 액실의 합산 체적이 늘어 탱크 체적은 줄어듭니다. 고정 배관 체적은 이 수지에서 제외하며 오일 온도는 계산하지 않습니다.';
  } else if (['pump', 'pump-drive'].includes(partId)) {
    flow('펌프 공급 유량', q.pumpFromTank);
    pressure('펌프 출구 압력', p.P);
    add('펌프 유압 동력', w.pumpW, 'W');
    flow('방향밸브로 공급', q.supplyToValve);
    flow('릴리프로 우회', q.reliefToTank);
    add('누적 펌프 유압 일', d.energy.pumpJ / 1000, 'kJ', 2);
    note = '고정 유량을 지정하고 출구 압력은 부하·연결로 결정합니다. 표시 동력은 pP×Q이며 축 토크·실제 구동 전력·펌프 효율은 계산하지 않습니다. 중립·무부하의 이상 유압 동력 0을 실제 소비 전력 0으로 해석하지 않습니다.';
  } else if (['return-filter', 'line-T'].includes(partId)) {
    flow('방향밸브에서 복귀', q.valveToTank);
    flow('릴리프에서 복귀', q.reliefToTank);
    flow('필터·탱크 합류 유량', d.circuit.returnCombinedM3s);
    pressure('복귀 기준 압력', p.T);
    flow('탱크 순유입 · 증가 +', d.tank.rateM3s);
    note = '공통 복귀선·필터에는 방향밸브와 릴리프 유량의 합이 흐릅니다. T 포트 유량만으로 계산하지 않습니다. 탱크 기준 게이지압 0을 사용하며 필터 막힘·압력 강하·발열은 계산하지 않습니다.';
  } else if (['suction-strainer', 'line-suction'].includes(partId)) {
    flow('탱크에서 펌프로', q.pumpFromTank);
    add('탱크 현재 체적', d.tank.volumeM3 * 1000, 'L', 3);
    pressure('탱크 기준 게이지압', p.T);
    add('흡입 손실·캐비테이션', '계산하지 않음');
    note = '흡입 유량은 지정 펌프 유량과 같습니다. 게이지압 0은 이 이상 회로의 기준이며 실제 흡입관 압력·기포·흡입 여유를 예측하는 값이 아닙니다.';
  } else if (['directional-body', 'directional-spool', 'centering-springs'].includes(partId)) {
    add('현재 연결', d.circuit.connections.map(value => value.replace('-', '↔')).join(' · '));
    pressure('P 포트 압력', p.P);
    flow('P에서 밸브로 유입', q.supplyToValve);
    flow('A 액실 유량 · 유입 +', q.capIntoCylinder);
    flow('B 액실 유량 · 유입 +', q.rodIntoCylinder);
    flow('T에서 탱크로 복귀', q.valveToTank);
    note = '세 위치의 연결만 계산하며 중간 스풀 개도·과도압력·스프링 강성·전환 시간을 해석하지 않습니다. ' + (d.circuit.isolatedHold ? holdNote : 'A·B 유량은 각 액실로 유입할 때 양수입니다.');
  } else if (partId === 'port-P' || partId === 'line-P') {
    pressure('공급 압력', p.P);
    flow('펌프에서 분기 전 유량', q.pumpFromTank);
    flow('방향밸브 P로 들어가는 유량', q.supplyToValve);
    flow('릴리프로 나뉘는 유량', q.reliefToTank);
    add('방향밸브 공급 유압 동력', p.P * q.supplyToValve, 'W');
    note = 'P 배관에는 릴리프 분기가 있습니다. 펌프 출구의 전체 유량과 방향밸브 P 포트로 실제 들어가는 유량을 구분합니다. 압력 제한·행정 끝에서는 P 포트 유입은 0이어도 분기 전 펌프 유량은 유지됩니다.';
  } else if (partId === 'port-T') {
    pressure('T 포트 게이지압', p.T);
    flow('방향밸브 T 복귀 유량', q.valveToTank);
    flow('외부에서 합류하는 릴리프', q.reliefToTank);
    flow('합류 후 필터 유량', d.circuit.returnCombinedM3s);
    note = '방향밸브 T 포트를 나온 뒤 릴리프 복귀가 합류합니다. T 포트 자체와 합류 후 복귀관의 유량은 서로 다를 수 있습니다. 반환측의 압력 손실은 무시합니다.';
  } else if (['relief-adjuster', 'relief-spring'].includes(partId)) {
    pressure('설정 압력 한계', state.settings.reliefPressurePa);
    pressure('현재 공급 압력', p.P);
    force('설정 압력에서 전진 힘 한계', f.extendLimitN);
    force('설정 압력에서 후진 힘 한계', f.retractLimitN);
    flow('릴리프 우회 유량', q.reliefToTank);
    add('릴리프 소산 동력', w.reliefW, 'W');
    note = '압력 한계는 항상 발생하는 압력이 아닙니다. 반대측 0 Pa에서 각 유효 면적에 곱한 힘 한계를 구분합니다. 실제 스프링 예압·변형·밸브 유량 특성은 계산하지 않습니다.';
  } else if (['relief-body', 'relief-poppet', 'line-relief'].includes(partId)) {
    pressure('릴리프 입구 압력', p.P);
    pressure('설정 압력 한계', state.settings.reliefPressurePa);
    flow('릴리프 우회 유량', q.reliefToTank);
    add('릴리프 소산 동력', w.reliefW, 'W');
    add('누적 릴리프 소산', d.energy.reliefJ / 1000, 'kJ', 2);
    add('이상 우회 상태', q.reliefToTank > 0 ? '열림' : '닫힘');
    note = '압력 한계·행정 끝 정지에서 펌프 전량이 우회합니다. 소산은 (pP−pT)×유량이며 오일 온도로 환산하지 않습니다. 포핏 이동·스프링 압축은 대표 작동 표현입니다.';
  } else if (partId === 'piston-seal') {
    pressure('A 액실 압력', p.A); pressure('B 액실 압력', p.B);
    pressure('A−B 압력 차', p.A - p.B);
    force('현재 순유압력', f.netHydraulicN);
    flow('가정한 내부 누설 유량', 0);
    note = '피스톤 씰은 두 액실을 구분합니다. 누설 0은 모형 가정이며 실제 씰 성능이나 국부 접촉 하중을 뜻하지 않습니다. 단면적이 달라 압력 차에 한 면적만 곱하면 순유압력이 되지 않습니다. ' + (d.circuit.isolatedHold ? holdNote : '');
  } else if (['rod-guide', 'rod-seal', 'wiper'].includes(partId)) {
    add('로드 지름', DIMENSIONS_SI.rodDiameterM * 1000, 'mm');
    add('현재 로드 위치', m.positionM * 1000, 'mm');
    add('로드 속도 · 전진 +', m.velocityMps * 1000, 'mm/s', 2);
    pressure('로드측 액실 압력', p.B);
    add('접촉 하중·마찰·누설', '계산하지 않음');
    note = '로드측 액실의 작동 조건을 함께 표시합니다. 그 압력이 선택한 외측 와이퍼나 가이드 전체에 그대로 걸린다는 뜻은 아닙니다. 마찰·마모·씰 변형·외부 누설은 해석하지 않습니다.';
  } else {
    force('현재 순유압력', f.netHydraulicN);
    add('펌프 유압 동력', w.pumpW, 'W'); add('부하 전달 동력', w.loadW, 'W'); add('릴리프 소산 동력', w.reliefW, 'W');
    add('유체 체적 수지 잔차', d.balance.volumeResidualM3 * 1e6, 'mL', 6);
    add('누적 에너지 수지 잔차', d.balance.energyResidualJ, 'J', 6);
    note = '이상 유압 회로 전체의 작동값입니다. 선택 부품의 개별 응력·온도·수명 해석이 아닙니다.';
  }
  return { facts, note };
}
