import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, setCommand, reconfigureExperiment, step, instantSnapshot, MAX_SIMULATION_TIME_S, DIMENSIONS_SI } from '../src/model.js';
import { COMPONENTS } from '../src/geometry.js';
import { createProject, parseProject, serializeProject, DEFAULT_VIEW, normalizeView, normalizePlaybackRate, ProjectError } from '../src/project.js';

const copy = value => structuredClone(value);
function example() {
  const moving = step(setCommand(createExperiment({ pumpFlowM3s: .00015, reliefPressurePa: 7e6, resistingForceN: 3600 }, { positionM: .05 }), 'extend'), .73).state;
  return createProject({ state: moving, playbackRate: .25,
    view: { mode: 'exploded', explode: .67, labels: false, selectedPart: 'relief-poppet',
      layers: { housing: false, seals: true, paths: true }, pressureColors: false, flowArrows: true },
    camera: { position: [1, .8, 1.3], target: [.1, .1, -.2], zoom: 1.75 } });
}
function invalid(change, code = 'INVALID_PROJECT') {
  const current = example(), before = copy(current), imported = copy(current);
  change(imported);
  const text = JSON.stringify(imported);
  assert.throws(() => parseProject(text), error => error instanceof ProjectError && error.code === code && error.preserveOriginal);
  assert.deepEqual(current, before, 'Rejected input must not change the caller experiment');
  assert.equal(JSON.stringify(imported), text, 'Validation must not repair imported values');
}
function roundTrip(state) {
  const project = createProject({ state }), original = copy(state);
  assert.deepEqual(project.state, original, 'Valid model state must not be normalized');
  const serialized = serializeProject(project), restored = parseProject(serialized);
  assert.deepEqual(restored, project); assert.equal(serializeProject(restored), serialized);
  assert.deepEqual(state, original);
  return restored.state;
}

test('all SI state fields, observation options and manual camera survive exact deterministic round trips', () => {
  const project = example(), before = copy(project), raw = serializeProject(project);
  const restored = parseProject(raw);
  assert.deepEqual(restored, project); assert.equal(serializeProject(restored), raw);
  assert.equal(restored.state.timeS, .73); assert.equal(restored.observation.playbackRate, .25);
  assert.equal(restored.state.command, 'extend'); assert.ok(restored.state.energyJ.load > 0);
  assert.ok(restored.state.cumulativeVolumeM3.pump > 0);
  restored.state.settings.pumpFlowM3s = .0001;
  restored.state.energyJ.load = -1; restored.state.cumulativeVolumeM3.pump = -1;
  restored.observation.view.layers.housing = true; restored.observation.camera.position[0] = 9;
  assert.deepEqual(project, before, 'Returned nested records must not alias their source');
});

test('midstroke extension, retraction and isolated neutral pressure remain exact and resume identically', () => {
  let state = createExperiment({}, { positionM: .09 });
  for (const [command, dt] of [['extend', .71], ['neutral', .4], ['retract', .39], ['neutral', 1.1], ['extend', .18]]) {
    state = step(setCommand(state, command), dt).state;
    const restored = roundTrip(state);
    assert.deepEqual(instantSnapshot(restored), instantSnapshot(state));
    assert.deepEqual(step(restored, .1234), step(state, .1234), 'Opening a file must not alter later motion or cumulative energy');
  }
});

test('pressure-limit and partial-frame end-stop records preserve relief energy and volume', () => {
  const blocked = step(setCommand(createExperiment({ reliefPressurePa: 2e6, resistingForceN: 10000 }), 'extend'), 2.3).state;
  assert.equal(instantSnapshot(blocked).status, 'pressure-limit');
  assert.ok(blocked.energyJ.relief > 0); roundTrip(blocked); roundTrip(setCommand(blocked, 'neutral'));
  for (const [positionM, command, expectedPosition] of [[.299, 'extend', .3], [.001, 'retract', 0]]) {
    const stopped = step(setCommand(createExperiment({}, { positionM }), command), .5).state;
    assert.equal(stopped.positionM, expectedPosition); assert.equal(instantSnapshot(stopped).status, 'end-stop');
    assert.ok(stopped.energyJ.load > 0 && stopped.energyJ.relief > 0);
    const restored = roundTrip(stopped);
    assert.deepEqual(step(restored, .5), step(stopped, .5)); roundTrip(setCommand(stopped, 'neutral'));
  }
});

test('new-condition resets and zero-load motion remain distinguishable from previous accumulated experiments', () => {
  const previous = example().state;
  const reset = reconfigureExperiment(previous, { resistingForceN: 0 });
  assert.equal(reset.positionM, previous.positionM); assert.equal(reset.timeS, 0);
  assert.deepEqual(reset.energyJ, { pump: 0, load: 0, relief: 0 }); roundTrip(reset);
  const unloaded = step(setCommand(reset, 'extend'), .2).state;
  assert.ok(unloaded.positionM > reset.positionM); assert.equal(unloaded.pressureAPa, 0);
  assert.ok(unloaded.cumulativeVolumeM3.pump > 0); roundTrip(unloaded);
});

test('known initial schema fixture is accepted without dropping a state field or inventing a timestamp', () => {
  const fixture = { type: 'hydraulic-lab-project', schemaVersion: 1, modelVersion: 'hydraulic-quasistatic-1',
    state: { modelVersion: 'hydraulic-quasistatic-1', settings: { pumpFlowM3s: .0001, reliefPressurePa: 5000000, resistingForceN: 4000 },
      command: 'neutral', positionM: .15, timeS: 0, pressureAPa: 0, pressureBPa: 0,
      energyJ: { pump: 0, load: 0, relief: 0 }, cumulativeVolumeM3: { pump: 0, relief: 0 } },
    observation: { playbackRate: 1, view: { mode: 'cutaway', explode: .35, labels: true, selectedPart: 'piston',
      layers: { housing: true, seals: true, paths: true }, pressureColors: true, flowArrows: true }, camera: null } };
  assert.deepEqual(parseProject(JSON.stringify(fixture)), fixture); assert.deepEqual(createProject(), fixture);
});

test('strict reading rejects physically inconsistent pressure, volume and energy without clamping', () => {
  for (const change of [
    p => { p.state.pressureAPa += 100; }, p => { p.state.pressureBPa = 100; },
    p => { p.state.cumulativeVolumeM3.pump += .01; }, p => { p.state.cumulativeVolumeM3.relief = p.state.cumulativeVolumeM3.pump + .001; },
    p => { p.state.energyJ.pump += 1; }, p => { p.state.energyJ.relief = 1; p.state.energyJ.pump += 1; },
    p => { p.state.energyJ.load = -1; }, p => { p.state.energyJ.pump = Number.MAX_VALUE; },
    p => { p.state.command = 'neutral'; p.state.pressureAPa = 100000; },
    p => { p.state.command = 'neutral'; p.state.pressureAPa = p.state.settings.reliefPressurePa; },
  ]) invalid(change, 'INVALID_STATE');
});

test('finite SI ranges and elapsed-time limit are validated before any state is accepted', () => {
  for (const change of [
    p => { p.state.settings.pumpFlowM3s = '0.0001'; }, p => { p.state.settings.pumpFlowM3s = 12; },
    p => { p.state.settings.reliefPressurePa = 50; }, p => { p.state.settings.resistingForceN = 10001; },
    p => { p.state.positionM = -.001; }, p => { p.state.positionM = DIMENSIONS_SI.strokeM + .001; },
    p => { p.state.timeS = -1; }, p => { p.state.timeS = MAX_SIMULATION_TIME_S + 1; },
    p => { p.state.timeS = Infinity; }, p => { p.state.pressureAPa = NaN; },
    p => { p.state.command = 'off'; }, p => { p.state.cumulativeVolumeM3.pump = null; },
  ]) invalid(change, 'INVALID_STATE');
  const project = example(); project.state.energyJ.load = NaN;
  assert.throws(() => serializeProject(project), error => error.code === 'INVALID_STATE');
  assert.throws(() => parseProject(serializeProject(example()).replace('7000000', '1e999')), ProjectError);
  const atLimit = createExperiment();
  atLimit.timeS = MAX_SIMULATION_TIME_S;
  atLimit.cumulativeVolumeM3.pump = atLimit.settings.pumpFlowM3s * MAX_SIMULATION_TIME_S;
  const restored = roundTrip(atLimit), before = copy(restored);
  assert.throws(() => step(restored, .1), RangeError);
  assert.deepEqual(restored, before, 'A resumed experiment at its time limit must not partially advance');
});

test('unknown and missing keys are rejected at every stored level', () => {
  for (const change of [
    p => { p.extra = true; }, p => { p.state.running = true; }, p => { delete p.state.pressureAPa; },
    p => { p.state.settings.flowLmin = 6; }, p => { delete p.state.energyJ.relief; },
    p => { p.state.energyJ.temperatureC = 50; }, p => { p.state.cumulativeVolumeM3.tank = 1; },
    p => { delete p.observation.camera; }, p => { p.observation.savedAt = 'invented'; },
    p => { p.observation.view.unknown = false; }, p => { p.observation.view.layers.oil = true; },
    p => { delete p.observation.view.layers.housing; },
  ]) invalid(change);
});

test('future format or model records carry original-protection signals, including nested model versions', () => {
  for (const change of [p => { p.schemaVersion = 2; }, p => { p.modelVersion = 'hydraulic-quasistatic-2'; }, p => { p.state.modelVersion = 'hydraulic-quasistatic-2'; }]) {
    const project = example(); change(project); const original = JSON.stringify(project);
    assert.throws(() => parseProject(original), error => error instanceof ProjectError && error.futureVersion && error.preserveOriginal);
    assert.equal(JSON.stringify(project), original);
  }
  invalid(p => { p.type = 'engine-lab-project'; }, 'UNSUPPORTED_FORMAT');
  invalid(p => { p.schemaVersion = '1'; }, 'UNSUPPORTED_SCHEMA');
  invalid(p => { p.modelVersion = 'another-model'; }, 'UNSUPPORTED_MODEL');
  invalid(p => { p.state.modelVersion = 'hydraulic-quasistatic-0'; }, 'UNSUPPORTED_MODEL');
});

test('Windows single BOM is accepted while exact source text and future-file protection are maintained', () => {
  const project = example(), raw = '\ufeff' + serializeProject(project), before = raw;
  assert.deepEqual(parseProject(raw), project); assert.equal(raw, before);
  const future = { ...project, schemaVersion: 2 };
  assert.throws(() => parseProject('\ufeff' + JSON.stringify(future)), error => error.code === 'FUTURE_SCHEMA');
  assert.throws(() => parseProject('\ufeff\ufeff' + serializeProject(project)), error => error.code === 'INVALID_JSON');
});

test('JSON and the UTF-8 byte boundary reject malformed or oversized input, including multibyte text', () => {
  for (const raw of [null, {}, 'null', '[]', '{broken']) assert.throws(() => parseProject(raw), ProjectError);
  const limit = 10 * 1024 * 1024, raw = serializeProject(createProject());
  const exact = raw + ' '.repeat(limit - Buffer.byteLength(raw));
  assert.deepEqual(parseProject(exact), createProject());
  assert.throws(() => parseProject(exact + ' '), error => error.code === 'PROJECT_TOO_LARGE');
  assert.throws(() => parseProject('\ufeff' + exact), error => error.code === 'PROJECT_TOO_LARGE');
  const multibyte = JSON.stringify({ note: '가'.repeat(3500000) });
  assert.ok(multibyte.length < limit);
  assert.throws(() => parseProject(multibyte), error => error.code === 'PROJECT_TOO_LARGE');
});

test('view and playback contracts are strict on files but safely normalized for new live observations', () => {
  for (const change of [
    p => { p.observation.playbackRate = .09; }, p => { p.observation.playbackRate = 4.01; },
    p => { p.observation.view.mode = 'transparent'; }, p => { p.observation.view.selectedPart = 'engine-piston'; },
    p => { p.observation.view.explode = 2; }, p => { p.observation.view.labels = 'true'; },
    p => { p.observation.view.pressureColors = 1; }, p => { p.observation.view.flowArrows = null; },
    p => { p.observation.view.layers.paths = 'false'; },
  ]) invalid(change);
  const view = normalizeView(); view.layers.housing = false; assert.equal(DEFAULT_VIEW.layers.housing, true);
  assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
  assert.equal(normalizePlaybackRate(.01), .1); assert.equal(normalizePlaybackRate(9), 4);
  for (const value of [undefined, null, NaN, Infinity, '.5']) assert.equal(normalizePlaybackRate(value), 1);
  assert.equal(COMPONENTS.length, 34);
  for (const { id } of COMPONENTS) {
    const project = example(); project.observation.view.selectedPart = id;
    assert.equal(parseProject(serializeProject(project)).observation.view.selectedPart, id);
  }
});

test('manual cameras retain optional zoom and epsilon boundary numbers exactly', () => {
  for (const distance of [.2, .2 - 1e-16, 4, 4 + 1e-15]) {
    for (const zoom of [.25, 1, 4]) {
      const project = example(); project.observation.camera = { position: [0, 0, distance], target: [0, 0, 0], zoom };
      assert.deepEqual(parseProject(serializeProject(project)), project);
    }
  }
  const withoutZoom = example(); delete withoutZoom.observation.camera.zoom;
  assert.deepEqual(parseProject(serializeProject(withoutZoom)), withoutZoom);
  for (const camera of [
    { position: [0, 0, 0], target: [0, 0, 0] }, { position: [0, 0, .2 - 1e-8], target: [0, 0, 0] },
    { position: [0, 0, 4 + 1e-8], target: [0, 0, 0] }, { position: [101, 0, 0], target: [99, 0, 0] },
    { position: [1, 0], target: [0, 0, 0] }, { position: ['1', 0, 0], target: [0, 0, 0] },
    { position: [1, 0, 0], target: [0, 0, 0], zoom: .24 }, { position: [1, 0, 0], target: [0, 0, 0], zoom: 4.01 },
    { position: [1, 0, 0], target: [0, 0, 0], extra: true },
  ]) invalid(p => { p.observation.camera = camera; });
});

test('invalid live state becomes a coherent new experiment, never a fabricated accumulated history', () => {
  const broken = example().state, before = copy(broken);
  broken.energyJ.relief = 12345;
  const reset = createProject({ state: broken, camera: { position: [0, 0, 0], target: [0, 0, 0] }, playbackRate: 99 });
  assert.deepEqual(reset.state.settings, before.settings); assert.equal(reset.state.positionM, before.positionM);
  assert.equal(reset.state.command, 'neutral'); assert.equal(reset.state.timeS, 0);
  assert.deepEqual(reset.state.energyJ, { pump: 0, load: 0, relief: 0 });
  assert.deepEqual(reset.state.cumulativeVolumeM3, { pump: 0, relief: 0 });
  assert.equal(reset.state.pressureAPa, 0); assert.equal(reset.state.pressureBPa, 0);
  assert.equal(reset.observation.camera, null); assert.equal(reset.observation.playbackRate, 4);
  assert.equal(broken.energyJ.relief, 12345);
  assert.equal(createProject({ state: { positionM: 100 } }).state.positionM, DIMENSIONS_SI.strokeM);
  assert.equal(createProject({ state: { positionM: -1 } }).state.positionM, 0);
  assert.deepEqual(parseProject(serializeProject(reset)), reset);
});
