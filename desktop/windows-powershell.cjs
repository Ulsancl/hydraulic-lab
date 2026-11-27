const { spawn } = require('node:child_process');
const path = require('node:path');

function runWindowsPowerShell(script, input) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows system directory unavailable');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from("$ErrorActionPreference = 'Stop'\n[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n" + script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(output.trim() || 'Windows file operation failed'));
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(JSON.stringify(input), 'utf8');
  });
}

module.exports = { runWindowsPowerShell };
