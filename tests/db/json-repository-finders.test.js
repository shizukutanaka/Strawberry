// tests/db/json-repository-finders.test.js
// ReputationRepository / VerificationRepository are 8-line wrappers around
// createJsonRepository whose entire contract is the finder→field mapping
// (providerId / jobId). A typo in the field name would make the finder
// silently return null forever — verification-service.js calls
// repo.getByJobId(jobId) on every verification lookup. These tests pin the
// wiring: insert a row, hit the generated finder, confirm null on mismatch.

const fs = require('fs');
const path = require('path');

const { resolveDataDir } = require('../../src/db/json/data-dir');

const DATA_DIR = resolveDataDir();

describe('createJsonRepository finder wiring', () => {
  const saved = {};
  const FILES = ['reputations.json', 'verifications.json'];

  beforeAll(() => {
    for (const f of FILES) {
      const p = path.join(DATA_DIR, f);
      saved[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
  });
  afterAll(() => {
    for (const f of FILES) {
      const p = path.join(DATA_DIR, f);
      if (saved[f] === null) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      } else {
        fs.writeFileSync(p, saved[f]);
      }
    }
  });

  it('ReputationRepository.getByProviderId matches on providerId', () => {
    const ReputationRepository = require('../../src/db/json/ReputationRepository');
    const row = ReputationRepository.create({ providerId: 'prov-test-1', score: 90 });
    expect(ReputationRepository.getByProviderId('prov-test-1')).toMatchObject({ providerId: 'prov-test-1', score: 90 });
    expect(ReputationRepository.getByProviderId('prov-other')).toBeNull();
    expect(row.id).toBeTruthy();
  });

  it('VerificationRepository.getByJobId matches on jobId', () => {
    const VerificationRepository = require('../../src/db/json/VerificationRepository');
    VerificationRepository.create({ jobId: 'job-test-1', result: 'ok' });
    expect(VerificationRepository.getByJobId('job-test-1')).toMatchObject({ jobId: 'job-test-1' });
    expect(VerificationRepository.getByJobId('job-other')).toBeNull();
  });
});
