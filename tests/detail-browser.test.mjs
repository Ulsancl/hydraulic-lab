import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createExperiment, setCommand } from '../src/model.js';
import { createProject } from '../src/project.js';

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'output', 'detail-browser');
const address = 'http://127.0.0.1:5250';
const checks = [], errors = [], evidence = [], externalRequests = [];
const capArea = Math.PI * .06 ** 2 / 4, rodArea = Math.PI * (.06 ** 2 - .035 ** 2) / 4;
let server, browser, context, page;
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const vectorNear = (actual, expected, tolerance = 1e-9) => actual.forEach((value, index) => near(value, expected[index], tolerance));
const cameraNear = (actual, expected) => { for (const key of ['position', 'target']) vectorNear(actual[key], expected[key], 1e-10); near(actual.zoom ?? 1, expected.zoom ?? 1, 1e-10); };
const state = () => page.evaluate(() => window.hydraulicLab.getState());
const project = () => page.evaluate(() => window.hydraulicLab.project());
const debug = () => page.evaluate(() => window.hydraulicLab.sceneDebug());
const camera = () => page.evaluate(() => window.hydraulicLab.camera());
const guide = () => page.evaluate(() => window.hydraulicLab.guide());
const load = value => page.evaluate(value => window.hydraulicLab.loadProject(JSON.stringify(value)), value);
const fresh = (settings = {}, positionM = .15, command = 'neutral') => createProject({ state: setCommand(createExperiment(settings, { positionM }), command) });
const advance = seconds => page.evaluate(value => window.hydraulicLab.step(value), seconds);
const command = id => page.locator(`[data-command="${id}"]`).click();
const select = id => page.locator('#part-select').selectOption(id);
const facts = (focus = false) => page.locator(focus ? '#focus-detail-facts .detail-fact' : '#part-detail-facts .detail-fact').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.label, { value: node.dataset.value, unit: node.dataset.unit, text: node.querySelector('dd').textContent.trim() }])));
const rendering = () => page.evaluate(() => {
  const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info');
  const scene = window.hydraulicLab?.sceneDebug();
  return { documentId: window.__detailDocumentId, readyState: document.readyState, contextLost: gl?.isContextLost() ?? true,
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
    drawCalls: scene?.drawCalls, triangles: scene?.triangles, canvas: canvas && { width: canvas.width, height: canvas.height } };
});
async function ready(previousDocumentId = null) {
  await page.waitForFunction(previous => {
    if (document.readyState !== 'complete' || !window.__detailDocumentId || window.__detailDocumentId === previous || !window.hydraulicLab) return false;
    const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), scene = window.hydraulicLab.sceneDebug();
    return !!gl && !gl.isContextLost() && canvas.width > 0 && canvas.height > 0 && scene.ready && scene.drawCalls > 0 && scene.triangles > 0;
  }, previousDocumentId, { polling: 100, timeout: 60000 });
}
function watch(target) {
  target.on('pageerror', error => errors.push({ kind: 'page', message: error.message }));
  target.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); });
  target.on('requestfailed', request => errors.push({ kind: 'request', message: request.url() + ': ' + request.failure()?.errorText }));
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) {
    checks.push({ name, passed: false, error: error.message });
    await page?.clock.resume().catch(() => {});
    evidence.push({ failureRendering: await rendering().catch(() => null) });
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {}); throw error;
  }
}
async function lesson(id) {
  if (!await page.locator('#lesson-picker').evaluate(element => element.open)) await page.locator('#lesson-picker > summary').click();
  await page.locator(`[data-lesson="${id}"]`).click();
}

try {
  await mkdir(output, { recursive: true });
  await rm(path.join(output, 'failure.png'), { force: true });
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5250, strictPort: true, hmr: false, watch: null } }); await server.listen();
  // Match the existing browser suite; record the actual supported backend below.
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.exposeBinding('__reportDetailContextLoss', (_source, message) => errors.push({ kind: 'webgl', message }));
  await context.addInitScript(() => {
    window.__detailDocumentId = crypto.randomUUID();
    document.addEventListener('webglcontextlost', event => window.__reportDetailContextLoss(event.statusMessage || 'WebGL context lost'), true);
  });
  page = await context.newPage(); page.setDefaultTimeout(30000); watch(page);
  const origin = new Date('2026-10-02T00:00:00Z');
  // Keep browser rendering callbacks available during document initialization.
  // The application itself starts paused; wall time must not advance its state.
  await page.clock.install({ time: origin });
  await page.goto(address, { waitUntil: 'commit', timeout: 60000 }); await ready();
  assert.equal((await state()).running, false); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60000));
  evidence.push({ initialRendering: await rendering() });

  await check('The refined apparatus renders WebGL and every published component has state-linked facts', async () => {
    const before = await state(), beforeCamera = await camera(), scene = await debug();
    assert.equal(before.running, false); assert.equal(before.state.modelVersion, 'hydraulic-quasistatic-1');
    assert.ok(scene.drawCalls > 0 && scene.triangles > 0); assert.equal(await page.locator('#scene canvas').count(), 1);
    const components = await page.evaluate(() => window.hydraulicLab.components()); assert.equal(components.length, 34);
    for (const component of components) {
      await select(component.id); const current = await state(), rows = await facts();
      assert.equal(current.view.selectedPart, component.id); assert.deepEqual(current.state, before.state); cameraNear(await camera(), beforeCamera);
      assert.ok(Object.keys(rows).length > 0 && Object.keys(rows).length <= 6, component.id);
      for (const [label, row] of Object.entries(rows)) { assert.ok(label && row.text, component.id); assert.doesNotMatch(row.text, /NaN|Infinity|undefined/); }
      assert.ok((await page.locator('#part-detail-note').textContent()).trim(), component.id);
    }
  });

  await check('Moving force and chamber flow use unequal piston areas rather than the relief setting', async () => {
    for (const direction of ['extend', 'retract']) {
      await load(fresh({}, .15, direction)); await select('piston');
      const current = await state(), d = current.detail, sign = direction === 'extend' ? 1 : -1, area = direction === 'extend' ? capArea : rodArea;
      near(current.snapshot.portsPa.P, 4000 / area); assert.ok(current.snapshot.portsPa.P < 5e6);
      near(d.force.capN, direction === 'extend' ? 4000 : 0); near(d.force.rodN, direction === 'retract' ? -4000 : 0); near(d.force.netHydraulicN, sign * 4000);
      near(d.force.extendLimitN, 5e6 * capArea); near(d.force.retractLimitN, 5e6 * rodArea); near(d.force.commandLimitN, 5e6 * area);
      near(d.chambers.cap.volumeRateM3s, capArea * sign * .0001 / area); near(d.chambers.rod.volumeRateM3s, -rodArea * sign * .0001 / area);
      near(d.power.cylinderW, 4000 * .0001 / area); near(d.power.pumpW, d.power.cylinderW); near(d.power.loadW, d.power.pumpW); near(d.power.reliefW, 0); near(d.power.residualW, 0);
      const actualVolumes = await debug(); near(actualVolumes.capFluidVolumeM3, d.chambers.cap.volumeM3); near(actualVolumes.rodFluidVolumeM3, d.chambers.rod.volumeM3);
      const totalBefore = current.snapshot.volumesM3.cap + current.snapshot.volumesM3.rod + current.snapshot.volumesM3.tank;
      await advance(.2); const moved = await state();
      near(moved.snapshot.volumesM3.cap + moved.snapshot.volumesM3.rod + moved.snapshot.volumesM3.tank, totalBefore);
      near(moved.snapshot.volumesM3.tank - current.snapshot.volumesM3.tank, -(capArea - rodArea) * (moved.state.positionM - current.state.positionM));
      evidence.push({ direction, detail: d });
    }
  });

  await check('Neutral retains chamber force while chamber work stops and the pump circulates at zero model power', async () => {
    for (const priorDirection of ['extend', 'retract']) {
      await load(fresh({}, .15, priorDirection)); await advance(.1); const moving = await state(); await command('neutral'); await advance(2);
      const held = await state(), d = held.detail;
      assert.equal(held.state.positionM, moving.state.positionM); near(held.snapshot.portsPa.A, moving.snapshot.portsPa.A); near(held.snapshot.portsPa.B, moving.snapshot.portsPa.B);
      near(d.force.netHydraulicN, moving.detail.force.netHydraulicN); assert.equal(d.force.commandLimitN, null);
      near(d.chambers.cap.volumeRateM3s, 0); near(d.chambers.rod.volumeRateM3s, 0); near(d.chambers.cap.signedPowerIntoW, 0); near(d.chambers.rod.signedPowerIntoW, 0);
      for (const key of ['pumpW', 'loadW', 'reliefW', 'cylinderW', 'residualW']) near(d.power[key], 0); assert.equal(d.power.loadShare, null);
      near(held.snapshot.flowsM3s.pumpFromTank, .0001); near(held.snapshot.flowsM3s.valveToTank, .0001); assert.deepEqual(held.state.energyJ, moving.state.energyJ);
      await select('directional-spool'); assert.match(await page.locator('#part-detail-note').textContent(), /고립|차단|중립/);
    }
  });

  await check('Pressure-limited return stroke separates actual force from load and sends all power to relief', async () => {
    await load(fresh({ reliefPressurePa: 2e6, resistingForceN: 4000 }, .15, 'retract')); await select('relief-poppet');
    const before = await state(), d = before.detail;
    assert.equal(before.snapshot.status, 'pressure-limit'); near(d.force.netHydraulicN, -2e6 * rodArea); near(d.force.resistingLoadMagnitudeN, 4000);
    assert.ok(Math.abs(d.force.netHydraulicN) < d.force.resistingLoadMagnitudeN); near(d.power.pumpW, 200); near(d.power.reliefW, 200); near(d.power.loadW, 0); near(d.power.cylinderW, 0);
    near(d.power.loadShare, 0); await advance(1.25); const after = await state();
    near(after.state.positionM, .15); near(after.state.energyJ.pump, 250); near(after.state.energyJ.relief, 250); near(after.state.energyJ.load, 0);
    await command('extend'); const forward = await state(); assert.equal(forward.snapshot.status, 'moving'); near(forward.detail.force.netHydraulicN, 4000); near(forward.detail.power.reliefW, 0);
  });

  await check('Exact end arrival and the following relief interval keep instantaneous power separate from accumulated energy', async () => {
    await load(fresh({}, .28, 'extend')); await select('piston');
    const travel = .3 - .28, hitTime = travel * capArea / .0001; await advance(hitTime);
    const atStop = await state(); assert.equal(atStop.snapshot.status, 'end-stop'); near(atStop.state.positionM, .3);
    near(atStop.state.energyJ.load, 4000 * travel, 1e-7); near(atStop.state.energyJ.relief, 0, 1e-7); near(atStop.detail.power.reliefW, 500); near(atStop.detail.power.loadW, 0);
    await advance(.75); const later = await state(); near(later.state.energyJ.relief, 375, 1e-7); near(later.state.energyJ.pump, 4000 * travel + 375, 1e-7);
    await load(fresh({}, .28, 'extend')); await advance(hitTime + .75); const crossed = await state();
    near(crossed.state.energyJ.pump, later.state.energyJ.pump, 1e-7); near(crossed.state.energyJ.load, later.state.energyJ.load, 1e-7); near(crossed.state.energyJ.relief, later.state.energyJ.relief, 1e-7);
    near(crossed.detail.energy.pumpJ, crossed.state.energyJ.pump); near(crossed.detail.energy.loadJ, crossed.state.energyJ.load); near(crossed.detail.energy.reliefJ, crossed.state.energyJ.relief);
    evidence.push({ exactEndArrival: atStop.detail, afterRelief: later.detail });
  });

  await check('Unapplied condition drafts and playback scale leave physical facts unchanged; apply and undo remain explicit', async () => {
    await load(fresh({}, .15, 'extend')); await select('piston');
    const original = await project(), before = await state(), beforeFacts = await facts(), reference = await page.locator('#detail-reference').textContent();
    await page.locator('#pump-flow').fill('9.25'); await page.locator('#relief-pressure').fill('65.5'); await page.locator('#resisting-force').fill('6.125');
    for (const rate of ['0.1', '4', '1']) {
      await page.locator('#playback-rate').selectOption(rate); await page.clock.runFor(80);
      const current = await state(); assert.deepEqual(current.state, before.state); assert.deepEqual(current.detail, before.detail); assert.deepEqual(await facts(), beforeFacts);
      assert.equal(await page.locator('#detail-reference').textContent(), reference);
    }
    await page.locator('#apply-settings').click(); const applied = await state();
    near(applied.state.settings.pumpFlowM3s, 9.25 / 60000); near(applied.state.settings.reliefPressurePa, 65.5e5); near(applied.state.settings.resistingForceN, 6125);
    assert.equal(applied.state.command, 'neutral'); assert.equal(applied.state.timeS, 0); near(applied.state.positionM, before.state.positionM);
    near(applied.detail.force.extendLimitN, 65.5e5 * capArea); near(applied.detail.force.retractLimitN, 65.5e5 * rodArea);
    await command('extend'); const moving = await state(); near(moving.detail.force.netHydraulicN, 6125); near(moving.snapshot.velocityMps, 9.25 / 60000 / capArea);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), original); assert.deepEqual((await state()).detail, before.detail); assert.deepEqual(await facts(), beforeFacts);
  });

  await check('Ordinary detail selection preserves manual orbit while explicit part focus is a saved camera choice', async () => {
    await load(fresh({}, .17, 'extend')); const initial = await project();
    const box = await page.locator('#scene canvas').boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width * .43, box.y + box.height * .45); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .58, box.y + box.height * .53, { steps: 8 }); await page.mouse.up(); await page.clock.runFor(100);
    const manual = await camera(); assert.notDeepEqual(manual, initial.observation.camera);
    for (const id of ['pump', 'relief-poppet', 'directional-spool', 'rod']) {
      await select(id); cameraNear(await camera(), manual); assert.deepEqual((await project()).state, initial.state);
    }
    for (const layer of ['housing', 'seals', 'paths']) { await page.locator(`[data-layer="${layer}"]`).uncheck(); await page.locator(`[data-layer="${layer}"]`).check(); cameraNear(await camera(), manual); }
    await select('pump'); await page.locator('#focus-part').click(); const focusedCamera = await camera(); assert.notDeepEqual(focusedCamera, manual);
    const pumpVisibility = (await debug()).mechanical.pump.visibility;
    assert.equal(pumpVisibility.total, 8); assert.ok(pumpVisibility.perGear.every(count => count >= 2), JSON.stringify(pumpVisibility));
    cameraNear((await project()).observation.camera, focusedCamera); const saved = await project();
    await page.clock.runFor(300);
    const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click();
    const file = path.join(output, 'focused-observation.hydraulic.json'); await (await downloadEvent).saveAs(file);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
    await page.locator('#reset-camera').click(); assert.notDeepEqual(await camera(), focusedCamera);
    await page.locator('#file-input').setInputFiles(file); await page.clock.runFor(100);
    assert.deepEqual(await project(), saved); cameraNear(await camera(), focusedCamera); assert.equal((await state()).view.selectedPart, 'pump');
    await page.clock.runFor(300); assert.equal((await state()).running, false);
    const previousDocumentId = await page.evaluate(() => window.__detailDocumentId);
    // Let browser callbacks run across navigation, then verify a new, fully
    // initialized document instead of relying only on the CDP load event.
    await page.clock.resume(); await page.reload({ waitUntil: 'commit', timeout: 60000 }); await ready(previousDocumentId);
    assert.equal((await state()).running, false); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60000));
    assert.deepEqual(await project(), saved); cameraNear(await camera(), focusedCamera);
    evidence.push({ persistentFocusCamera: focusedCamera, reloadRendering: await rendering(), previousDocumentId });
  });

  await check('New detail controls preserve guided evidence and undo restores its exact preceding experiment', async () => {
    await lesson('pressure-limit'); await advance(.1); await command('extend'); await advance(.1);
    const beforeGuide = await guide(); assert.equal(beforeGuide.stepIndex, 2); assert.equal(beforeGuide.status, 'active');
    const beforeState = (await state()).state;
    for (const id of ['relief-poppet', 'pump', 'piston']) { await select(id); await page.locator('#focus-part').click(); assert.deepEqual(await guide(), beforeGuide); assert.deepEqual((await state()).state, beforeState); }
    const previous = await project(), previousDetail = (await state()).detail;
    await page.locator('#relief-pressure').fill('50'); assert.deepEqual(await guide(), beforeGuide); assert.deepEqual((await state()).detail, previousDetail);
    await page.locator('#apply-settings').click(); assert.equal((await guide()).pressureChangeApplied, true); near((await state()).detail.force.retractLimitN, 5e6 * rodArea);
    await page.locator('#undo-new').click(); assert.deepEqual(await guide(), beforeGuide); assert.deepEqual(await project(), previous); assert.deepEqual((await state()).detail, previousDetail);
  });

  await check('Selected part facts preserve SI conversion, chamber sign conventions and relief branch ownership', async () => {
    for (const direction of ['extend', 'retract']) {
      await load(fresh({}, .12, direction)); const current = await state(), d = current.detail;
      await select('piston'); let rows = await facts();
      near(Number(rows['캡측 유효 면적'].value), capArea * 1e4); assert.equal(rows['캡측 유효 면적'].unit, 'cm²');
      near(Number(rows['로드측 환형 면적'].value), rodArea * 1e4);
      near(Number(rows['현재 순유압력'].value), direction === 'extend' ? 4 : -4); near(Number(rows['현재 명령의 힘 한계'].value), 5e6 * (direction === 'extend' ? capArea : rodArea) / 1000);
      for (const [id, chamber, port] of [['port-A', 'cap', 'A'], ['port-B', 'rod', 'B']]) {
        await select(id); rows = await facts();
        near(Number(rows[`${port} 액실 압력`].value), d.chambers[chamber].pressurePa / 1e5); assert.equal(rows[`${port} 액실 압력`].unit, 'bar');
        near(Number(rows['액실 유량 · 유입 +'].value), d.chambers[chamber].volumeRateM3s * 60000); assert.equal(rows['액실 유량 · 유입 +'].unit, 'L/min');
        near(Number(rows['연결 액실 현재 체적'].value), d.chambers[chamber].volumeM3 * 1e6); assert.equal(rows['연결 액실 현재 체적'].unit, 'mL');
        near(Number(rows['액실로 들어가는 유압 동력'].value), d.chambers[chamber].signedPowerIntoW);
      }
      await select('load-carriage'); rows = await facts();
      const remaining = direction === 'extend' ? .3 - .12 : .12;
      near(Number(rows['이동 방향 끝까지 거리'].value), remaining * 1000); near(Number(rows['행정 끝 도달 예상'].value), remaining / Math.abs(current.snapshot.velocityMps));
    }
    await load(fresh({ reliefPressurePa: 2e6 }, .15, 'retract')); await advance(.5);
    await select('port-P'); let rows = await facts(); near(Number(rows['펌프에서 분기 전 유량'].value), 6); near(Number(rows['방향밸브 P로 들어가는 유량'].value), 0); near(Number(rows['릴리프로 나뉘는 유량'].value), 6);
    await select('port-T'); rows = await facts(); near(Number(rows['방향밸브 T 복귀 유량'].value), 0); near(Number(rows['합류 후 필터 유량'].value), 6);
    await select('return-filter'); rows = await facts(); near(Number(rows['필터·탱크 합류 유량'].value), 6);
    await select('relief-poppet'); rows = await facts(); near(Number(rows['릴리프 소산 동력'].value), 200); near(Number(rows['누적 릴리프 소산'].value), .1); assert.equal(rows['누적 릴리프 소산'].unit, 'kJ'); assert.equal(rows['이상 우회 상태'].value, '열림');
    await command('neutral'); await select('load-carriage'); rows = await facts(); assert.equal(rows['행정 끝 도달 예상'].value, '이동 중 아님'); assert.equal(rows['현재 명령의 힘 한계'].value, '중립 · 명령 없음');
  });

  await check('Signed force and power visuals remain finite for moving, held, stalled and zero-load states', async () => {
    const scenarios = [fresh({}, .15, 'extend'), fresh({}, .15, 'retract'), fresh({ reliefPressurePa: 2e6 }, .15, 'retract'), fresh({ resistingForceN: 0 }, .15, 'extend'), fresh({}, .15, 'neutral')];
    for (const example of scenarios) {
      await load(example); const current = await state(), d = current.detail;
      for (const [id, expected] of [['A', d.force.capN], ['B', d.force.rodN], ['net', d.force.netHydraulicN]]) {
        const bar = page.locator(`#force-${id}`); near(Number(await bar.getAttribute('data-value')), expected);
        const limit = Number(await bar.getAttribute('data-limit')); near(limit, Math.max(d.force.extendLimitN, d.force.retractLimitN));
        // CSSOM serializes percentages to fewer digits than the exact data value.
        const width = await bar.evaluate(node => Number.parseFloat(node.style.width)); near(width, Math.abs(expected) / limit * 50, 1e-4);
        assert.ok(width >= 0 && width <= 50 + 1e-8); assert.doesNotMatch(await page.locator(`#force-value-${id}`).textContent(), /NaN|Infinity|undefined/);
      }
      for (const id of ['pump', 'load', 'relief']) near(Number(await page.locator(`#power-value-${id}`).getAttribute('data-value')), d.power[`${id}W`]);
      for (const id of ['load', 'relief']) {
        const share = Number(await page.locator(`#power-share-${id}`).getAttribute('data-share'));
        near(share, d.power.pumpW > 0 ? d.power[`${id}W`] / d.power.pumpW : 0); assert.ok(share >= 0 && share <= 1 + 1e-10);
        assert.doesNotMatch(await page.locator(`#power-share-${id}`).getAttribute('style'), /NaN|Infinity/);
      }
      near(Number(await page.locator('#fluid-inventory').getAttribute('data-value')), current.snapshot.volumesM3.cap + current.snapshot.volumesM3.rod + current.snapshot.volumesM3.tank);
      near(Number(await page.locator('#fluid-rate').getAttribute('data-value')), -(capArea - rodArea) * current.snapshot.velocityMps);
      assert.ok((await page.locator('#power-note').textContent()).trim());
      const beforeCamera = await camera(); await page.locator('.force-row[data-part="port-A"]').click(); assert.equal((await state()).view.selectedPart, 'port-A'); cameraNear(await camera(), beforeCamera); assert.deepEqual((await state()).state, current.state);
      await page.locator('.power-source').click(); assert.equal((await state()).view.selectedPart, 'pump'); cameraNear(await camera(), beforeCamera);
    }
  });

  await check('Actual pump meshes clear their twin bores at every phase and relief surfaces seat at zero lift', async () => {
    await load(fresh()); const phaseStep = 2 * Math.PI / 24, period = 2 * Math.PI / 1.8;
    for (let phase = 0; phase <= 24; phase++) {
      const current = await state(), mechanical = (await debug()).mechanical, pump = mechanical.pump;
      near(pump.gearAngles[0], current.state.timeS * 1.8); near(pump.gearAngles[1], -current.state.timeS * 1.8 + Math.PI / 12);
      near(pump.gearAngles[0] + pump.gearAngles[1], Math.PI / 12); near(pump.axisSeparationM, .03);
      assert.ok(pump.radialClearanceLowerBoundM > .0006, JSON.stringify(pump));
      for (const gaps of pump.axialClearancesM) { near(gaps.rear, .0003, 1e-8); near(gaps.front, .0003, 1e-8); }
      const before = pump.gearAngles; await page.clock.runFor(20); assert.deepEqual((await debug()).mechanical.pump.gearAngles, before);
      if (phase < 24) await advance(phaseStep / 1.8);
    }
    const stepped = (await debug()).mechanical.pump; await load(fresh()); await advance(period); const direct = (await debug()).mechanical.pump;
    vectorNear(direct.gearAngles, stepped.gearAngles); evidence.push({ pumpMechanical: direct });
    for (const example of [fresh(), fresh({}, .15, 'extend'), fresh({ reliefPressurePa: 2e6 }, .15, 'retract'), fresh({}, .3, 'extend')]) {
      await load(example); const current = await state(), relief = (await debug()).mechanical.relief, open = current.snapshot.flowsM3s.reliefToTank > 0;
      assert.equal(relief.open, open); near(relief.liftM, open ? .0035 : 0); near(relief.closedContactGapM, 0, 1e-8); near(relief.currentContactGapM, open ? .0035 : 0, 1e-8);
      assert.ok(relief.contactRadiusM >= .004 && relief.contactRadiusM <= .0065); near(relief.poppetContact[1] - relief.seatContact[1], relief.currentContactGapM, 1e-8);
      await select('relief-poppet'); assert.equal((await facts())['이상 우회 상태'].value, open ? '열림' : '닫힘');
      evidence.push({ reliefMechanical: relief, status: current.snapshot.status });
    }
    await load(fresh({}, .15, 'extend')); const closed = (await debug()).mechanical.relief;
    await load(fresh({ reliefPressurePa: 2e6 }, .15, 'retract')); const opened = (await debug()).mechanical.relief;
    vectorNear(opened.springUpper, closed.springUpper, 1e-8); near(opened.springLower[1] - closed.springLower[1], .0035, 1e-8);
  });

  await check('Narrow focused observation keeps live facts, explicit camera controls and native disclosure behavior usable', async () => {
    await load(fresh({}, .16, 'retract')); await page.setViewportSize({ width: 390, height: 844 }); await page.clock.runFor(100);
    await page.locator('#focus-view').click(); await page.clock.runFor(100); assert.equal((await state()).focused, true);
    const disclosure = page.locator('.focus-detail-panel details'); assert.equal(await disclosure.evaluate(node => node.open), false);
    const beforeCamera = await camera(), beforeState = (await state()).state;
    await page.locator('#focus-part-select').selectOption('port-B'); assert.equal((await state()).view.selectedPart, 'port-B'); cameraNear(await camera(), beforeCamera);
    await disclosure.locator('summary').focus(); await page.keyboard.press('Space'); assert.equal(await disclosure.evaluate(node => node.open), true); assert.equal((await state()).running, false);
    assert.deepEqual(await facts(true), await facts()); assert.equal(await page.locator('#focus-detail-note').textContent(), await page.locator('#part-detail-note').textContent());
    assert.equal(await page.locator('#focus-detail-reference').textContent(), await page.locator('#detail-reference').textContent());
    await page.locator('#focus-part-inline').click(); const focusedCamera = await camera(); assert.notDeepEqual(focusedCamera, beforeCamera); cameraNear((await project()).observation.camera, focusedCamera);
    assert.deepEqual((await state()).state, beforeState); await advance(.1); assert.deepEqual(await facts(true), await facts());
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, sceneHeight: document.querySelector('#scene').getBoundingClientRect().height }));
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout)); assert.ok(layout.sceneHeight >= 280, JSON.stringify(layout));
    await page.locator('#reset-camera').click(); assert.notDeepEqual(await camera(), focusedCamera);
    await page.locator('#focus-view').click(); await page.setViewportSize({ width: 1600, height: 1100 }); await page.clock.runFor(100);
    evidence.push({ narrowLayout: layout });
  });

  await check('Real-clock closeups expose the actual pump cavity, relief contact and compact detail layout', async () => {
    const visualContext = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
    try {
      const visual = await visualContext.newPage(); watch(visual);
      await visual.goto(address, { waitUntil: 'networkidle' }); await visual.waitForFunction(() => window.hydraulicLab?.sceneDebug().drawCalls > 0);
      await visual.evaluate(value => window.hydraulicLab.loadProject(JSON.stringify(value)), fresh({}, .15, 'extend'));
      await visual.waitForTimeout(200); await visual.screenshot({ path: path.join(output, 'hydraulic-detail-overview.png'), fullPage: true });
      for (const [id, filename] of [['pump', 'pump-closeup'], ['relief-poppet', 'relief-closed'], ['piston', 'piston-closeup']]) {
        await visual.locator('#part-select').selectOption(id); await visual.locator('#focus-part').click(); await visual.waitForTimeout(200);
        if (id === 'pump') {
          const visibility = await visual.evaluate(() => window.hydraulicLab.sceneDebug().mechanical.pump.visibility);
          assert.ok(visibility.perGear.every(count => count >= 2), JSON.stringify(visibility)); evidence.push({ focusedPumpVisibility: visibility });
        }
        await visual.locator('#workspace').screenshot({ path: path.join(output, `${filename}.png`) });
      }
      await visual.evaluate(value => window.hydraulicLab.loadProject(JSON.stringify(value)), fresh({ reliefPressurePa: 2e6 }, .15, 'retract'));
      await visual.locator('#part-select').selectOption('relief-poppet'); await visual.locator('#focus-part').click(); await visual.waitForTimeout(200);
      await visual.locator('#workspace').screenshot({ path: path.join(output, 'relief-open.png') });
      await visual.setViewportSize({ width: 390, height: 844 }); await visual.locator('#focus-view').click();
      await visual.locator('#focus-part-select').selectOption('piston'); await visual.locator('#focus-part-inline').click(); await visual.locator('.focus-detail-panel summary').click(); await visual.waitForTimeout(200);
      await visual.screenshot({ path: path.join(output, 'narrow-piston-detail.png'), fullPage: true });
    } finally { await visualContext.close(); }
  });

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'detail-browser-results.json'), JSON.stringify({ version, renderer: 'Headless Chromium default backend; actual renderer recorded in evidence. Functional geometry evidence, not physical GPU performance.', checks, evidence, errors, externalRequests }, null, 2));
  await context?.close(); await browser?.close(); await server?.close();
}
