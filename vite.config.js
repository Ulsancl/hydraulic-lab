import { defineConfig } from 'vite';

const generated = ['output', 'release', '.security-stage-*', 'dist'];

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5199, strictPort: true,
    // Generated Electron profiles contain locked GPU databases on Windows.
    // Watching them is unnecessary for source reloads and can crash the server.
    watch: { ignored: watchedPath => /[\\/](?:output|release|dist|\.security-stage-[^\\/]+)(?:[\\/]|$)/.test(watchedPath) },
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...generated.map(dir => `**/${dir}/**`)] },
  },
});
