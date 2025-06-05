// ファイルベースJSONストレージによるGPUリポジトリ
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const GPUS_PATH = path.resolve(__dirname, '../../../data/gpus.json');

function loadGpus() {
  if (!fs.existsSync(GPUS_PATH)) return [];
  const raw = fs.readFileSync(GPUS_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function saveGpus(gpus) {
  fs.writeFileSync(GPUS_PATH, JSON.stringify(gpus, null, 2), 'utf-8');
}

module.exports = {
  getAll: () => loadGpus(),
  getById: (id) => loadGpus().find(g => g.id === id),
  getByOwner: (ownerId) => loadGpus().filter(g => g.ownerId === ownerId),
  create: (gpu) => {
    const gpus = loadGpus();
    const newGpu = { ...gpu, id: uuidv4(), createdAt: new Date().toISOString() };
    gpus.push(newGpu);
    saveGpus(gpus);
    return newGpu;
  },
  update: (id, updates) => {
    const gpus = loadGpus();
    const idx = gpus.findIndex(g => g.id === id);
    if (idx === -1) return null;
    gpus[idx] = { ...gpus[idx], ...updates };
    saveGpus(gpus);
    return gpus[idx];
  },
  delete: (id) => {
    let gpus = loadGpus();
    const prevLen = gpus.length;
    gpus = gpus.filter(g => g.id !== id);
    saveGpus(gpus);
    return gpus.length < prevLen;
  }
};
