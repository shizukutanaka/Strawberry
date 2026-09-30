// provider-uptime のバッチ書き込み（pending 差分 + 定期 flush）を検証する。
// 契約:
//  - 初見プロバイダーの最初の1ビートは同期で uptime.json にレコードを作る
//    （「1ビートでレコードが見える」既存挙動・provider-reliability.test.js と同契約）
//  - 2ビート目以降は pending に積まれ、getReliability では即時に反映されて見えるが
//    ディスクには _flushPending まで書かれない（I/O 削減の肝）
//  - フラッシュは複数プロバイダーの差分を1回の updateMany で書き込む
//  - フラッシュ時にレコードが消えていたプロバイダーは差分ごと再作成される
const fs = require('fs');
const path = require('path');

const providerUptime = require('../../src/reputation/provider-uptime');
const UptimeRepository = require('../../src/db/json/UptimeRepository');

const UPTIME_PATH = path.resolve(__dirname, '../../data/uptime.json');

function cleanupProviders(prefix) {
  for (const rec of UptimeRepository.getAll()) {
    if (typeof rec.providerId === 'string' && rec.providerId.startsWith(prefix)) {
      UptimeRepository.delete(rec.id);
    }
  }
}

function readRepoBeats(providerId) {
  const rec = UptimeRepository.getByProviderId(providerId);
  return rec ? Number(rec.beats) || 0 : 0;
}

describe('provider-uptime pending+flush batching', () => {
  const PREFIX = `batch-${Date.now()}-`;
  const pid = (n) => `${PREFIX}${n}`;

  beforeEach(() => providerUptime._resetVolatileState());
  afterAll(() => {
    providerUptime._resetVolatileState();
    cleanupProviders(PREFIX);
  });

  test('first heartbeat persists a record synchronously', () => {
    const p = pid('a');
    providerUptime.recordProviderHeartbeat(p, 'order-a1');
    const rec = UptimeRepository.getByProviderId(p);
    expect(rec).toBeTruthy();
    expect(rec.beats).toBe(1);
    expect(rec.sessions).toBe(1);
  });

  test('subsequent beats are visible via getReliability before any flush', () => {
    const p = pid('b');
    providerUptime.recordProviderHeartbeat(p, 'order-b1', 1000);
    providerUptime.recordProviderHeartbeat(p, 'order-b1', 2000);
    providerUptime.recordProviderHeartbeat(p, 'order-b1', 3000);
    // ディスク上はまだ初回ビートの 1 のみ
    expect(readRepoBeats(p)).toBe(1);
    // 読み取り側は pending を上乗せするため 3 が見える
    expect(providerUptime.getReliability(p).beats).toBe(3);
  });

  test('flush merges pending deltas for multiple providers in one pass', () => {
    const p1 = pid('c1');
    const p2 = pid('c2');
    providerUptime.recordProviderHeartbeat(p1, 'order-c1', 1000);
    providerUptime.recordProviderHeartbeat(p2, 'order-c2', 1000);
    providerUptime.recordProviderHeartbeat(p1, 'order-c1', 2000);
    providerUptime.recordProviderHeartbeat(p1, 'order-c1', 3000);
    providerUptime.recordProviderHeartbeat(p2, 'order-c2', 4000);

    providerUptime._flushPending(5000);

    const r1 = UptimeRepository.getByProviderId(p1);
    const r2 = UptimeRepository.getByProviderId(p2);
    expect(r1.beats).toBe(3);
    expect(r1.sessions).toBe(1);
    expect(r2.beats).toBe(2);
    // フラッシュ後は pending も空なので読み取り値と一致する
    expect(providerUptime.getReliability(p1).beats).toBe(3);
  });

  test('flush does not double-apply deltas when called twice', () => {
    const p = pid('d');
    providerUptime.recordProviderHeartbeat(p, 'order-d1', 1000);
    providerUptime.recordProviderHeartbeat(p, 'order-d1', 2000);
    providerUptime._flushPending(3000);
    providerUptime._flushPending(4000); // pending 空 → no-op
    expect(readRepoBeats(p)).toBe(2);
  });

  test('gap events accumulate through pending and flush', () => {
    const p = pid('e');
    const gap = providerUptime.GAP_THRESHOLD_MS + 1000;
    providerUptime.recordProviderHeartbeat(p, 'order-e1', 0 + 1000);
    providerUptime.recordProviderHeartbeat(p, 'order-e1', 1000 + gap); // gap イベント 1
    providerUptime._flushPending(2000 + gap);
    const rec = UptimeRepository.getByProviderId(p);
    expect(rec.beats).toBe(2);
    expect(rec.gapEvents).toBe(1);
  });

  test('SLA breach on a known provider lands on disk after flush', () => {
    const p = pid('f');
    providerUptime.recordProviderHeartbeat(p, 'order-f1', 1000);
    providerUptime.recordSlaBreach(p, 2000);
    // 読み取りは即時反映
    expect(providerUptime.getReliability(p).breaches).toBe(1);
    // ディスクは flush まで旧値
    expect(UptimeRepository.getByProviderId(p).breaches || 0).toBe(0);
    providerUptime._flushPending(3000);
    expect(UptimeRepository.getByProviderId(p).breaches).toBe(1);
  });

  test('SLA breach on a never-seen provider creates a record synchronously', () => {
    const p = pid('g');
    providerUptime.recordSlaBreach(p, 1000);
    const rec = UptimeRepository.getByProviderId(p);
    expect(rec).toBeTruthy();
    expect(rec.breaches).toBe(1);
  });

  test('record deleted between beats is recreated with pending delta on flush', () => {
    const p = pid('h');
    providerUptime.recordProviderHeartbeat(p, 'order-h1', 1000);
    providerUptime.recordProviderHeartbeat(p, 'order-h1', 2000);
    // 集計中にレコード消失をシミュレート
    const rec = UptimeRepository.getByProviderId(p);
    UptimeRepository.delete(rec.id);
    providerUptime._flushPending(3000);
    const recreated = UptimeRepository.getByProviderId(p);
    expect(recreated).toBeTruthy();
    expect(recreated.beats).toBe(1); // 差分分（2ビート目）のみ。消失分は欠落 = best-effort
  });

  test('new session in pending still counts toward sessions on flush', () => {
    const p = pid('i');
    providerUptime.recordProviderHeartbeat(p, 'order-i1', 1000);
    providerUptime.recordProviderHeartbeat(p, 'order-i2', 2000); // 別オーダー = 新セッション
    providerUptime._flushPending(3000);
    expect(UptimeRepository.getByProviderId(p).sessions).toBe(2);
  });
});
