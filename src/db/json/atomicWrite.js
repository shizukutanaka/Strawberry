// src/db/json/atomicWrite.js
// Write JSON to a temp file then atomically rename to the target path.
// This prevents partial/corrupt writes if the process crashes mid-write.
const fs = require('fs');
const path = require('path');

function atomicWriteJSON(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

module.exports = { atomicWriteJSON };
