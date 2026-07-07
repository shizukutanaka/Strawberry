// tests/db/json-repo-corrupt.test.js
// Regression: a corrupt/unparseable JSON data file must fail closed (throw),
// NOT silently return [] — otherwise the next create/update would atomicWrite
// an empty array over recoverable data (irreversible loss for escrows/payments).
const fs = require('fs');
const path = require('path');
const { createJsonRepository } = require('../../src/db/json/createJsonRepository');

const DATA_DIR = path.resolve(__dirname, '../../data');
const FILE = `__corrupt_probe_${process.pid}.json`;
const FULL = path.join(DATA_DIR, FILE);

describe('createJsonRepository: corrupt file fail-closed', () => {
  afterEach(() => {
    try { fs.unlinkSync(FULL); } catch (_) {}
  });

  it('throws on unparseable JSON instead of returning []', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FULL, '{ this is not valid json', 'utf-8');
    const repo = createJsonRepository(FILE);
    expect(() => repo.getAll()).toThrow(/corrupt/i);
    // crucially the file must be preserved (not truncated) for recovery
    expect(fs.readFileSync(FULL, 'utf-8')).toBe('{ this is not valid json');
  });

  it('throws when top-level JSON is not an array (e.g. an object)', () => {
    fs.writeFileSync(FULL, '{"unexpected":"object"}', 'utf-8');
    const repo = createJsonRepository(FILE);
    expect(() => repo.getAll()).toThrow(/corrupt/i);
  });

  it('returns [] for a non-existent file (valid empty state)', () => {
    const repo = createJsonRepository(`__never_created_${process.pid}.json`);
    expect(repo.getAll()).toEqual([]);
  });
});
