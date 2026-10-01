import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createExperiment, step } from '../src/model.js';
import { createProject } from '../src/project.js';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/browser-integration');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5200, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true });
const page = await context.newPage(), errors = [], checks = [], externalRequests = [];
const watch = target => {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
};
watch(page);
const state = () => page.evaluate(() => window.hydraulicLab.getState());
const project = () => page.evaluate(() => window.hydraulicLab.project());
const near = (actual, expected, tolerance = 1e-9) => assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const fill = (selector, value) => page.locator(selector).fill(String(value));
const load = value => page.evaluate(text => window.hydraulicLab.loadProject(text), JSON.stringify(value));
const fresh = (settings = {}, positionM = .15) => createProject({ state: createExperiment(settings, { positionM }) });
const advance = seconds => page.evaluate(value => window.hydraulicLab.step(value), seconds);
const clickPart = id => page.locator(`[data-part="${id}"]`).first().click();
async function chooseLesson(id) {
  if (!await page.locator('#lesson-picker').evaluate(element => element.open)) await page.locator('#lesson-picker > summary').click();
  await page.locator(`[data-lesson="${id}"]`).click();
}
async function drawnCircuitMatches(current) {
  const debug = await page.evaluate(() => window.hydraulicLab.sceneDebug());
  near(debug.pistonCenterX, -.265 + current.state.positionM, 1e-9);
  near(debug.spoolOffsetM, { extend: .01, neutral: 0, retract: -.01 }[current.state.command]);
  for (const [field, chamber] of [['capFluidVolumeM3', 'cap'], ['rodFluidVolumeM3', 'rod'], ['tankVolumeM3', 'tank']]) near(debug[field], current.snapshot.volumesM3[chamber], 1e-9);
  for (const [id, key, pressure] of [['cap-line', 'capIntoCylinder', 'A'], ['rod-line', 'rodIntoCylinder', 'B'], ['relief-supply', 'reliefToTank', 'P']]) {
    const route = debug.routes.find(item => item.id === id); assert(route, id);
    near(route.flowM3s, current.snapshot.flowsM3s[key]); near(route.pressurePa, current.snapshot.portsPa[pressure]);
    assert.equal(route.visibleArrowCount > 0, Math.abs(current.snapshot.flowsM3s[key]) > 0, id);
  }
  const svgFlows = await page.locator('[id^="circuit-"][data-flow-m3s]').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.id, Number(node.dataset.flowM3s)])));
  near(svgFlows['circuit-pump-supply'], current.snapshot.flowsM3s.pumpFromTank);
  near(svgFlows['circuit-valve-supply'], current.snapshot.flowsM3s.supplyToValve);
  near(svgFlows['circuit-common-return'], current.snapshot.flowsM3s.valveToTank + current.snapshot.flowsM3s.reliefToTank);
}

try {
  const clockOrigin = new Date('2026-10-01T00:00:00Z');
  await page.clock.install({ time: clockOrigin });
  await page.clock.pauseAt(clockOrigin);
  await page.goto('http://127.0.0.1:5200/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.hydraulicLab);
  await page.clock.runFor(100);

  await check('real rendered apparatus starts paused with all component identities', async () => {
    const initial = await state();
    assert.equal(initial.running, false); assert.equal(initial.state.command, 'neutral');
    assert.equal(initial.view.mode, 'cutaway'); assert.equal(initial.state.positionM, .15);
    assert.equal(await page.locator('#scene canvas').count(), 1);
    assert.equal((await page.evaluate(() => window.hydraulicLab.components())).length, 34);
    const debug = await page.evaluate(() => window.hydraulicLab.sceneDebug());
    assert(debug.drawCalls > 0 && debug.triangles > 0, JSON.stringify(debug));
    assert.equal(await page.locator('#explode').isDisabled(), true);
    await drawnCircuitMatches(initial);
  });

  await check('direction controls and the actual step button drive the same SI state and readouts', async () => {
    await page.locator('[data-command="extend"]').click();
    const before = await state(); assert.equal(before.state.command, 'extend');
    assert.equal(before.running, false); near(before.snapshot.velocityMps, .0001 / (Math.PI * .06 ** 2 / 4));
    await page.locator('#step').click(); const after = await state();
    assert(after.state.timeS > before.state.timeS);
    const expected = step(before.state, after.state.timeS - before.state.timeS).state;
    assert.deepEqual(after.state, expected);
    await drawnCircuitMatches(after);
    assert.match(await page.locator('#readout-pressure-A').textContent(), /14[.,]1/);
    await page.locator('[data-command="retract"]').click();
    const reversed = await state(); assert(reversed.snapshot.velocityMps < 0);
    near(Math.abs(reversed.snapshot.velocityMps), .0001 / (Math.PI * (.06 ** 2 - .035 ** 2) / 4));
  });

  await check('neutral holds isolated pressure and displacement while the pump circulates', async () => {
    await chooseLesson('neutral-hold');
    await advance(1); const moving = await state();
    await page.locator('[data-command="neutral"]').click(); await advance(120);
    const held = await state();
    assert.equal(held.state.command, 'neutral'); assert.equal(held.snapshot.status, 'neutral');
    assert.equal(held.state.positionM, moving.state.positionM);
    assert.equal(held.snapshot.portsPa.A, moving.snapshot.portsPa.A);
    near(held.snapshot.portsPa.P, 0); near(held.snapshot.flowsM3s.valveToTank, .0001);
    near(held.snapshot.flowsM3s.capIntoCylinder, 0); near(held.snapshot.flowsM3s.rodIntoCylinder, 0);
    assert.deepEqual(held.state.energyJ, moving.state.energyJ);
    await drawnCircuitMatches(held);
  });

  await check('pressure-limit experiment distinguishes a blocked return stroke from available forward force', async () => {
    await chooseLesson('pressure-limit');
    const stalled = await state(); assert.equal(stalled.snapshot.status, 'pressure-limit');
    near(stalled.snapshot.portsPa.P, 2e6); near(stalled.snapshot.flowsM3s.reliefToTank, .0001);
    await advance(2); const accumulated = await state();
    assert.equal(accumulated.state.positionM, .15); near(accumulated.state.energyJ.relief, 400);
    await drawnCircuitMatches(accumulated);
    await page.locator('[data-command="extend"]').click(); await advance(1);
    const forward = await state(); assert.equal(forward.snapshot.status, 'moving'); assert(forward.state.positionM > .15);
  });

  await check('condition edits wait for explicit apply and undo restores the preceding complete experiment', async () => {
    const original = await project();
    await fill('#pump-flow', 9); await fill('#relief-pressure', 65); await fill('#resisting-force', 6);
    assert.deepEqual((await state()).state, original.state);
    await page.locator('#apply-settings').click(); const changed = await state();
    near(changed.state.positionM, original.state.positionM); assert.equal(changed.state.command, 'neutral');
    near(changed.state.settings.pumpFlowM3s, 9 / 60000); near(changed.state.settings.reliefPressurePa, 65e5);
    near(changed.state.settings.resistingForceN, 6000); assert.equal(changed.state.timeS, 0);
    assert.deepEqual(changed.state.energyJ, { pump: 0, load: 0, relief: 0 });
    assert.equal(changed.running, false);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), original);
  });

  await check('a long foreground frame preserves elapsed time and splits end arrival from relief circulation', async () => {
    await load(fresh({}, .28)); await page.locator('[data-command="extend"]').click();
    const original = (await state()).state;
    await page.locator('#play').click(); await page.clock.runFor(64); await page.clock.fastForward(1936);
    await page.locator('#play').click(); const result = await state();
    const elapsed = result.state.timeS - original.timeS;
    assert(elapsed > 1.9 && elapsed < 2.1, `foreground elapsed ${elapsed}`);
    const expected = step(original, elapsed).state;
    near(result.state.positionM, .3); assert.equal(result.snapshot.status, 'end-stop');
    near(result.state.energyJ.load, 4000 * (.3 - .28), 1e-7);
    near(result.state.energyJ.relief, expected.energyJ.relief, 1e-7);
    near(result.state.energyJ.pump, expected.energyJ.pump, 1e-7);
    assert.equal(result.running, false);
    await drawnCircuitMatches(result);
  });

  await check('component selection and structural layers preserve the experiment and manual camera', async () => {
    const original = await project();
    await clickPart('directional-spool');
    assert.equal((await state()).view.selectedPart, 'directional-spool');
    assert.deepEqual((await project()).state, original.state);
    assert.deepEqual((await project()).observation.camera, original.observation.camera);
    await page.locator('[data-mode="exploded"]').click(); await fill('#explode', .62);
    assert.equal((await state()).view.explode, .62); assert.equal(await page.locator('#explode').isDisabled(), false);
    for (const id of ['labels', 'pressure-colors', 'flow-arrows']) { await page.locator(`#${id}`).uncheck(); await page.locator(`#${id}`).check(); }
    for (const layer of ['housing', 'seals', 'paths']) { await page.locator(`[data-layer="${layer}"]`).uncheck(); await page.locator(`[data-layer="${layer}"]`).check(); }
    assert.deepEqual((await project()).state, original.state);
    await page.locator('#focus-part').click();
    assert.notDeepEqual((await project()).observation.camera, original.observation.camera);
    await page.locator('#reset-camera').click(); await page.locator('[data-mode="cutaway"]').click();
    await page.locator('svg [data-part="pump"]').first().focus(); await page.keyboard.press('Space');
    assert.equal((await state()).view.selectedPart, 'pump'); assert.equal((await state()).running, false);
  });

  await check('Space pauses the simulation while inputs retain their normal keyboard behavior', async () => {
    await page.locator('#scene').focus(); await page.keyboard.press('Space'); assert.equal((await state()).running, true);
    await page.clock.runFor(100); await page.keyboard.press('Space'); const stopped = await state();
    const stoppedFrame = await page.evaluate(() => window.hydraulicLab.sceneDebug().renderFrame);
    assert(Number.isFinite(stoppedFrame));
    await page.clock.runFor(200); assert.deepEqual((await state()).state, stopped.state);
    assert.equal(await page.evaluate(() => window.hydraulicLab.sceneDebug().renderFrame), stoppedFrame);
    await page.keyboard.press('Control+Space'); assert.equal((await state()).running, false);
    await page.locator('#pump-flow').focus(); await page.keyboard.press('Space'); assert.equal((await state()).running, false);
  });

  await check('file download, actual file input and reload preserve accumulated state, view and camera', async () => {
    await page.clock.runFor(300); const original = await project();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click();
    const download = await downloadEvent, filename = path.join(output, 'observation.hydraulic.json');
    await download.saveAs(filename); assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), original);
    await page.locator('#new-project').click();
    await page.locator('#file-input').setInputFiles(filename); await page.clock.runFor(100);
    assert.deepEqual(await project(), original); assert.equal((await state()).running, false);
    await page.clock.runFor(300); await page.reload(); await page.waitForFunction(() => !!window.hydraulicLab);
    await page.clock.runFor(64); assert.deepEqual(await project(), original); assert.equal((await state()).running, false);
    await page.locator('#new-project').click(); await page.locator('#undo-new').click();
    assert.deepEqual(await project(), original);
  });

  await check('invalid and future imports do not replace any current state', async () => {
    const original = await project();
    const failures = await page.evaluate(value => {
      const messages = [];
      for (const text of ['{broken JSON', JSON.stringify({ ...value, schemaVersion: 99 })]) {
        try { window.hydraulicLab.loadProject(text); } catch (error) { messages.push(error.message); }
      }
      return messages;
    }, original);
    assert.equal(failures.length, 2); assert.deepEqual(await project(), original);
  });

  await check('future automatic saves remain untouched while a separate observation is used', async () => {
    const raw = JSON.stringify({ ...(await project()), schemaVersion: 99 });
    const futureContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      await futureContext.addInitScript(text => localStorage.setItem('hydraulic-lab-project-v1', text), raw);
      const future = await futureContext.newPage(); watch(future);
      await future.goto('http://127.0.0.1:5200/', { waitUntil: 'networkidle' });
      await future.waitForFunction(() => !!window.hydraulicLab);
      assert.equal(await future.locator('#storage-recovery').isVisible(), true);
      await future.locator('#step').click(); await future.waitForTimeout(300);
      assert.equal(await future.evaluate(() => localStorage.getItem('hydraulic-lab-project-v1')), raw);
      assert.equal((await future.evaluate(() => window.hydraulicLab.project())).schemaVersion, 1);
    } finally { await futureContext.close(); }
  });

  await check('corrupt autosave originals can be recovered byte for byte', async () => {
    const raw = '{broken original\n유압 저장 원문 stays intact';
    const recoveryContext = await browser.newContext({ acceptDownloads: true });
    try {
      await recoveryContext.addInitScript(text => localStorage.setItem('hydraulic-lab-project-v1', text), raw);
      const recovery = await recoveryContext.newPage(); watch(recovery);
      await recovery.goto('http://127.0.0.1:5200/', { waitUntil: 'networkidle' });
      await recovery.waitForFunction(() => !!window.hydraulicLab);
      assert.equal(await recovery.locator('#storage-recovery').isVisible(), true);
      const downloadEvent = recovery.waitForEvent('download'); await recovery.locator('#recover-original').click();
      const download = await downloadEvent, file = path.join(output, 'recovered-original.txt');
      await download.saveAs(file); assert.equal(await fs.readFile(file, 'utf8'), raw);
      assert(await recovery.evaluate(text => Object.keys(localStorage).some(key => key.includes('original') && localStorage.getItem(key) === text), raw));
    } finally { await recoveryContext.close(); }
  });

  await check('1024px and 390px layouts retain settings and disassembly controls without horizontal overflow', async () => {
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: width === 1024 ? 768 : 844 }); await page.clock.runFor(100);
      await page.locator('[data-mode="exploded"]').click();
      assert.equal(await page.locator('#explode').isVisible(), true); await fill('#explode', .42);
      assert.equal((await state()).view.explode, .42);
      for (const id of ['pump-flow', 'relief-pressure', 'resisting-force', 'apply-settings', 'play', 'step']) assert(await page.locator(`#${id}`).isVisible(), `${id} hidden at ${width}`);
      const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, sceneHeight: document.querySelector('#scene').getBoundingClientRect().height }));
      assert(layout.scroll <= layout.width + 1, JSON.stringify(layout)); assert(layout.sceneHeight >= 280, JSON.stringify(layout));
    }
    await page.setViewportSize({ width: 1600, height: 1100 }); await page.clock.runFor(100);
  });

  await check('real-clock screenshots show the rendered apparatus at full and compact sizes', async () => {
    // Separate real-clock page lets ResizeObserver, RAF and GPU work complete;
    // screenshots must not capture a newly resized blank buffer under a paused clock.
    const visualContext = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
    const visual = await visualContext.newPage(); watch(visual);
    await visual.goto('http://127.0.0.1:5200/', { waitUntil: 'networkidle' });
    await visual.waitForFunction(() => !!window.hydraulicLab);
    await visual.locator('[data-mode="cutaway"]').click();
    await visual.locator('#reset-camera').click(); await visual.waitForTimeout(180);
    await visual.screenshot({ path: path.join(output, 'hydraulic-cutaway.png'), fullPage: true });
    await visual.locator('.workspace').screenshot({ path: path.join(output, 'hydraulic-workspace.png') });
    for (const part of ['piston', 'directional-spool', 'relief-poppet']) {
      await visual.locator('#part-select').selectOption(part); await visual.locator('#focus-part').click();
      await visual.waitForTimeout(180);
      await visual.locator('.workspace').screenshot({ path: path.join(output, `focus-${part}.png`) });
    }
    await visual.locator('#reset-camera').click();
    await visual.locator('[data-mode="exploded"]').click(); await visual.locator('#explode').fill('0.62');
    await visual.waitForTimeout(180); await visual.screenshot({ path: path.join(output, 'hydraulic-exploded.png'), fullPage: true });
    await visual.setViewportSize({ width: 1024, height: 768 }); await visual.waitForTimeout(180);
    await visual.screenshot({ path: path.join(output, 'hydraulic-compact.png'), fullPage: true });
    await visual.setViewportSize({ width: 390, height: 844 }); await visual.waitForTimeout(180);
    await visual.screenshot({ path: path.join(output, 'hydraulic-narrow.png'), fullPage: true });
    await visualContext.close();
  });

  await check('the application uses local assets and reports no browser errors', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'PASSED', checks, errors, externalRequests }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, externalRequests }, null, 2));
  throw error;
} finally { await browser.close(); await server.close(); }
