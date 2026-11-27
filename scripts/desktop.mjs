import { buildStagingDirectory, checkedPath, readInput, copyInput, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWeb } from './build-web.mjs';
import { requirePublisher, verifyFuses, verifyPublisher } from './windows-release.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package', 'package-release', 'package-test', 'prepare-test'].includes(mode)) throw new Error('Select a supported desktop build mode');
if (mode === 'prepare-test' && process.env.HYDRAULIC_DESKTOP_EXE) process.exit(0);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const test = mode === 'prepare-test' || mode === 'package-test';
const signed = mode === 'package-release';
const publisher = signed ? requirePublisher(process.env.HYDRAULIC_SIGNER_THUMBPRINT) : null;
if (signed && process.platform !== 'win32') throw new Error('Signed packaging requires Windows');
if (!signed) {
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete env[key];
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}
for (const input of ['src', 'public', 'desktop', 'docs', 'node_modules/electron']) checkTree(root, path.join(root, input));
const electronPackage = path.dirname(require.resolve('electron/package.json'));
await run(process.execPath, [path.join(electronPackage, 'install.js')]);
const bundle = path.join(root, test ? 'output/desktop-test-bundle' : 'dist');
await buildWeb({ test, destination: bundle });
if (mode === 'start') await run(require('electron'), [root]);
else if (mode !== 'prepare-test') {
  const stage = await buildStagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
  const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
  const filename = `Hydraulic-Lab-Setup-${packageInfo.version}.exe`;
  try {
    const inputs = [...new Set(['desktop', configuration.directories.buildResources, ...configuration.files.filter(file => !file.includes('*') && file !== 'package.json'), ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    copyInput(root, bundle, path.join(app, 'dist'));
    delete packageInfo.hydraulicTestBuild;
    if (test) {
      packageInfo.hydraulicTestBuild = true;
      configuration.electronFuses.enableNodeCliInspectArguments = true;
    }
    if (signed) configuration.forceCodeSigning = true;
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(packageInfo), { flag: 'wx', mode: 0o600 });
    const configFile = path.join(stage, 'electron-builder.json');
    fs.writeFileSync(configFile, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
    for (const dependency of Object.keys(packageInfo.dependencies || {})) {
      copyInput(root, path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency));
    }
    const electronDist = checkedPath(root, path.join(root, 'node_modules', 'electron', 'dist'));
    checkTree(root, electronDist);
    await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'),
      '--win', test ? 'dir' : 'nsis', '--x64', '--config', configFile, '--projectDir', app,
      `--config.electronDist=${electronDist}`, `--config.directories.output=${output}`, '--config.npmRebuild=false', '--publish', 'never']);
    const executable = path.join(output, 'win-unpacked', 'Hydraulic Lab.exe');
    await verifyFuses(executable, test);
    if (!test) {
      const installer = path.join(output, filename);
      if (signed) {
        await verifyPublisher(executable, publisher);
        await verifyPublisher(installer, publisher);
      }
      const hash = createHash('sha256').update(readInput(root, installer)).digest('hex');
      writeArtifact(root, installer + '.sha256', `${hash}  ${filename}\n`);
    }
    publishDirectory(root, output, path.join(root, test ? 'output/desktop-test-package' : 'release/windows'));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  if (!test) console.log(`Installer: ${path.join(root, 'release', 'windows', filename)}`);
}
