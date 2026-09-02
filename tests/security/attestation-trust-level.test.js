// tests/security/attestation-trust-level.test.js
//
// 主張（修正前の UI）: 「スペック: 実測検証済み」／ツールチップ「実機ベンチマークで
// 申告スペックと一致を確認済み」。
//
// 問: **誰がそれを確認したのか。**
// 答: 誰も。照合するのは「プロバイダーが申告したスペック」と「プロバイダーが同じ
// リクエストで送ってきたレポート」であり、署名は長さ 8 文字以上かどうか、証明書チェーンは
// 配列が空でないかしか見ていない。つまりプロバイダーは自分で書いた JSON を添えるだけで
// 「実測検証済み」の緑バッジと、未知型番のスコア上限解除を買えた。実機ベンチマークは
// どこにも存在しない（サーバは他人のマシンでコードを実行する権限を持たないので、
// ベンチマーク API は以前この理由で削除された）。
//
// 直し方は「バッジの文言を変える」ではなく、**証拠の強さを型で持たせて、表示側が
// それを見ないと『検証済み』と言えない形にする**こと。
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app } = require('../../src/api/server');
const UserRepository = require('../../src/db/json/UserRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const {
  verifyAttestation, createMockAttestationVerifier, TRUST_LEVELS,
} = require('../../src/security/gpu-attestation-verifier');
const { computePerfScore } = require('../../src/gpu/perf-score');

const uniq = `atl${Date.now().toString(36)}`;

afterAll(() => {
  const { server } = require('../../src/api/server');
  return new Promise((done) => (server && server.close ? server.close(() => done()) : done()));
});

// プロバイダーが手で書ける「完璧な」レポート。実機は一切関与しない。
function selfWrittenReport(claimed) {
  return {
    model: claimed.model,
    vendor: claimed.vendor,
    memoryGB: claimed.memoryGB,
    driverVersion: '535.0',
    firmwareIntegrity: true,
    certChain: ['I-MADE-THIS-UP'],
    timestamp: new Date().toISOString(),
    signature: 'not-a-real-signature',
    measurements: { tempC: 60, powerW: 350, utilizationPct: 20 },
  };
}

describe('the verifier never claims more than it checked', () => {
  const claimed = { model: 'RTX 4090', vendor: 'NVIDIA', memoryGB: 24 };

  it('passes a self-written report — that is exactly why passed alone must not mean "verified"', async () => {
    const r = await verifyAttestation(claimed, selfWrittenReport(claimed));
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThan(0.9);
    // それでも第三者検証ではない。
    expect(r.trustLevel).toBe(TRUST_LEVELS.SELF_REPORTED);
  });

  it('never returns hardware_attested, however perfect the report looks', async () => {
    const r = await verifyAttestation(claimed, selfWrittenReport(claimed));
    expect(r.trustLevel).not.toBe(TRUST_LEVELS.HARDWARE_ATTESTED);
    const mock = createMockAttestationVerifier();
    const m = await mock.verify(claimed, mock.buildReport(claimed));
    expect(m.passed).toBe(true);
    expect(m.trustLevel).toBe(TRUST_LEVELS.SELF_REPORTED);
  });

  it('says so in its own header, so the next reader is not misled', () => {
    const src = fs.readFileSync(require.resolve('../../src/security/gpu-attestation-verifier.js'), 'utf-8');
    expect(src).toMatch(/信頼の根は無い/);
  });
});

describe('a self-written report does not buy trust anywhere in the product', () => {
  let token;

  beforeAll(async () => {
    const name = `${uniq}p`.slice(0, 20);
    const email = `${name}@example.com`;
    await request(app).post('/api/v1/users/register').send({ username: name, email, password: 'Test1234!' });
    UserRepository.update(UserRepository.getByEmail(email).id, { role: 'provider' });
    token = (await request(app).post('/api/v1/users/login').send({ email, password: 'Test1234!' })).body.token;
  });

  it('registration records the trust level alongside the pass, not just the pass', async () => {
    const claimed = { name: `Attested GPU ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24, pricePerHour: 100 };
    const res = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...claimed, attestationReport: selfWrittenReport(claimed) });
    expect(res.statusCode).toBe(201);

    const stored = GpuRepository.getById(res.body.gpu.id);
    expect(stored.attestation.passed).toBe(true);
    expect(stored.attestation.trustLevel).toBe(TRUST_LEVELS.SELF_REPORTED);
  });

  it('does not raise the performance confidence to attested', async () => {
    const claimed = { name: `Perf GPU ${uniq}`, vendor: 'NVIDIA', model: 'RTX 4090', memoryGB: 24, pricePerHour: 100 };
    const res = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...claimed, attestationReport: selfWrittenReport(claimed) });
    const stored = GpuRepository.getById(res.body.gpu.id);
    expect(computePerfScore(stored).confidence).toBe('reference');
  });

  it('does not lift the unknown-model score cap (no rank-buying with a self-written report)', async () => {
    const claimed = {
      name: `Mystery GPU ${uniq}`, vendor: 'NVIDIA', model: `Mystery-${uniq}`, memoryGB: 80, pricePerHour: 100,
      powerWatt: 300, performance: { teraflops: 50000 },
    };
    const res = await request(app).post('/api/v1/gpus')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...claimed, attestationReport: selfWrittenReport(claimed) });
    const stored = GpuRepository.getById(res.body.gpu.id);
    const perf = computePerfScore(stored);
    expect(perf.score).toBeLessThanOrEqual(100);
    expect(perf.findings.some((f) => f.startsWith('unverified_model_capped'))).toBe(true);
  });
});

describe('the UI cannot call it verified without the trust level', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../../public/js/ui.js'), 'utf-8');
  const badge = ui.slice(ui.indexOf('export function attestationBadge'), ui.indexOf('export function perfBadge'));

  it('gates the verified wording on trustLevel, not on passed', () => {
    expect(badge).toMatch(/trustLevel === 'hardware_attested'/);
    // 「検証済み」を名乗る枝は hardware_attested の内側にしかない。
    const verifiedBranch = badge.slice(badge.indexOf("trustLevel === 'hardware_attested'"));
    expect(verifiedBranch).toMatch(/検証済み/);
    const beforeBranch = badge.slice(0, badge.indexOf("trustLevel === 'hardware_attested'"));
    expect(beforeBranch).not.toMatch(/検証済み/);
  });

  it('no longer claims a benchmark was run anywhere in the UI', () => {
    // 実機ベンチマークは存在しない（ベンチマーク API はこの理由で削除済み）。
    for (const file of ['ui.js', 'pages/gpu-detail.js', 'pages/market.js']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../public/js', file), 'utf-8');
      expect(src).not.toMatch(/実機ベンチマーク/);
    }
  });

  it('does not buy ranking weight in GET /gpus?sort=recommended', async () => {
    // 総合順位の 10% がアテステーションに割り当てられている。自作レポートで満点を
    // 取れるなら、それは順位を金で買う経路になる。
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/api/routes/gpu/index.js'), 'utf-8');
    // 順位に渡す値は、第三者検証を要求する述語を通っていること。
    expect(src).toMatch(/attestationScore: attestationCounts\(/);
    expect(src).toMatch(/attestationPassed: attestationCounts\(/);
    expect(src).toMatch(/attestationCounts = \(att\) => Boolean\([\s\S]{0,200}HARDWARE_ATTESTED/);
    // passed だけを見る旧形が復活していないこと。
    expect(src).not.toMatch(/attestationScore: \(g\.attestation && g\.attestation\.score\) \|\| 0/);
  });
});

