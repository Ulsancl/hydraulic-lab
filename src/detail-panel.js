import { hydraulicDetail } from './detail-model.js';
import { describeHydraulicDetail } from './detail-readouts.js';

const format = (value, digits = 2) => Number.isFinite(value)
  ? (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : typeof value === 'string' ? value : '—';
const setText = (id, value) => { const element = document.getElementById(id); if (element.textContent !== value) element.textContent = value; };

function facts(list, values) {
  const signature = values.map(fact => fact.label).join('|');
  if (list.dataset.signature !== signature) {
    list.replaceChildren(...values.map(fact => {
      const row = document.createElement('div'); row.className = 'detail-fact'; row.dataset.label = fact.label;
      const label = document.createElement('dt'); label.textContent = fact.label;
      row.append(label, document.createElement('dd')); return row;
    }));
    list.dataset.signature = signature;
  }
  values.forEach((fact, index) => {
    const row = list.children[index], value = `${format(fact.value, fact.digits ?? 2)}${fact.unit ? ' ' + fact.unit : ''}`;
    row.dataset.value = String(fact.value); row.dataset.unit = fact.unit ?? '';
    if (row.lastElementChild.textContent !== value) row.lastElementChild.textContent = value;
  });
}

export function renderHydraulicDetails(state, snapshot, view) {
  const d = hydraulicDetail(state, snapshot), description = describeHydraulicDetail(view.selectedPart, state, snapshot);
  for (const prefix of ['part', 'focus']) {
    facts(document.getElementById(`${prefix}-detail-facts`), description.facts);
    setText(`${prefix}-detail-note`, description.note);
  }
  const reference = `적용 조건 · ${format(state.settings.pumpFlowM3s * 60000)} L/min · ${format(state.settings.reliefPressurePa / 1e5, 1)} bar 상한`;
  setText('detail-reference', reference); setText('focus-detail-reference', reference);
  document.getElementById('focus-part-select').value = view.selectedPart;

  const limit = Math.max(d.force.extendLimitN, d.force.retractLimitN);
  for (const [id, value] of [['A', d.force.capN], ['B', d.force.rodN], ['net', d.force.netHydraulicN]]) {
    const bar = document.getElementById(`force-${id}`), width = Math.min(50, Math.abs(value) / limit * 50);
    bar.style.width = `${width}%`; bar.style.left = `${value < 0 ? 50 - width : 50}%`;
    bar.dataset.value = String(value); bar.dataset.limit = String(limit);
    setText(`force-value-${id}`, `${value > 0 ? '+' : ''}${format(value / 1000)} kN`);
  }
  setText('force-scale', `같은 눈금 · ±${format(limit / 1000)} kN · 설정 상한 × 캡측 면적`);
  setText('force-note', state.command === 'neutral'
    ? '중립에서는 양실 압력이 남아 유압력이 있어도 위치는 고정됩니다. 외부 반력과 평형을 이루는 이상 잠금입니다.'
    : snapshot.status === 'moving'
      ? 'A측 힘은 전진, B측 힘은 후진 방향입니다. 두 힘의 합이 부하 저항과 평형을 이루며 일정한 속도로 움직입니다.'
      : '실제 유압력과 설정한 저항 부하는 다를 수 있습니다. 압력 한계 또는 끝 지지의 반력으로 정지합니다.');

  for (const key of ['pump', 'load', 'relief']) {
    const value = d.power[`${key}W`], output = document.getElementById(`power-value-${key}`);
    output.dataset.value = String(value); output.textContent = `${format(value, 1)} W`;
    if (key !== 'pump') {
      const share = d.power.pumpW > 0 ? value / d.power.pumpW : 0;
      const bar = document.getElementById(`power-share-${key}`);
      bar.style.width = `${Math.max(0, Math.min(100, share * 100))}%`; bar.dataset.share = String(share);
    }
  }
  setText('power-note', d.power.pumpW === 0
    ? '현재 이상 모형의 유압 동력은 0 W입니다. 유량이 0이라는 뜻은 아니며, 펌프 기계 손실을 포함한 효율도 아닙니다.'
    : snapshot.status === 'moving'
      ? '펌프의 유압 동력이 부하의 일로 전달됩니다. 이 모형은 마찰·배관·펌프 기계 손실을 계산하지 않습니다.'
      : '피스톤이 정지하므로 부하 동력은 0 W이고, 펌프의 유압 동력은 릴리프에서 소산됩니다.');
  setText('fluid-inventory', `세 공간의 오일 합계 ${format(d.balance.fluidVolumeM3 * 1000, 3)} L`);
  setText('fluid-rate', `탱크 순유입 ${format(d.tank.rateM3s * 60000)} L/min · +는 탱크로 유입`);
  document.getElementById('fluid-inventory').dataset.value = String(d.balance.fluidVolumeM3);
  document.getElementById('fluid-rate').dataset.value = String(d.tank.rateM3s);
}
