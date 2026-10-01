import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/guide-browser');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5201, strictPort: true, hmr: false } });
await server.listen();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
const page = await context.newPage(), errors = [], checks = [], externalRequests = [];
function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
watch(page);
const guide = () => page.evaluate(() => window.hydraulicLab.guide());
const state = () => page.evaluate(() => window.hydraulicLab.getState());
const project = () => page.evaluate(() => window.hydraulicLab.project());
const advance = seconds => page.evaluate(dt => window.hydraulicLab.step(dt), seconds);
async function lesson(id) {
  if (!await page.locator('#lesson-picker').evaluate(element => element.open)) await page.locator('#lesson-picker > summary').click();
  await page.locator(`[data-lesson="${id}"]`).click();
  assert.equal(await page.locator('#lesson-picker').evaluate(element => element.open), false);
}
const command = id => page.locator(`[data-command="${id}"]`).click();
const near = (actual, expected, tolerance = 1e-9) => assert(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
async function stage(expected, status = 'active') {
  const current = await guide(); assert.equal(current.status, status); assert.equal(current.stepIndex, expected);
  assert(await page.locator('#lesson-guide').isVisible());
  if (status === 'active') assert((await page.locator('#guide-action').textContent()).trim().length > 0);
  if (status === 'completed') assert(await page.locator('#guide-result').isVisible());
  return current;
}

try {
  const origin = new Date('2026-10-01T00:00:00Z');
  await page.clock.install({ time: origin }); await page.clock.pauseAt(origin);
  await page.goto('http://127.0.0.1:5201/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.hydraulicLab?.guide));
  await page.clock.runFor(100);

  await check('Space on native disclosure headings toggles the section without starting the simulation', async () => {
    for (const selector of ['#lesson-picker > summary', '.energy-details > summary']) {
      const heading = page.locator(selector), before = await state();
      const opened = await heading.evaluate(element => element.parentElement.open);
      await heading.focus(); await page.keyboard.press('Space');
      assert.equal(await heading.evaluate(element => element.parentElement.open), !opened);
      assert.equal((await state()).running, false); assert.deepEqual((await state()).state, before.state);
    }
  });

  await check('guided speed comparison requires actual full strokes and excludes time at the stops', async () => {
    await lesson('speed-ratio'); await stage(0);
    assert.equal((await state()).running, false);
    await advance(0); await stage(0);
    await command('neutral'); await advance(10); await stage(0);
    await command('extend'); await page.locator('#play').click();
    await page.clock.fastForward(10000);
    if ((await state()).running) await page.locator('#play').click();
    near((await state()).state.positionM, .3); await stage(1);
    await advance(20); await stage(1); // More end-stop circulation cannot finish the return stroke.
    await command('retract'); await advance(20);
    await stage(2, 'completed'); near((await state()).state.positionM, 0);
    const result = await page.locator('#guide-result').innerText();
    assert.match(result, /35[.,]37/); assert.match(result, /53[.,]61/);
    const records = (await guide()).evidence;
    near(records[0].movingTimeS, .3 * Math.PI * .06 ** 2 / 4 / .0001);
    near(records[1].movingTimeS, .3 * Math.PI * (.06 ** 2 - .035 ** 2) / 4 / .0001);
    assert(records[0].movingTimeS < 10 && records[1].movingTimeS < 20);
  });

  await check('pressure lesson requires observed relief, forward travel and an explicit changed-condition return', async () => {
    await lesson('pressure-limit'); await stage(0);
    await advance(0); await stage(0);
    await page.locator('#step').click(); await stage(1);
    const stalled = await state(); near(stalled.state.positionM, .15);
    assert.equal(stalled.snapshot.status, 'pressure-limit'); assert(stalled.state.energyJ.relief > 0);
    await command('extend'); await page.locator('#step').click(); await stage(2);
    const position = (await state()).state.positionM; assert(position > .15);
    await page.locator('#relief-pressure').fill('50'); await page.locator('#apply-settings').click();
    assert.equal((await guide()).pressureChangeApplied, true); await stage(2);
    near((await state()).state.positionM, position); assert.equal((await state()).state.timeS, 0);
    await command('retract'); await page.locator('#step').click(); await stage(3, 'completed');
    assert((await state()).state.positionM < position);
  });

  await check('neutral lesson needs prior travel and a later interval of isolated positive pressure', async () => {
    await lesson('neutral-hold'); await stage(0);
    await command('neutral'); await advance(2); await stage(0);
    await command('extend'); await page.locator('#step').click(); await stage(1);
    const moving = await state(); assert(moving.state.pressureAPa > 0);
    await command('neutral'); await stage(2); const held = await state();
    await advance(0); await stage(2);
    await page.locator('#step').click(); await stage(3, 'completed');
    const after = await state(); near(after.state.positionM, held.state.positionM);
    assert.equal(after.state.pressureAPa, held.state.pressureAPa);
    assert.equal(after.state.pressureBPa, held.state.pressureBPa);
    assert.equal(after.snapshot.portsPa.P, 0); assert(after.snapshot.flowsM3s.valveToTank > 0);
  });

  await check('conditions outside a guided comparison interrupt it and restart prepares the stated experiment', async () => {
    await lesson('speed-ratio'); await page.locator('#pump-flow').fill('9'); await page.locator('#apply-settings').click();
    assert.equal((await guide()).status, 'interrupted');
    assert((await page.locator('#guide-status').innerText()).trim().length > 0);
    await advance(100); assert.equal((await guide()).status, 'interrupted');
    await page.locator('#guide-restart').click(); await stage(0);
    const after = await state(); near(after.state.settings.pumpFlowM3s * 60000, 6);
    assert.equal(after.state.positionM, 0); assert.equal(after.state.timeS, 0);
  });

  await check('undo restores guide evidence and the complete experiment before changed conditions', async () => {
    await lesson('pressure-limit'); await advance(1); await command('extend'); await advance(.1); await stage(2);
    const priorProject = await project(), priorGuide = await guide();
    await page.locator('#relief-pressure').fill('50'); await page.locator('#apply-settings').click();
    assert.equal((await guide()).pressureChangeApplied, true);
    await page.locator('#undo-new').click();
    assert.deepEqual(await project(), priorProject); assert.deepEqual(await guide(), priorGuide);
  });

  await check('free exploration and imported files cannot inherit or invent guided completion', async () => {
    const before = await project(); await page.locator('#guide-exit').click();
    assert.equal(await guide(), null); assert.deepEqual(await project(), before);
    assert.equal(await page.locator('#lesson-guide').isVisible(), false);
    assert.equal(await page.locator('#lesson-picker').evaluate(element => element.open), true);
    await lesson('neutral-hold'); await advance(.1); await command('neutral'); await advance(.1);
    assert.equal((await guide()).status, 'completed');
    const downloadEvent = page.waitForEvent('download'); await page.locator('#save-project').click();
    const downloaded = await downloadEvent, filename = path.join(output, 'completed-experiment.json');
    await downloaded.saveAs(filename); const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    assert.equal(saved.guide, undefined); assert.equal(saved.observation.guide, undefined);
    await lesson('speed-ratio'); await page.locator('#file-input').setInputFiles(filename);
    await page.waitForFunction(() => !document.querySelector('#save-project').disabled);
    assert.equal(await guide(), null); assert.deepEqual(await project(), saved);
    await lesson('neutral-hold'); await page.locator('#new-project').click(); assert.equal(await guide(), null);
  });

  await check('full and narrow guides expose actions and results alongside the real apparatus', async () => {
    const realContext = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const realPage = await realContext.newPage(); watch(realPage);
    try {
      await realPage.goto('http://127.0.0.1:5201/', { waitUntil: 'networkidle' });
      await realPage.waitForFunction(() => Boolean(window.hydraulicLab?.guide));
      await realPage.locator('[data-lesson="speed-ratio"]').click();
      await realPage.evaluate(() => window.hydraulicLab.step(10));
      await realPage.screenshot({ path: path.join(output, 'guide-speed.png'), fullPage: true });
      for (const width of [1024, 390]) {
        await realPage.setViewportSize({ width, height: 1000 });
        await realPage.locator('#guide-action').scrollIntoViewIfNeeded();
        await realPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await realPage.locator('#guide-restart').isVisible()); assert(await realPage.locator('#guide-exit').isVisible());
        const overflow = await realPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); assert.equal(overflow, false);
        await realPage.screenshot({ path: path.join(output, `guide-${width}.png`), fullPage: true });
      }
    } finally { await realContext.close(); }
  });
  await check('guided journeys have no runtime errors or external requests', async () => { assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []); });
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'PASSED', checks, errors, externalRequests }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ status: 'FAILED', checks, errors, externalRequests, message: error.stack }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); await server.close(); }
