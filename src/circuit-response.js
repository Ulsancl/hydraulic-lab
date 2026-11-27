import { DIMENSIONS_SI, SETTINGS_LIMITS_SI, instantSnapshot, setCommand } from './model.js';

const toBar = pressure => pressure / 1e5;
const toLpm = flow => flow * 60000;
const pressureScaleBar = toBar(SETTINGS_LIMITS_SI.reliefPressurePa.max);
// The 20 L/min scale also accommodates the larger cap-side return on retraction.
const flowScaleLpm = 20;
const oneDecimal = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pressureText = bar => bar > 0 && bar < .05 ? '<0.1' : oneDecimal.format(bar);
const flowText = lpm => lpm > 0 && lpm < .005 ? '<0.01' : twoDecimals.format(lpm);

const ports = [
  { id: 'P', label: '공급', flow: 'supplyToValve', into: '밸브 유입' },
  { id: 'A', label: '캡측 액실', flow: 'capIntoCylinder', into: '액실 유입', out: '액실 배출' },
  { id: 'B', label: '로드측 액실', flow: 'rodIntoCylinder', into: '액실 유입', out: '액실 배출' },
  { id: 'T', label: '밸브 복귀', flow: 'valveToTank', into: '밸브 유출' },
];
const branches = [
  { id: 'pump', label: '펌프 토출' },
  { id: 'relief', label: '릴리프 우회' },
  { id: 'combined', label: '필터 합류' },
];
const directions = [['extend', '전진'], ['retract', '후진']];
const statuses = { moving: '이동', 'pressure-limit': '압력 한계 정지', 'end-stop': '행정 끝 정지' };
const comparisonRows = [
  ['status', '작동 상태'], ['pressure', 'P 압력'], ['returnPressure', 'T 배압'],
  ['valveReturn', '밸브 복귀'], ['relief', '릴리프 우회'], ['speed', '이동 속도'],
];
let chart;

const pressureTrack = '<span class="response-track response-pressure" aria-hidden="true"><i></i></span>';
const flowTrack = '<span class="response-track response-flow" aria-hidden="true"><i></i></span>';

function mountChart() {
  const section = document.createElement('section');
  section.className = 'circuit-response';
  section.setAttribute('aria-labelledby', 'circuit-response-title');
  section.innerHTML = `
    <h3 id="circuit-response-title">회로 응답</h3>
    <p class="response-scale">막대 범위 · 압력 0–${pressureScaleBar} bar · 유량 0–${flowScaleLpm} L/min</p>
    <table class="response-table" aria-label="방향밸브 포트 계측">
      <thead><tr><th scope="col">포트</th><th scope="col">게이지압 · bar</th><th scope="col">유량 · L/min</th></tr></thead>
      <tbody>${ports.map(({ id, label }) => `
        <tr data-port="${id}">
          <th scope="row"><b>${id}</b> ${label}</th>
          <td class="response-value"><span data-pressure></span>${pressureTrack}</td>
          <td class="response-value"><span data-flow></span> <span data-channel></span>${flowTrack}</td>
        </tr>`).join('')}</tbody>
    </table>
    <dl class="response-branches" aria-label="분기와 합류 유량">${branches.map(({ id, label }) => `
      <div data-branch="${id}">
        <dt>${label}</dt><dd><span data-flow></span> <small>L/min</small>${flowTrack}</dd>
        ${id === 'relief' ? '<dd class="response-relief-state"><strong data-relief-state></strong> <span data-relief-setting></span></dd>' : ''}
      </div>`).join('')}
    </dl>
    <table class="response-table response-comparison" aria-describedby="circuit-comparison-context">
      <caption>전진·후진 비교 <span id="circuit-comparison-context">현재 위치와 적용된 설정에서 명령별 예상값</span></caption>
      <thead><tr><td></td>${directions.map(([id, label]) => `<th scope="col" data-direction="${id}">${label} <small hidden>현재</small></th>`).join('')}</tr></thead>
      <tbody>${comparisonRows.map(([key, label]) => `<tr data-comparison="${key}"><th scope="row">${label}</th><td></td><td></td></tr>`).join('')}</tbody>
    </table>`;
  document.getElementById('circuit-note').after(section);
  return {
    ports: ports.map(port => {
      const row = section.querySelector(`[data-port="${port.id}"]`);
      return { ...port, row, pressureValue: row.querySelector('[data-pressure]'), flowValue: row.querySelector('[data-flow]'),
        channel: row.querySelector('[data-channel]'), pressureBar: row.querySelector('.response-pressure i'), flowBar: row.querySelector('.response-flow i') };
    }),
    branches: branches.map(branch => {
      const card = section.querySelector(`[data-branch="${branch.id}"]`);
      return { ...branch, card, value: card.querySelector('[data-flow]'), bar: card.querySelector('.response-flow i') };
    }),
    reliefState: section.querySelector('[data-relief-state]'),
    reliefSetting: section.querySelector('[data-relief-setting]'),
    comparison: directions.map(([direction], index) => ({
      direction, heading: section.querySelector(`[data-direction="${direction}"]`),
      values: comparisonRows.map(([key]) => section.querySelector(`[data-comparison="${key}"]`).cells[index + 1]),
    })),
  };
}

function fillBar(bar, value, scale) {
  bar.style.width = `${Math.min(100, value / scale * 100)}%`;
}

function updateLive(detail, reliefPressurePa) {
  const { pressuresPa, returnBackpressurePa, flowsM3s, returnCombinedM3s, isolatedHold } = detail.circuit;
  const liveKey = [pressuresPa.P, pressuresPa.A, pressuresPa.B, returnBackpressurePa,
    ...ports.map(port => flowsM3s[port.flow]), flowsM3s.pumpFromTank, flowsM3s.reliefToTank, returnCombinedM3s, isolatedHold, reliefPressurePa].join('|');
  if (chart.liveKey === liveKey) return;
  chart.liveKey = liveKey;

  for (const port of chart.ports) {
    const bar = toBar(port.id === 'T' ? returnBackpressurePa : pressuresPa[port.id]);
    const flow = flowsM3s[port.flow], magnitude = toLpm(Math.abs(flow));
    const isolated = isolatedHold && (port.id === 'A' || port.id === 'B');
    port.pressureValue.textContent = pressureText(bar);
    port.flowValue.textContent = flowText(magnitude);
    port.channel.textContent = isolated ? '고립' : flow < 0 ? port.out : flow > 0 ? port.into : '유량 없음';
    port.row.dataset.channelState = isolated ? 'isolated' : flow === 0 ? 'idle' : 'flowing';
    fillBar(port.pressureBar, bar, pressureScaleBar);
    fillBar(port.flowBar, magnitude, flowScaleLpm);
  }
  const branchFlows = { pump: flowsM3s.pumpFromTank, relief: flowsM3s.reliefToTank, combined: returnCombinedM3s };
  const relieving = flowsM3s.reliefToTank > 0;
  for (const branch of chart.branches) {
    const lpm = toLpm(branchFlows[branch.id]);
    branch.value.textContent = flowText(lpm);
    fillBar(branch.bar, lpm, flowScaleLpm);
    if (branch.id === 'relief') branch.card.dataset.open = String(relieving);
  }
  chart.reliefState.textContent = relieving ? '열림' : '닫힘';
  chart.reliefSetting.textContent = `설정 ${pressureText(toBar(reliefPressurePa))} bar`;
}

function updateComparison(state, snapshot) {
  // For these operating-point values the ideal model uses position only to detect end stops.
  const atEnd = state.positionM === 0 ? 'retract' : state.positionM === DIMENSIONS_SI.strokeM ? 'extend' : '';
  const { pumpFlowM3s, reliefPressurePa, resistingForceN, pumpCommandRatio, returnRestrictionPaPerM3s } = state.settings;
  const comparisonKey = [state.command, atEnd, pumpFlowM3s, reliefPressurePa, resistingForceN, pumpCommandRatio, returnRestrictionPaPerM3s].join('|');
  if (chart.comparisonKey === comparisonKey) return;
  chart.comparisonKey = comparisonKey;

  for (const { direction, heading, values } of chart.comparison) {
    const current = state.command === direction;
    const point = current ? snapshot : instantSnapshot(setCommand(state, direction));
    const velocity = point.velocityMps * 1000;
    const speed = Math.abs(velocity);
    const velocityText = speed > 0 && speed < .005
      ? `${velocity < 0 ? '←' : '→'} <0.01`
      : `${velocity < 0 ? '−' : velocity > 0 ? '+' : ''}${twoDecimals.format(speed)}`;
    heading.querySelector('small').hidden = !current;
    if (current) heading.setAttribute('aria-current', 'true');
    else heading.removeAttribute('aria-current');
    const readouts = [
      statuses[point.status],
      `${pressureText(toBar(point.portsPa.P))} bar`,
      `${pressureText(toBar(point.returnBackpressurePa ?? point.portsPa.T))} bar`,
      `${flowText(toLpm(point.flowsM3s.valveToTank))} L/min`,
      `${flowText(toLpm(point.flowsM3s.reliefToTank))} L/min`,
      `${velocityText} mm/s`,
    ];
    values.forEach((element, index) => { element.textContent = readouts[index]; });
  }
}

export function renderCircuitResponse(state, snapshot, detail) {
  chart ??= mountChart();
  updateLive(detail, state.settings.reliefPressurePa);
  updateComparison(state, snapshot);
}
