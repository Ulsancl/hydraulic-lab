import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteProject } from '../desktop/atomic-save.cjs';
import { readAtMost, readRegularFile } from '../desktop/bounded-read.cjs';
import { writeWindowsProject } from '../desktop/windows-save.cjs';
import { runWindowsPowerShell } from '../desktop/windows-powershell.cjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hydraulic-save-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, target: path.join(directory, "관찰 [1] '실험'.json") };
}

async function validateTarget(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (stat.isFile() && !stat.isSymbolicLink()) return stat;
    throw new Error('Unsafe target');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('new saves and replacements keep a restricted DACL or private POSIX mode', async t => {
  const { directory, target } = await fixture(t);
  await atomicWriteProject(target, '{"old":"보관"}', { validateTarget });
  const getDacl = `
$file = (ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())).file
$acl = [IO.File]::GetAccessControl($file)
[Console]::WriteLine($acl.GetSecurityDescriptorSddlForm('Access'))
`;
  let originalDacl;
  if (process.platform === 'win32') {
    assert.match(await runWindowsPowerShell(getDacl, { file: target }), /^D:P/);
    // Give this file a distinct protected ACL, independent of the parent.
    const setDacl = `
$file = (ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())).file
$acl = [IO.File]::GetAccessControl($file)
$guests = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-546')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($guests, 'Read', 'Deny'))
[IO.File]::SetAccessControl($file, $acl)
`;
    await runWindowsPowerShell(setDacl, { file: target });
    originalDacl = await runWindowsPowerShell(getDacl, { file: target });
    assert.match(originalDacl, /;\s*BG\)/);
    const collision = path.join(directory, 'existing.tmp');
    await fs.writeFile(collision, 'unrelated');
    await assert.rejects(writeWindowsProject(target, collision, '{}', true));
    assert.equal(await fs.readFile(collision, 'utf8'), 'unrelated');
    await fs.unlink(collision);
  }
  await atomicWriteProject(target, '{"new":"완료"}', { validateTarget });
  assert.equal(await fs.readFile(target, 'utf8'), '{"new":"완료"}');
  if (process.platform === 'win32') assert.equal(await runWindowsPowerShell(getDacl, { file: target }), originalDacl);
  else assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), [path.basename(target)]);
});

test('a failed flush closes and removes its incomplete sibling, leaving the destination intact', async t => {
  const { directory, target } = await fixture(t);
  await fs.writeFile(target, 'original');
  let closed = false;
  const operations = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    return {
      writeFile: (...values) => handle.writeFile(...values),
      sync: async () => { throw new Error('synthetic flush failure'); },
      close: async () => { await handle.close(); closed = true; },
    };
  } };
  await assert.rejects(atomicWriteProject(target, 'new', { validateTarget, windowsWrite: null, operations }), /flush failure/);
  assert.equal(closed, true);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(directory), [path.basename(target)]);
});

test('bounded reads accept the exact limit and request at most one byte beyond it', async t => {
  const { directory, target } = await fixture(t);
  await fs.writeFile(target, '1234');
  assert.equal((await readRegularFile(target, 4)).toString(), '1234');
  await assert.rejects(readRegularFile(target, 3), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(readRegularFile(directory, 4), /regular file/);
  const requests = [];
  const growing = { async read(_buffer, _offset, size, position) {
    requests.push({ size, position });
    return { bytesRead: Math.min(size, 2) };
  } };
  await assert.rejects(readAtMost(growing, 4), { code: 'FILE_TOO_LARGE' });
  assert.deepEqual(requests, [{ size: 5, position: 0 }, { size: 3, position: 2 }, { size: 1, position: 4 }]);
});
