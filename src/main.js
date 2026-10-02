import './style.css';
import './detail.css';
import { hydraulicDetail } from './detail-model.js';
import { renderHydraulicDetails } from './detail-panel.js';
import { createExperiment, setCommand, reconfigureExperiment, instantSnapshot, step as modelStep, MAX_STEP_SECONDS, MAX_SIMULATION_TIME_S } from './model.js';
import { createProject, parseProject, serializeProject, normalizeView, normalizePlaybackRate, DEFAULT_VIEW } from './project.js';
import { LESSONS } from './lessons.js';
import { createGuide, observeGuide, GUIDE_STEP_COUNTS } from './guide.js';
import { HydraulicScene } from './scene.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'hydraulic-lab-project-v1';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const desktop = window.hydraulicDesktop;
const commands = { extend: '전진', neutral: '중립', retract: '후진' };
const statuses = { neutral: '중립 순환', moving: '이동 중', 'pressure-limit': '압력 한계로 정지', 'end-stop': '행정 끝 도달' };
let state = createExperiment(), snapshot = instantSnapshot(state), view = normalizeView(DEFAULT_VIEW), playbackRate = 1;
let scene, running = false, busy = false, restoring = false, focused = false, lessonId = null, externalClock = false;
let guide = null, guideRenderKey = null;
let initialCamera = null, previousExperiment = null, recoveredRaw = null, storageBlocked = false;
let saveTimer, toastTimer, lastFrame = performance.now(), lastReadout = 0, lastAutosave = 0;

const number = (value, digits = 2) => (Math.abs(value) < .5 * 10 ** -digits ? 0 : value).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const text = (id, value) => { $(id).textContent = value; };
const quantity = (id, value, unit, digits = 2) => { $(id).replaceChildren(document.createTextNode(`${number(value, digits)} `), Object.assign(document.createElement('small'), { textContent: unit })); };
const energyText = value => value >= 10000 ? `${number(value / 1000, 2)} kJ` : `${number(value, 2)} J`;

function toast(message) {
  text('#toast', message); $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function capture() {
  return createProject({ state, playbackRate, view, camera: scene?.getCameraState() ?? initialCamera });
}
function saveLocal() {
  clearTimeout(saveTimer);
  if (storageBlocked || restoring) return;
  try {
    localStorage.setItem(STORAGE_KEY, serializeProject(capture()));
    text('#save-status', '이 기기에 자동 저장됨');
  } catch { text('#save-status', '자동 저장을 완료하지 못했습니다 · 실험 파일로 보관하세요'); }
}
function scheduleSave() {
  if (restoring || storageBlocked) return;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 220);
}
function protectOriginal(raw, futureVersion) {
  // Keep the original primary key untouched for corrupt as well as future data.
  // A backup is extra protection; successful backup does not authorize overwrite.
  recoveredRaw = raw; storageBlocked = true;
  try { localStorage.setItem(`${STORAGE_KEY}-original-${Date.now()}`, raw); } catch { /* The primary original remains untouched. */ }
  $('#storage-recovery').hidden = false;
  if (futureVersion) {
    text('#storage-recovery strong', '더 새로운 버전에서 저장한 실험입니다.');
    text('#storage-recovery p', '기존 자동 저장 원문을 유지합니다. 이 버전에서 진행한 실험은 별도 파일로 보관하세요.');
  }
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== null) {
    try {
      const saved = parseProject(raw);
      state = saved.state; ({ view, playbackRate, camera: initialCamera } = saved.observation);
      snapshot = instantSnapshot(state);
    } catch (error) { protectOriginal(raw, error.futureVersion); }
  }
} catch { storageBlocked = true; text('#save-status', '자동 저장을 사용할 수 없습니다 · 실험 파일로 보관하세요'); }

function syncPlayback() {
  text('#play', running ? 'Ⅱ 일시정지' : '▶ 재생');
  $('#play').setAttribute('aria-label', running ? '일시정지' : '재생');
  text('#running-indicator', running ? `관찰 재생 중 · ${number(playbackRate, playbackRate % 1 ? 2 : 0)}×` : '관찰 일시정지');
  $('#running-indicator').classList.toggle('running', running);
  $('.circuit-panel').classList.toggle('animating', running);
  renderGuide();
}
function stop() {
  const wasRunning = running;
  running = false; externalClock = false; syncPlayback();
  if (wasRunning) refresh(true, 0);
  scheduleSave();
}
function begin() {
  if (busy) return;
  if (state.timeS >= MAX_SIMULATION_TIME_S) { toast('이 실험의 시간 범위에 도달했습니다. 새 조건 또는 새 실험으로 시작하세요.'); return; }
  running = true; externalClock = false; lastFrame = performance.now(); syncPlayback();
}
function toggle() { if (running) stop(); else begin(); }
function setBusy(value) {
  busy = value; $('#save-project').disabled = value; $('#open-project').disabled = value;
  if (desktop?.setBusy) Promise.resolve(desktop.setBusy(value)).catch(() => {});
}
function syncSettings() {
  $('#pump-flow').value = state.settings.pumpFlowM3s * 60000;
  $('#relief-pressure').value = state.settings.reliefPressurePa / 100000;
  $('#resisting-force').value = state.settings.resistingForceN / 1000;
  text('#applied-settings', `적용 중: ${number(state.settings.pumpFlowM3s * 60000, 2)} L/min · ${number(state.settings.resistingForceN / 1000, 2)} kN · ${number(state.settings.reliefPressurePa / 100000, 1)} bar`);
}
function syncControls({ settings = false } = {}) {
  if (settings) syncSettings();
  $$('[data-command]').forEach(button => button.setAttribute('aria-pressed', button.dataset.command === state.command));
  $$('[data-mode]').forEach(button => button.setAttribute('aria-pressed', button.dataset.mode === view.mode));
  $$('[data-layer]').forEach(input => { input.checked = view.layers[input.dataset.layer]; });
  $('#explode').value = view.explode; $('#explode').disabled = view.mode !== 'exploded';
  $('#labels').checked = view.labels; $('#pressure-colors').checked = view.pressureColors; $('#flow-arrows').checked = view.flowArrows;
  $('#part-select').value = view.selectedPart;
  const rate = $('#playback-rate');
  rate.querySelector('[data-custom]')?.remove();
  if (![...rate.options].some(option => Number(option.value) === playbackRate)) {
    const option = document.createElement('option'); option.dataset.custom = 'true'; option.value = String(playbackRate); option.textContent = `${number(playbackRate, 3)}×`; rate.append(option);
  }
  rate.value = String(playbackRate);
  $$('[data-lesson]').forEach(button => button.setAttribute('aria-pressed', button.dataset.lesson === lessonId));
  syncPlayback();
}
function rememberExperiment() {
  previousExperiment = { project: capture(), guide: structuredClone(guide) };
  $('#undo-new').hidden = false;
}
function showLesson(id, restoredGuide = null) {
  lessonId = id;
  const lesson = LESSONS.find(item => item.id === id);
  guide = lesson ? structuredClone(restoredGuide ?? createGuide(id)) : null; guideRenderKey = null;
  $('#lesson-guide').hidden = !lesson;
  $('#lesson-picker').open = !lesson;
  text('#lesson-picker-title', lesson ? '다른 실험 고르기' : '어디부터 볼까요?');
  if (lesson) {
    text('#lesson-title', lesson.title); text('#lesson-question', lesson.question);
    $('#lesson-steps').replaceChildren(...lesson.instructions.map((instruction, index) => {
      const item = document.createElement('li'); item.dataset.guideStep = String(index);
      const description = Object.assign(document.createElement('span'), { textContent: instruction });
      const status = document.createElement('b'); status.className = 'guide-step-state';
      item.append(description, status); return item;
    }));
  }
  $$('[data-lesson]').forEach(button => button.setAttribute('aria-pressed', button.dataset.lesson === id));
  renderGuide();
}
function readProject(project, { guideState = null } = {}) {
  // Complete validation precedes replacement. No createProject fallback is used
  // for input files, and no loaded state is advanced or rounded for display.
  const validated = parseProject(serializeProject(project));
  restoring = true;
  try {
    stop(); state = validated.state; ({ view, playbackRate } = validated.observation);
    showLesson(guideState?.lessonId ?? null, guideState); syncControls({ settings: true }); refresh(true);
    if (validated.observation.camera) scene.setCameraState(validated.observation.camera);
    else scene.resetCamera();
  } finally { restoring = false; }
  saveLocal();
}
function newExperiment() {
  if (busy) return;
  rememberExperiment(); stop(); state = createExperiment(); view = normalizeView(DEFAULT_VIEW); playbackRate = 1;
  showLesson(null); syncControls({ settings: true }); refresh(true); scene.resetCamera(); saveLocal();
  toast('중간 위치의 새 실험입니다. 되돌리기로 이전 실험을 복구할 수 있습니다.');
}
function startLesson(id) {
  if (busy) return;
  const lesson = LESSONS.find(item => item.id === id); if (!lesson) return;
  rememberExperiment(); stop();
  state = setCommand(createExperiment(lesson.settings, { positionM: lesson.positionM }), lesson.initialCommand);
  showLesson(id); syncControls({ settings: true }); refresh(true); saveLocal();
  toast(`“${lesson.title}” 준비 완료. 재생을 누르고 안내 순서대로 관찰하세요.`);
}
function changeCommand(command) {
  if (busy) return;
  const before = state; state = setCommand(state, command);
  guide = observeGuide(guide, { type: 'command', before, after: state });
  syncControls(); refresh(true); scheduleSave();
}
function selectPart(id) {
  if (!scene?.getComponents().some(part => part.id === id)) return;
  view.selectedPart = id; syncControls(); refresh(true); scheduleSave();
}
function advance(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new RangeError('진행 시간은 0 이상의 유한한 초여야 합니다.');
  if (state.timeS + seconds > MAX_SIMULATION_TIME_S) throw new RangeError('실험 시간은 1,000,000,000초 이하여야 합니다.');
  // Long foreground frames are partitioned to the pure model's input limit;
  // no elapsed time is discarded, including the relief interval at a stop.
  let remaining = seconds;
  while (remaining > 0) {
    const duration = Math.min(remaining, MAX_STEP_SECONDS);
    const before = state, result = modelStep(state, duration); state = result.state;
    guide = observeGuide(guide, { type: 'advance', before, after: state, interval: result.interval });
    remaining -= duration;
  }
  snapshot = instantSnapshot(state);
}
function manualStep(seconds = .1) {
  stop(); advance(seconds); lastFrame = performance.now(); refresh(true, seconds); saveLocal();
  return structuredClone(state);
}
function focusView() {
  focused = !focused; document.body.classList.toggle('focus-mode', focused);
  text('#focus-view', focused ? '전체 화면 구성' : '크게 보기');
  requestAnimationFrame(() => $('#workspace').scrollIntoView({ block: 'start' }));
}

function guideAction() {
  if (guide.status === 'interrupted') return guide.notice;
  if (guide.status === 'completed') return '관찰을 완료했습니다. 확인한 결과를 비교하거나 자유 탐구로 전환해 다른 조건을 시험하세요.';
  const run = running ? '재생 중입니다.' : '재생 또는 +0.1초를 누르세요.';
  if (guide.lessonId === 'speed-ratio') {
    const outward = guide.stepIndex === 0, command = outward ? 'extend' : 'retract';
    return `${state.command === command ? '' : `${commands[command]}을 선택하세요. `}${run} ${outward ? '300 mm 전진 끝' : '0 mm 수축 끝'}까지 이동해야 이 단계가 확인됩니다.`;
  }
  if (guide.lessonId === 'pressure-limit') {
    if (guide.stepIndex === 0) return `${state.command === 'retract' ? '' : '후진을 선택하세요. '}${run} 피스톤은 정지해도 릴리프 유량과 손실 에너지가 생기는지 확인합니다.`;
    if (guide.stepIndex === 1) return `${state.command === 'extend' ? '' : '전진을 선택하세요. '}${run} 같은 20 bar에서 1 mm 이상 실제 이동하면 확인됩니다.`;
    if (!guide.pressureChangeApplied) return '압력 제한을 50 bar로 입력하고 새 조건 적용을 누르세요. 유량 6 L/min과 부하 4 kN은 유지합니다. 그다음 후진을 선택합니다.';
    return `${state.command === 'retract' ? '' : '후진을 선택하세요. '}${run} 50 bar 조건에서 1 mm 이상 실제 이동해 이전 정지 상태와 비교합니다.`;
  }
  if (guide.stepIndex === 0) return `${state.command === 'extend' ? '' : '전진을 선택하세요. '}${run} 1 mm 이상 이동하며 A측 압력이 생기는지 확인합니다.`;
  if (guide.stepIndex === 1) return `${state.command === 'extend' ? '' : '전진을 선택한 뒤 ' }중립을 선택하세요. 일시정지는 시간을 멈추고, 중립은 유로를 바꾸는 서로 다른 조작입니다.`;
  return `${run} 중립에서 모형 시간을 진행해 위치·A/B 압력은 그대로이고 P→T로 오일이 순환하는지 확인합니다.`;
}
function guideEvidenceText() {
  if (!guide.evidence.length) return '아직 확인된 결과가 없습니다. 안내대로 실험을 진행하면 모형에서 확인한 값이 기록됩니다.';
  if (guide.lessonId === 'speed-ratio') {
    const [outward, inward] = guide.evidence;
    const outwardText = `전진: ${number(outward.distanceM * 1000, 0)} mm / 이동 ${number(outward.movingTimeS, 3)} s = ${number(outward.speedMps * 1000, 2)} mm/s. 캡측 면적 ${number(outward.areaM2 * 1e6, 1)} mm².`;
    return inward ? `${outwardText}\n후진: ${number(inward.distanceM * 1000, 0)} mm / 이동 ${number(inward.movingTimeS, 3)} s = ${number(inward.speedMps * 1000, 2)} mm/s. 로드측 면적 ${number(inward.areaM2 * 1e6, 1)} mm².\n같은 유량에서 후진 속력은 ${number(inward.speedMps / outward.speedMps, 2)}배입니다. 행정 끝에서 릴리프가 흐른 시간은 이동 시간에서 제외했습니다.` : `${outwardText}\n후진 한 행정까지 관찰하면 면적과 속력의 관계를 비교할 수 있습니다.`;
  }
  if (guide.lessonId === 'pressure-limit') {
    const [blocked, outward, inward] = guide.evidence;
    const rows = [`20 bar 후진: 힘 한계 ${number(blocked.forceLimitN / 1000, 3)} kN < 저항 ${number(blocked.loadN / 1000, 1)} kN. 정지 상태에서 ${number(blocked.reliefFlowM3s * 60000, 2)} L/min이 릴리프로 돌아갔습니다.`];
    if (outward) rows.push(`20 bar 전진: 힘 한계 ${number(outward.forceLimitN / 1000, 3)} kN. ${number(outward.distanceM * 1000, 2)} mm 실제 이동을 확인했습니다.`);
    if (inward) rows.push(`50 bar 후진: 힘 한계 ${number(inward.forceLimitN / 1000, 3)} kN. ${number(inward.distanceM * 1000, 2)} mm 이동했습니다. 유량은 그대로이며 압력 제한을 높여 가능한 힘이 커졌습니다.`);
    return rows.join('\n');
  }
  const [moving, isolation, held] = guide.evidence;
  const rows = [`전진 ${number(moving.distanceM * 1000, 2)} mm와 A측 ${number(moving.pressureAPa / 1e5, 2)} bar를 확인했습니다.`];
  if (isolation) rows.push(`중립 전환: 위치 ${number(isolation.positionM * 1000, 2)} mm, A ${number(isolation.pressureAPa / 1e5, 2)} / B ${number(isolation.pressureBPa / 1e5, 2)} bar를 고립시켰습니다.`);
  if (held) rows.push(`${number(held.observedDurationS, 3)} s 진행 후 위치·양실 압력은 그대로입니다. P는 ${number(held.pumpPressurePa / 1e5, 1)} bar, 복귀는 ${number(held.returnFlowM3s * 60000, 2)} L/min입니다. 비압축성·누설 없음의 이상화에 따른 결과입니다.`);
  return rows.join('\n');
}
function renderGuide() {
  $('#guide-cue').hidden = !guide;
  if (!guide) return;
  const key = JSON.stringify([guide.stepIndex, guide.status, guide.evidence, guide.notice, guide.pressureChangeApplied, state.command, running]);
  if (key === guideRenderKey) return; guideRenderKey = key;
  const total = GUIDE_STEP_COUNTS[guide.lessonId], completed = guide.status === 'completed';
  const status = completed ? '관찰 완료' : guide.status === 'interrupted' ? '안내 중단' : `${guide.stepIndex + 1} / ${total} 단계`;
  text('#guide-status', status); text('#guide-cue-status', `${LESSONS.find(item => item.id === guide.lessonId).title} · ${status}`);
  text('#guide-action', guideAction()); text('#guide-cue-action', guideAction()); text('#guide-result', guideEvidenceText());
  $('#guide-progress').value = guide.stepIndex; $('#guide-progress').max = total;
  $('#lesson-guide').dataset.status = guide.status;
  $$('[data-guide-step]').forEach((item, index) => {
    const done = index < guide.stepIndex, active = !completed && index === guide.stepIndex;
    item.classList.toggle('confirmed', done); item.classList.toggle('current', active);
    item.querySelector('.guide-step-state').textContent = done ? '확인됨' : active ? '현재 단계' : '대기';
    if (active) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
}

function pressureColor(pressurePa) {
  const ratio = Math.max(0, Math.min(1, pressurePa / 1e7));
  const low = [103, 216, 232], high = [255, 197, 109];
  return `rgb(${low.map((value, index) => Math.round(value + (high[index] - value) * ratio)).join(' ')})`;
}
function flowStyle(element, flow, pressure) {
  element.dataset.flowM3s = String(flow); element.dataset.pressurePa = String(pressure);
  element.style.stroke = view.pressureColors ? pressureColor(pressure) : '#9aafc1';
  const flowing = Math.abs(flow) > 1e-12 && view.flowArrows;
  element.classList.toggle('has-flow', flowing); element.classList.toggle('reverse-flow', flow < 0);
  element.removeAttribute('marker-start'); element.removeAttribute('marker-end');
  if (flowing) element.setAttribute(flow < 0 ? 'marker-start' : 'marker-end', 'url(#circuit-arrow)');
}
function refreshCircuit() {
  const { portsPa, flowsM3s } = snapshot;
  $$('[data-circuit-flow]').forEach(path => {
    const flow = path.dataset.circuitFlow === 'combinedReturn' ? flowsM3s.valveToTank + flowsM3s.reliefToTank : flowsM3s[path.dataset.circuitFlow];
    flowStyle(path, flow, portsPa[path.dataset.pressurePort]);
  });
  const first = $('#circuit-link-one'), second = $('#circuit-link-two');
  if (state.command === 'extend') {
    first.setAttribute('d', 'M250 206V134'); second.setAttribute('d', 'M360 134V206');
  } else if (state.command === 'retract') {
    first.setAttribute('d', 'M250 206L360 160V134'); second.setAttribute('d', 'M250 134V160L360 206');
  } else { first.setAttribute('d', 'M250 206V179H360V206'); second.setAttribute('d', ''); }
  flowStyle(first, flowsM3s.supplyToValve, portsPa.P);
  flowStyle(second, state.command === 'neutral' ? 0 : flowsM3s.valveToTank, portsPa.T);
  $('#circuit-isolated').style.display = state.command === 'neutral' ? '' : 'none';
  const pistonX = 238 + state.positionM / .3 * 169;
  $('#circuit-piston').setAttribute('d', `M${pistonX} 40V87M${pistonX} 64H${pistonX + 85}`);
  text('#circuit-command', commands[state.command]);
  text('#circuit-pressure-label', `P ${number(portsPa.P / 1e5, 1)} bar`);
  text('#circuit-relief-label', `릴리프 ${number(state.settings.reliefPressurePa / 1e5, 1)} bar`);
  text('#circuit-connections', snapshot.connections.map(connection => connection.replace('-', ' ↔ ')).join(' / '));
  text('#circuit-note', state.command === 'neutral'
    ? '중립: P→T로 오일이 순환합니다. A·B는 고립되어 압력이 남아도 유량은 0입니다.'
    : snapshot.status === 'moving'
      ? '실선 색은 압력, 화살표는 유량 방향입니다. 공급과 복귀 유량은 양쪽 유효 면적에 따라 다릅니다.'
      : '실린더 유량은 0입니다. 압력은 남아 있고 펌프 유량은 릴리프를 통해 탱크로 돌아갑니다.');
}
function refreshReadouts() {
  const { status, portsPa, flowsM3s, volumesM3, powerW } = snapshot;
  const stopped = status === 'pressure-limit' || status === 'end-stop';
  text('#status-badge', statuses[status]); $('#status-badge').classList.toggle('attention', stopped);
  const description = status === 'neutral'
    ? 'P→T는 순환하고 A·B는 막혀 있습니다. 양실 압력은 마지막 상태를 이상적으로 유지합니다.'
    : status === 'moving'
      ? `${commands[state.command]}: 부하를 이길 압력이 만들어집니다. 속도는 공급 유량과 선택된 액실 면적으로 정해집니다.`
      : status === 'pressure-limit'
        ? '필요한 힘이 이 방향의 압력 한계에 도달했습니다. 피스톤은 정지하고 공급 유량은 릴리프로 우회합니다.'
        : '피스톤이 행정 끝에 닿았습니다. 재생을 계속하면 오일은 릴리프로 흐르며 손실 에너지가 쌓입니다.';
  text('#status-description', description);
  text('#scene-caption', `${commands[state.command]} · ${status === 'neutral' ? 'P → T 순환 / A·B 고립' : statuses[status]}`);
  for (const port of ['P', 'A', 'B']) {
    quantity(`#readout-pressure-${port}`, portsPa[port] / 1e5, 'bar', 1);
    $(`#gauge-${port}`).style.width = `${Math.min(100, portsPa[port] / 1e5)}%`;
  }
  quantity('#readout-position', state.positionM * 1000, 'mm', 1);
  quantity('#readout-velocity', snapshot.velocityMps * 1000, 'mm/s', 2);
  $('#position-indicator').style.left = `calc(${state.positionM / .3 * 100}% - 1.5px)`;
  text('#readout-force', `유압력 ${number(snapshot.hydraulicForceN / 1000, 2)} kN`);
  text('#readout-capacity', snapshot.availableForceN === null
    ? '중립 · 방향별 힘 한계는 전진/후진에서 확인'
    : `${commands[state.command]} 힘 한계 ${number(snapshot.availableForceN / 1000, 2)} kN · 저항 ${number(state.settings.resistingForceN / 1000, 2)} kN`);
  text('#readout-flow-pump', `${number(flowsM3s.pumpFromTank * 60000)} L/min`);
  text('#readout-flow-return', `${number(flowsM3s.valveToTank * 60000)} L/min`);
  text('#readout-flow-relief', `${number(flowsM3s.reliefToTank * 60000)} L/min`);
  for (const key of ['pump', 'load', 'relief']) text(`#energy-${key}`, energyText(state.energyJ[key]));
  text('#energy-summary', `펌프 일 ${energyText(state.energyJ.pump)}`);
  text('#power-relief', `${number(powerW.relief, 1)} W`);
  text('#volume-cylinder', `${number(volumesM3.cap * 1000, 3)} / ${number(volumesM3.rod * 1000, 3)} L`);
  text('#volume-tank', `${number(volumesM3.tank * 1000, 3)} L`);
  text('#elapsed-time', `${number(state.timeS, 2)} s`);
  refreshCircuit();
  renderGuide();
  $$('[data-part]').forEach(element => element.setAttribute('aria-pressed', element.dataset.part === view.selectedPart));
  const part = scene.getComponents().find(item => item.id === view.selectedPart);
  if (part) { text('#part-title', part.name); text('#part-material', part.material); text('#part-description', part.description); }
  renderHydraulicDetails(state, snapshot, view);
}
function refresh(force = false, elapsedS = 0) {
  snapshot = instantSnapshot(state);
  scene.update(snapshot, view, { command: state.command, timeS: state.timeS, elapsedS });
  const now = performance.now();
  if (!force && now - lastReadout < 80) return;
  lastReadout = now; refreshReadouts();
}

function browserDownload(contents, name) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function saveFile() {
  if (busy) return;
  stop(); setBusy(true);
  try {
    const contents = serializeProject(capture()), name = `hydraulic-lab-${new Date().toISOString().slice(0, 10)}.json`;
    if (desktop) {
      const result = await desktop.saveProject({ contents, name });
      if (result.canceled) { toast('저장을 취소했습니다. 현재 실험은 그대로 유지합니다.'); return; }
    } else browserDownload(contents, name);
    saveLocal(); toast('압력·누적 에너지·관찰 시점을 실험 파일에 저장했습니다.');
  } catch (error) { toast(`저장하지 못했습니다. ${error.message}`); }
  finally { setBusy(false); }
}
async function openFile() {
  if (busy) return;
  stop();
  if (!desktop) { $('#file-input').value = ''; $('#file-input').click(); return; }
  setBusy(true);
  try {
    const result = await desktop.openProject();
    if (result.canceled) { toast('열기를 취소했습니다. 현재 실험은 그대로 유지합니다.'); return; }
    readProject(parseProject(result.content)); toast('저장한 실험을 일시정지 상태로 복원했습니다.');
  } catch (error) { toast(`파일을 열지 못했습니다. ${error.message}`); }
  finally { setBusy(false); }
}
async function readBrowserFile(event) {
  const file = event.target.files?.[0]; if (!file) return;
  stop(); setBusy(true);
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error('실험 파일은 10 MiB 이하여야 합니다. 원본을 변경하지 않습니다.');
    const validated = parseProject(await file.text());
    readProject(validated); toast('저장한 실험을 일시정지 상태로 복원했습니다.');
  } catch (error) { toast(`파일을 열지 못했습니다. ${error.message}`); }
  finally { event.target.value = ''; setBusy(false); }
}
function showHelp() { stop(); if (!$('#help-dialog').open) $('#help-dialog').showModal(); }

try {
  restoring = true;
  scene = new HydraulicScene($('#scene'), { onSelect: selectPart, onCameraChange: () => { if (!restoring) scheduleSave(); } });
  $('#part-select').replaceChildren(...scene.getComponents().map(part => {
    const option = document.createElement('option'); option.value = part.id; option.textContent = part.name; return option;
  }));
  $('#focus-part-select').replaceChildren(...[...$('#part-select').options].map(option => option.cloneNode(true)));
  syncControls({ settings: true }); refresh(true);
  if (initialCamera) scene.setCameraState(initialCamera);
  else scene.resetCamera();
  restoring = false;

  $('#play').addEventListener('click', toggle);
  $('#step').addEventListener('click', () => { try { manualStep(.1); } catch (error) { toast(error.message); } });
  $$('[data-command]').forEach(button => button.addEventListener('click', () => changeCommand(button.dataset.command)));
  $('#settings-form').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return;
    const settings = { pumpFlowM3s: Number($('#pump-flow').value) / 60000, reliefPressurePa: Number($('#relief-pressure').value) * 100000, resistingForceN: Number($('#resisting-force').value) * 1000 };
    rememberExperiment(); stop(); const before = state; state = reconfigureExperiment(state, settings);
    guide = observeGuide(guide, { type: 'settings', before, after: state });
    syncControls({ settings: true }); refresh(true); saveLocal();
    toast('같은 위치에서 새 조건을 적용했습니다. 시간·압력·에너지는 0부터 시작합니다.');
  });
  $('#undo-new').addEventListener('click', () => {
    if (!previousExperiment || busy) return;
    const previous = previousExperiment; previousExperiment = null;
    readProject(previous.project, { guideState: previous.guide }); $('#undo-new').hidden = true;
    toast('이전 실험의 상태와 관찰 시점을 복원했습니다.');
  });
  $$('[data-lesson]').forEach(button => button.addEventListener('click', () => startLesson(button.dataset.lesson)));
  $('#guide-restart').addEventListener('click', () => { if (lessonId) startLesson(lessonId); });
  $('#guide-exit').addEventListener('click', () => {
    showLesson(null); syncControls(); toast('안내를 종료했습니다. 현재 실험 상태를 유지하며 자유롭게 탐구할 수 있습니다.');
  });
  $('#guide-details').addEventListener('click', () => {
    if (focused) focusView();
    requestAnimationFrame(() => { $('#lesson-guide').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('#guide-restart').focus({ preventScroll: true }); });
  });
  $$('[data-mode]').forEach(button => button.addEventListener('click', () => { view.mode = button.dataset.mode; syncControls(); refresh(true); scheduleSave(); }));
  $('#explode').addEventListener('input', event => { view.explode = Number(event.target.value); refresh(true); scheduleSave(); });
  $$('[data-layer]').forEach(input => input.addEventListener('change', () => { view.layers[input.dataset.layer] = input.checked; refresh(true); scheduleSave(); }));
  for (const [id, key] of [['labels', 'labels'], ['pressure-colors', 'pressureColors'], ['flow-arrows', 'flowArrows']]) {
    $(`#${id}`).addEventListener('change', event => { view[key] = event.target.checked; refresh(true); scheduleSave(); });
  }
  $('#playback-rate').addEventListener('change', event => { playbackRate = normalizePlaybackRate(Number(event.target.value)); syncPlayback(); scheduleSave(); });
  $('#part-select').addEventListener('change', event => selectPart(event.target.value));
  $('#focus-part-select').addEventListener('change', event => selectPart(event.target.value));
  document.addEventListener('click', event => { const part = event.target.closest('[data-part]'); if (part) selectPart(part.dataset.part); });
  $$('svg [data-part]').forEach(element => element.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing || event.target.isContentEditable) return;
    if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); selectPart(element.dataset.part); }
  }));
  $('#reset-camera').addEventListener('click', () => { scene.resetCamera(); scheduleSave(); });
  const focusSelectedPart = () => {
    if (scene.focusPart(view.selectedPart)) scheduleSave();
    else toast('현재 숨겨진 부품입니다. 외피·씰·배관의 표시 설정을 켠 뒤 가까이 보세요.');
  };
  $('#focus-part').addEventListener('click', focusSelectedPart);
  $('#focus-part-inline').addEventListener('click', focusSelectedPart);
  $('#focus-view').addEventListener('click', focusView);
  $('#new-project').addEventListener('click', newExperiment);
  $('#save-project').addEventListener('click', saveFile); $('#open-project').addEventListener('click', openFile);
  $('#file-input').addEventListener('change', readBrowserFile);
  $('#help').addEventListener('click', showHelp); $('#close-help').addEventListener('click', () => $('#help-dialog').close());
  $('#recover-original').addEventListener('click', () => {
    if (recoveredRaw === null) return;
    // Native saveProject intentionally only accepts valid project JSON. The
    // original-recovery download preserves even corrupt text byte for byte.
    browserDownload(recoveredRaw, 'hydraulic-lab-original.json'); toast('보호 중인 자동 저장 원문을 내려받았습니다.');
  });
  desktop?.onCommand(command => {
    if (busy) return;
    const actions = { 'new-project': newExperiment, 'open-project': openFile, 'save-project': saveFile, 'toggle-running': toggle, focus: focusView, help: showHelp };
    actions[command]?.();
  });
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.target.isContentEditable) return;
    if (event.code === 'Space' && !event.repeat && !event.target.closest('input,select,textarea,button,summary,[role="button"],dialog') && !$('#help-dialog').open) { event.preventDefault(); toggle(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); saveLocal(); } lastFrame = performance.now(); });
  window.addEventListener('beforeunload', saveLocal);

  window.hydraulicLab = {
    getState: () => structuredClone({ state, snapshot: instantSnapshot(state), view, playbackRate, running, detail: hydraulicDetail(state), focused }),
    project: () => structuredClone(capture()),
    loadProject: contents => { const validated = parseProject(contents); readProject(validated); return structuredClone(capture()); },
    step: seconds => manualStep(seconds),
    camera: () => structuredClone(scene.getCameraState()),
    components: () => structuredClone(scene.getComponents()),
    sceneDebug: () => structuredClone(scene.getDebug()),
    guide: () => structuredClone(guide),
  };
  window.advanceTime = milliseconds => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 60000) throw new RangeError('관찰 진행은 0–60000 ms 범위여야 합니다.');
    externalClock = true;
    const duration = running ? milliseconds / 1000 * playbackRate : 0;
    if (duration > 0) advance(duration);
    refresh(true, duration);
  };
  window.render_game_to_text = () => JSON.stringify({ coordinateSystem: 'SI m/s/Pa/m³/N/W/J; +X cylinder extension; gauge pressure relative to tank; quasi-static model', ...window.hydraulicLab.getState() });
  saveLocal();
  function frame(now) {
    const elapsed = Math.max(0, (now - lastFrame) / 1000); lastFrame = now;
    let advanced = 0;
    if (running && !externalClock && !document.hidden) {
      try { advanced = elapsed * playbackRate; advance(advanced); }
      catch (error) { advanced = 0; stop(); toast(error.message); }
      if (now - lastAutosave > 1500) { lastAutosave = now; saveLocal(); }
      refresh(false, advanced);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
} catch (error) {
  restoring = false; console.error(error);
  $('#scene-error').hidden = false;
  text('#scene-error', `관찰 화면을 준비하지 못했습니다. 창을 다시 열어 주세요. ${error.message}`);
}
