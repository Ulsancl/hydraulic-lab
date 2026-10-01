import { MODEL_VERSION, DIMENSIONS_SI, normalizeSettings, createExperiment, assertValidState } from './model.js';

export const projectType = 'hydraulic-lab-project';
export const projectVersion = 1;
export const projectModelVersion = MODEL_VERSION;
const MAX_BYTES = 10 * 1024 * 1024;
const CAMERA_DISTANCE_EPSILON = 1e-10;
const modes = ['assembled', 'cutaway', 'exploded'];
const layerKeys = ['housing', 'seals', 'paths'];
const stateKeys = ['modelVersion', 'settings', 'command', 'positionM', 'timeS', 'pressureAPa', 'pressureBPa', 'energyJ', 'cumulativeVolumeM3'];
const partIds = new Set([
  'tank', 'tank-oil', 'suction-strainer', 'pump', 'pump-drive', 'return-filter',
  'directional-body', 'directional-spool', 'centering-springs', 'port-P', 'port-A', 'port-B', 'port-T',
  'relief-body', 'relief-poppet', 'relief-spring', 'relief-adjuster',
  'cylinder-barrel', 'cap-end', 'rod-gland', 'piston', 'piston-seal', 'rod', 'rod-guide', 'rod-seal', 'wiper',
  'load-carriage', 'load-guide', 'line-suction', 'line-P', 'line-A', 'line-B', 'line-T', 'line-relief',
]);
export const DEFAULT_VIEW = Object.freeze({
  mode: 'cutaway', explode: .35, labels: true, selectedPart: 'piston',
  layers: Object.freeze({ housing: true, seals: true, paths: true }),
  pressureColors: true, flowArrows: true,
});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export class ProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(`${message} 원본 파일은 변경하지 않습니다.`);
    this.name = 'ProjectError'; this.code = code; this.preserveOriginal = true;
    this.futureVersion = code === 'FUTURE_SCHEMA' || code === 'FUTURE_MODEL';
  }
}
const fail = (message, code) => { throw new ProjectError(message, code); };
function shape(value, required, label, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail(`${label}에 누락되거나 지원하지 않는 항목이 있습니다.`);
  }
}
function numeric(value, label, low, high) {
  if (!finite(value) || Object.is(value, -0) || value < low || value > high) fail(`${label} 수치가 올바르지 않습니다.`);
}
function modelVersion(value) {
  if (value === projectModelVersion) return;
  const candidate = typeof value === 'string' ? /^hydraulic-quasistatic-(\d+)$/.exec(value) : null;
  fail('이 유압 모형 버전의 원래 기록을 보호합니다.', candidate && Number(candidate[1]) > 1 ? 'FUTURE_MODEL' : 'UNSUPPORTED_MODEL');
}

export function normalizePlaybackRate(value) {
  return finite(value) ? clamp(value, .1, 4) : 1;
}
export function normalizeView(input) {
  const value = record(input) ? input : {}, layers = record(value.layers) ? value.layers : {};
  return {
    mode: modes.includes(value.mode) ? value.mode : DEFAULT_VIEW.mode,
    explode: finite(value.explode) ? clamp(value.explode, 0, 1) : DEFAULT_VIEW.explode,
    labels: typeof value.labels === 'boolean' ? value.labels : DEFAULT_VIEW.labels,
    selectedPart: partIds.has(value.selectedPart) ? value.selectedPart : DEFAULT_VIEW.selectedPart,
    layers: Object.fromEntries(layerKeys.map(key => [key, typeof layers[key] === 'boolean' ? layers[key] : DEFAULT_VIEW.layers[key]])),
    pressureColors: typeof value.pressureColors === 'boolean' ? value.pressureColors : DEFAULT_VIEW.pressureColors,
    flowArrows: typeof value.flowArrows === 'boolean' ? value.flowArrows : DEFAULT_VIEW.flowArrows,
  };
}
function savedView(value) {
  shape(value, ['mode', 'explode', 'labels', 'selectedPart', 'layers', 'pressureColors', 'flowArrows'], '관찰 화면');
  if (!modes.includes(value.mode) || !partIds.has(value.selectedPart)) fail('지원하지 않는 관찰 방식 또는 부품입니다.');
  numeric(value.explode, '분해 간격', 0, 1);
  for (const key of ['labels', 'pressureColors', 'flowArrows']) if (typeof value[key] !== 'boolean') fail('관찰 표시 상태가 올바르지 않습니다.');
  shape(value.layers, layerKeys, '구조 레이어');
  if (layerKeys.some(key => typeof value.layers[key] !== 'boolean')) fail('구조 레이어 상태가 올바르지 않습니다.');
  return normalizeView(value);
}
function savedCamera(value) {
  if (value === null) return null;
  shape(value, ['position', 'target'], '카메라', ['zoom']);
  for (const key of ['position', 'target']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3) fail('카메라 좌표는 세 개의 수치여야 합니다.');
    for (const coordinate of value[key]) numeric(coordinate, '카메라 좌표', -100, 100);
  }
  const distance = Math.hypot(...value.position.map((coordinate, index) => coordinate - value.target[index]));
  numeric(distance, '카메라 거리', .2 - CAMERA_DISTANCE_EPSILON, 4 + CAMERA_DISTANCE_EPSILON);
  if (Object.hasOwn(value, 'zoom')) numeric(value.zoom, '카메라 확대', .25, 4);
  return { position: [...value.position], target: [...value.target], ...(Object.hasOwn(value, 'zoom') ? { zoom: value.zoom } : {}) };
}
function savedState(value) {
  shape(value, stateKeys, '유압 실험 상태'); modelVersion(value.modelVersion);
  shape(value.settings, ['pumpFlowM3s', 'reliefPressurePa', 'resistingForceN'], '유압 설정');
  shape(value.energyJ, ['pump', 'load', 'relief'], '누적 에너지');
  shape(value.cumulativeVolumeM3, ['pump', 'relief'], '누적 유량');
  // One model-owned validator checks SI bounds and physical consistency. It
  // never advances time or repairs a loaded state; accepted numbers stay exact.
  try { assertValidState(value); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    fail(`유압 상태가 모형의 수치 범위 또는 압력·에너지·유량 관계와 맞지 않습니다. ${error.message}`, 'INVALID_STATE');
  }
  return {
    modelVersion: value.modelVersion,
    settings: { pumpFlowM3s: value.settings.pumpFlowM3s, reliefPressurePa: value.settings.reliefPressurePa, resistingForceN: value.settings.resistingForceN },
    command: value.command, positionM: value.positionM, timeS: value.timeS,
    pressureAPa: value.pressureAPa, pressureBPa: value.pressureBPa,
    energyJ: { pump: value.energyJ.pump, load: value.energyJ.load, relief: value.energyJ.relief },
    cumulativeVolumeM3: { pump: value.cumulativeVolumeM3.pump, relief: value.cumulativeVolumeM3.relief },
  };
}
function validateProject(value) {
  if (!record(value) || value.type !== projectType) fail('지원하지 않는 유압 실험 파일입니다.', 'UNSUPPORTED_FORMAT');
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > projectVersion) fail('새로운 저장 형식을 보호합니다.', 'FUTURE_SCHEMA');
  if (value.schemaVersion !== projectVersion) fail('지원하지 않는 저장 형식 버전입니다.', 'UNSUPPORTED_SCHEMA');
  modelVersion(value.modelVersion);
  shape(value, ['type', 'schemaVersion', 'modelVersion', 'state', 'observation'], '유압 실험 파일');
  const state = savedState(value.state);
  shape(value.observation, ['playbackRate', 'view', 'camera'], '관찰 기록');
  numeric(value.observation.playbackRate, '관찰 재생 배율', .1, 4);
  return { type: projectType, schemaVersion: projectVersion, modelVersion: projectModelVersion, state,
    observation: { playbackRate: value.observation.playbackRate, view: savedView(value.observation.view), camera: savedCamera(value.observation.camera) } };
}

export function createProject(input = {}) {
  const value = record(input) ? input : {};
  let state;
  try { state = savedState(value.state); }
  catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    const original = record(value.state) ? value.state : {};
    const positionM = finite(original.positionM) ? clamp(original.positionM, 0, DIMENSIONS_SI.strokeM) : DIMENSIONS_SI.strokeM / 2;
    // Live malformed state starts a coherent new experiment. Independently
    // clamping pressure or accumulated energy would invent a physical history.
    state = createExperiment(normalizeSettings(record(original.settings) ? original.settings : {}), { positionM });
  }
  let camera = null;
  if (value.camera !== undefined && value.camera !== null) {
    try { camera = savedCamera(value.camera); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  }
  return { type: projectType, schemaVersion: projectVersion, modelVersion: projectModelVersion, state,
    observation: { playbackRate: normalizePlaybackRate(value.playbackRate), view: normalizeView(value.view), camera } };
}
export function parseProject(text) {
  if (typeof text !== 'string') fail('실험 파일은 JSON 텍스트여야 합니다.', 'INVALID_JSON');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('실험 파일은 10 MiB 이하여야 합니다.', 'PROJECT_TOO_LARGE');
  let value;
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON'); }
  return validateProject(value);
}
export function serializeProject(project) {
  return JSON.stringify(validateProject(project), null, 2);
}
