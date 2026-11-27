import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import { requirePublisher, verifyFuses, verifyPublisher } from '../scripts/windows-release.mjs';

// Launching the production executable uses the default Electron profile.
// Run on the disposable Windows Actions runner.
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const executable = path.resolve('release/windows/win-unpacked/Hydraulic Lab.exe');
await verifyFuses(executable, false);
// The ordinary CI package is unsigned. A release verification must reject it.
assert.throws(() => requirePublisher(), /HYDRAULIC_SIGNER_THUMBPRINT/);
await assert.rejects(verifyPublisher(executable), /Authenticode signature status: NotSigned/);

const child = spawn(executable, ['--remote-debugging-port=0'], {
  env: { ...process.env, HYDRAULIC_LAB_DATA_DIR: 'must-be-ignored' },
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
});
const lines = createInterface({ input: child.stderr });
const exit = once(child, 'exit');
let browser;
try {
  const wsEndpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Production desktop did not start')), 30_000);
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Production desktop exited: ' + code)));
    lines.on('line', line => {
      const match = /^DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)$/.exec(line);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('close', () => clearTimeout(timeout));
  });
  browser = await chromium.connectOverCDP(wsEndpoint, { timeout: 15_000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 15_000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForURL('app://hydraulic/');
  await page.locator('#scene canvas').waitFor({ timeout: 20_000 });
  assert.deepEqual(await page.evaluate(() => [
    typeof window.hydraulicLab, typeof window.advanceTime, typeof window.render_game_to_text,
    window.hydraulicDesktop.isDesktop,
  ]), ['undefined', 'undefined', 'undefined', true]);
  await page.locator('#step').click();
  await page.locator('#help').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  assert.deepEqual(errors, []);
  console.log('Production ASAR launched with verified fuses, native controls and no test hooks');
} finally {
  await browser?.close();
  lines.close();
  child.kill();
  await exit;
}
