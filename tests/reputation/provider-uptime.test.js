// provider-uptime.js — プロバイダー信頼性スコアの単体テスト
// uptime.json は globalSetup でリセット済み。揮発 Map は _resetVolatileState で隔離。
const {
  recordProviderHeartbeat,
  recordSlaBreach,
  getReliability,
  GAP_THRESHOLD_MS,
  MIN_BEATS_FOR_SCORE,
  _resetVolatileState,
} = require('../../src/reputation/provider-uptime');
const UptimeRepository = require('../../src/db/json/UptimeRepository');

const PID = 'provider-test-1';

beforeEach(() => {
  _resetVolatileState();
  for (const row of UptimeRepository.getAll()) UptimeRepository.delete(row.id);
});

describe('recordProviderHeartbeat', () => {
  it('creates a record on first beat and increments beats', () => {
    recordProviderHeartbeat(PID, 'order-1', 1000);
    recordProviderHeartbeat(PID, 'order-1', 2000);
    const rec = UptimeRepository.getByProviderId(PID);
    expect(rec.beats).toBe(2);
    expect(rec.sessions).toBe(1); // same orderId = one session
  });

  it('counts a gap event when interval exceeds GAP_THRESHOLD_MS', () => {
    recordProviderHeartbeat(PID, 'order-1', 1000);
    recordProviderHeartbeat(PID, 'order-1', 1000 + GAP_THRESHOLD_MS + 1);
    const rec = UptimeRepository.getByProviderId(PID);
    expect(rec.gapEvents).toBe(1);
  });

  it('does not count gap on first beat after process restart', () => {
    recordProviderHeartbeat(PID, 'order-1', 1000);
    _resetVolatileState(); // simulate restart — volatile map cleared
    recordProviderHeartbeat(PID, 'order-1', 1000 + GAP_THRESHOLD_MS * 10);
    const rec = UptimeRepository.getByProviderId(PID);
    // First post-restart beat must not register a false gap…
    expect(rec.gapEvents).toBe(0);
    // …but sessions increments because the order was re-counted.
    expect(rec.sessions).toBe(2);
  });

  it('fails open: never throws on bad input or repo errors', () => {
    expect(() => recordProviderHeartbeat(null, 'o')).not.toThrow();
    expect(() => recordProviderHeartbeat(PID, null)).not.toThrow();
  });
});

describe('recordSlaBreach', () => {
  it('creates a record even with no prior beats', () => {
    recordSlaBreach(PID);
    const rec = UptimeRepository.getByProviderId(PID);
    expect(rec.breaches).toBe(1);
    expect(rec.beats).toBe(0);
  });

  it('increments breaches on existing record', () => {
    recordProviderHeartbeat(PID, 'order-1');
    recordSlaBreach(PID);
    recordSlaBreach(PID);
    expect(UptimeRepository.getByProviderId(PID).breaches).toBe(2);
  });
});

describe('getReliability', () => {
  it('returns unrated for unknown/missing provider', () => {
    expect(getReliability('nobody').tier).toBe('unrated');
    expect(getReliability(null).tier).toBe('unrated');
  });

  it('returns measuring below MIN_BEATS_FOR_SCORE without breaches', () => {
    recordProviderHeartbeat(PID, 'order-1');
    const r = getReliability(PID);
    expect(r.measuring).toBe(true);
    expect(r.score).toBeNull();
    expect(r.tier).toBe('measuring');
  });

  it('breach below min beats still produces a score (no hiding behind "measuring")', () => {
    recordProviderHeartbeat(PID, 'order-1');
    recordSlaBreach(PID);
    const r = getReliability(PID);
    expect(r.measuring).toBe(false);
    expect(r.score).not.toBeNull();
    expect(r.score).toBeLessThan(1);
  });

  it('clean history above min beats scores 1.0 / excellent', () => {
    for (let i = 0; i < MIN_BEATS_FOR_SCORE + 1; i++) {
      recordProviderHeartbeat(PID, 'order-1', 1000 + i * 1000); // 1s apart — no gaps
    }
    const r = getReliability(PID);
    expect(r.score).toBe(1);
    expect(r.tier).toBe('excellent');
  });

  it('disruption and breaches lower the score', () => {
    // MIN_BEATS+1 beats with gaps on every other beat → disruptionRate ≈ 0.5
    let t = 1000;
    const total = MIN_BEATS_FOR_SCORE + 1;
    for (let i = 0; i < total; i++) {
      recordProviderHeartbeat(PID, 'order-1', t);
      t += (i % 2 === 0) ? GAP_THRESHOLD_MS + 1 : 1000;
    }
    const r = getReliability(PID);
    expect(r.score).toBeLessThan(1);
    expect(r.tier).not.toBe('excellent');
  });
});
