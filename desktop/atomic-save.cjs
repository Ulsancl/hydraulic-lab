const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeWindowsProject } = require('./windows-save.cjs');

async function atomicWriteProject(target, contents, {
  validateTarget,
  operations = fs,
  windowsWrite = process.platform === 'win32' ? writeWindowsProject : null,
} = {}) {
  if (typeof validateTarget !== 'function') throw new TypeError('A target validator is required');
  const original = await validateTarget(target);
  const temporary = path.join(path.dirname(target), `.hydraulic-${randomUUID()}.tmp`);
  if (windowsWrite) return windowsWrite(target, temporary, contents, Boolean(original));
  let ownsTemporary = false;
  try {
    const handle = await operations.open(temporary, 'wx', 0o600);
    ownsTemporary = true;
    try { await handle.writeFile(contents, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    const current = await validateTarget(target);
    if (!original) {
      // Publish an entirely new name without replacing another writer's file.
      await operations.link(temporary, target);
    } else {
      if (!current || current.ino !== original.ino || current.dev !== original.dev || original.uid !== process.getuid()) {
        throw new Error('저장 대상이나 소유자가 변경되었습니다. 다른 파일 이름을 선택해 주세요.');
      }
      await operations.rename(temporary, target);
      ownsTemporary = false;
    }
  } finally {
    if (ownsTemporary) await operations.unlink(temporary).catch(() => {});
  }
}

module.exports = { atomicWriteProject };
