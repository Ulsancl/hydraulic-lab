import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const generated = ['output', 'release', '.security-stage-*', 'dist'];
const projectRoot = normalizePath(path.dirname(fileURLToPath(import.meta.url)));
const projectGlob = projectRoot.replace(/[\\?*[\]{}()!+@]/g, '\\$&');

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5199, strictPort: true,
    // Generated Electron profiles contain locked GPU databases on Windows.
    // Watching them is unnecessary for source reloads and can crash the server.
    watch: { ignored: watchedPath => /[\\/](?:output|release|dist|\.security-stage-[^\\/]+)(?:[\\/]|$)/.test(watchedPath) },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...generated.map(dir => `${projectGlob}/${dir}/**`)] },
  },
});
