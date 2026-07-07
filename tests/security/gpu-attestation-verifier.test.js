// tests/security/gpu-attestation-verifier.test.js
const {
  verifyAttestation,
  createMockAttestationVerifier,
  DEFAULTS,
} = require('../../src/security/gpu-attestation-verifier');

const claimed = { model: 'A100', vendor: 'NVIDIA', memoryGB: 80, driverVersion: '535.0' };

describe('gpu-attestation-verifier', () => {
  let mock;
  let validReport;

  beforeEach(() => {
    mock = createMockAttestationVerifier();
    validReport = mock.buildReport(claimed);
  });

  // ---- happy path ----

  it('passes a fully matching report with score=1', async () => {
    const result = await mock.verify(claimed, validReport);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.findings).toHaveLength(0);
  });

  it('buildReport produces a fresh, valid report', () => {
    expect(validReport.firmwareIntegrity).toBe(true);
    expect(validReport.certChain.length).toBeGreaterThan(0);
    expect(typeof validReport.signature).toBe('string');
    expect(validReport.signature.length).toBeGreaterThanOrEqual(8);
  });

  it('records every call in mock.calls', async () => {
    await mock.verify(claimed, validReport);
    await mock.verify(claimed, validReport);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0].claimed).toBe(claimed);
  });

  // ---- model checks ----

  it('fails when attested model differs (critical check forces pass=false regardless of score)', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, model: 'H100' });
    expect(r.passed).toBe(false);
    expect(r.findings.some(f => f.includes('model'))).toBe(true);
  });

  it('is case-insensitive for model comparison', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, model: 'a100' });
    expect(r.passed).toBe(true);
  });

  it('fails on tampered report (buildReport tampered=true)', async () => {
    const tampered = mock.buildReport(claimed, { tampered: true });
    const r = await mock.verify(claimed, tampered);
    expect(r.passed).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  // ---- memory checks ----

  it('accepts memory within tolerance (±5%)', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, memoryGB: 81 }); // ~1.25%
    expect(r.passed).toBe(true);
    expect(r.findings.filter(f => f.includes('memory'))).toHaveLength(0);
  });

  it('fails on memory mismatch beyond tolerance', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, memoryGB: 40 }); // 50%
    expect(r.passed).toBe(false);
    expect(r.findings.some(f => f.includes('memory'))).toBe(true);
  });

  it('allows custom tolerance via opts', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, memoryGB: 72 }, { memoryTolerancePct: 15 });
    expect(r.findings.filter(f => f.includes('memory'))).toHaveLength(0);
  });

  // ---- firmware / cert ----

  it('fails when firmwareIntegrity is false', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, firmwareIntegrity: false });
    expect(r.passed).toBe(false);
    expect(r.findings.some(f => f.includes('firmware'))).toBe(true);
  });

  it('lowers score on missing cert chain but does not fail if score stays above threshold', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, certChain: [] });
    expect(r.score).toBeLessThan(1);
    expect(r.findings.some(f => f.includes('certificate'))).toBe(true);
  });

  // ---- freshness / replay ----

  it('fails on stale report (buildReport stale=true)', async () => {
    const stale = mock.buildReport(claimed, { stale: true });
    const r = await mock.verify(claimed, stale);
    expect(r.passed).toBe(false);
    expect(r.findings.some(f => /old|age/.test(f))).toBe(true);
  });

  it('accepts a custom maxAgeSec that covers a stale report', async () => {
    const stale = mock.buildReport(claimed, { stale: true }); // 2h old
    const r = await mock.verify(claimed, stale, { maxAgeSec: 10800 }); // allow 3h
    expect(r.findings.filter(f => /old|age/.test(f))).toHaveLength(0);
  });

  // ---- signature ----

  it('fails on missing signature', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, signature: undefined });
    expect(r.findings.some(f => f.includes('signature'))).toBe(true);
  });

  it('fails on too-short signature', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, signature: 'abc' });
    expect(r.findings.some(f => f.includes('signature'))).toBe(true);
  });

  // ---- measurements ----

  it('fails on temperature out of range', async () => {
    const r = await verifyAttestation(claimed, {
      ...validReport,
      measurements: { tempC: 200, powerW: 200, utilizationPct: 5 },
    });
    expect(r.findings.some(f => f.includes('temperature'))).toBe(true);
  });

  it('fails on power draw out of range', async () => {
    const r = await verifyAttestation(claimed, {
      ...validReport,
      measurements: { tempC: 45, powerW: 1500, utilizationPct: 5 },
    });
    expect(r.findings.some(f => f.includes('power'))).toBe(true);
  });

  it('fails on utilization out of range', async () => {
    const r = await verifyAttestation(claimed, {
      ...validReport,
      measurements: { tempC: 45, powerW: 200, utilizationPct: 150 },
    });
    expect(r.findings.some(f => f.includes('utilization'))).toBe(true);
  });

  // ---- minScore / partial ----

  it('partial failure lowers score without making it zero', async () => {
    const r = await verifyAttestation(claimed, { ...validReport, firmwareIntegrity: false });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('is a pure function — identical inputs produce identical outputs', async () => {
    const r1 = await verifyAttestation(claimed, validReport);
    const r2 = await verifyAttestation(claimed, validReport);
    expect(r1).toEqual(r2);
  });
});
