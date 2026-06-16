// src/db/json/atomicWrite.js
// Write to a temp file then atomically rename to the target path.
// This prevents partial/corrupt writes if the process crashes mid-write.
//
// Durability: the temp file is fsync'd before the rename and the containing
// directory is fsync'd after, so a committed write survives a power loss / OS
// crash. Without this, a crash after renameSync could leave the old contents —
// or a zero-length file on some filesystems — which for persisted escrow/payment
// state would silently lose a committed transition and strand funds.
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

function makeTmp(filePath) {
  return `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

// Write `content` to a temp file, fsync it to disk, atomically rename onto
// `filePath`, then fsync the directory so the rename itself is durable.
function durableWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = makeTmp(filePath);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, content);
    fs.fsyncSync(fd); // flush file data+metadata before the rename
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
    // fsync the directory so the rename (a directory-entry change) is durable.
    // Not supported on every platform (e.g. Windows) — best-effort.
    let dirFd;
    try {
      dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
    } catch (_) {
      /* directory fsync unsupported on this platform; rename is still atomic */
    } finally {
      if (dirFd !== undefined) {
        try { fs.closeSync(dirFd); } catch (_) {}
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function atomicWriteJSON(filePath, data) {
  durableWrite(filePath, JSON.stringify(data, null, 2));
}

function atomicWriteString(filePath, content) {
  durableWrite(filePath, content);
}

module.exports = { atomicWriteJSON, atomicWriteString };
