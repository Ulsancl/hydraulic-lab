const { constants } = require('node:fs');
const fs = require('node:fs/promises');

const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const tooLarge = () => Object.assign(new Error('File exceeds the read limit'), { code: 'FILE_TOO_LARGE' });

async function readAtMost(handle, limit) {
  const chunks = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  throw tooLarge();
}

async function readRegularFile(filename, limit, expected) {
  expected ??= await fs.lstat(filename);
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error('Expected a regular file');
  if (expected.size > limit) throw tooLarge();
  const handle = await fs.open(filename, readFlags);
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(filename);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink()
        || [expected, current].some(stat => stat.ino !== opened.ino || stat.dev !== opened.dev)) {
      throw new Error('File changed while opening');
    }
    if (opened.size > limit) throw tooLarge();
    return await readAtMost(handle, limit);
  } finally { await handle.close(); }
}

module.exports = { readAtMost, readRegularFile };
