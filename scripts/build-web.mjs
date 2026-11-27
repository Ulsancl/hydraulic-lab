import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildStagingDirectory, checkTree, copyInput, publishDirectory } from './safe-files.mjs';
import { documentPolicy } from '../desktop/content-policy.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWeb({ test = false, destination = path.join(root, 'dist') } = {}) {
  const previous = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (previous) {
    checkTree(root, destination);
    if (!previous.isDirectory()) throw new Error('Build output must be a directory');
  }
  const stage = await buildStagingDirectory(root);
  const project = path.join(stage, 'web');
  const output = path.join(stage, 'bundle');
  try {
    for (const input of ['index.html', 'src', 'public', 'node_modules/three']) {
      copyInput(root, path.join(root, input), path.join(project, input));
    }
    await build({
      root: project,
      base: './',
      configFile: false,
      envFile: false,
      mode: test ? 'test' : 'production',
      build: { outDir: output, emptyOutDir: false },
      plugins: [{
        name: 'hydraulic-document-policy',
        transformIndexHtml: () => [{
          tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: documentPolicy },
          injectTo: 'head-prepend',
        }],
      }],
    });
    publishDirectory(root, output, destination);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb();
