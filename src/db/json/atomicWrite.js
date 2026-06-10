// src/db/json/atomicWrite.js
// Write to a temp file then atomically rename to the target path.
// This prevents partial/corrupt writes if the process crashes mid-write.
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

function makeTmp(filePath) {
  return `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = makeTmp(filePath);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

function atomicWriteString(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = makeTmp(filePath);
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
}

module.exports = { atomicWriteJSON, atomicWriteString };
