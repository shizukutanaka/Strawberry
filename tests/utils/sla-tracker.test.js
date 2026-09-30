// sla-tracker の updateSLA / 配線テスト。
// - /health 相当の fetch を mock して up/down 集計を検証
// - 再入ガード: checkAlive 滞留中の2回目呼び出しがカウンタを進めないこと
// - startSLATracker が NODE_ENV=test ではタイマーを張らないこと
const fs = require('fs');
const path = require('path');

const SLA_PATH = path.resolve(__dirname, '../../data/sla.json');
const tracker = require('../../src/utils/sla-tracker');

function readSLA() {
  return JSON.parse(fs.readFileSync(SLA_PATH, 'utf-8'));
}

describe('sla-tracker', () => {
  let savedFile = null;
  let fetchSpy;

  beforeAll(() => {
    savedFile = fs.existsSync(SLA_PATH) ? fs.readFileSync(SLA_PATH, 'utf-8') : null;
    fs.writeFileSync(SLA_PATH, JSON.stringify({ total: 0, up: 0, down: 0, history: [] }));
  });
  afterAll(() => {
    if (savedFile === null) {
      try { fs.unlinkSync(SLA_PATH); } catch (_) {}
    } else {
      fs.writeFileSync(SLA_PATH, savedFile);
    }
  });
  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    fetchSpy = undefined;
    fs.writeFileSync(SLA_PATH, JSON.stringify({ total: 0, up: 0, down: 0, history: [] }));
  });

  it('updateSLA counts a healthy /health as up', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    await tracker.updateSLA();
    const sla = readSLA();
    expect(sla.total).toBe(1);
    expect(sla.up).toBe(1);
    expect(sla.down).toBe(0);
    expect(tracker.getSLAStats().uptimeRate).toBe(1);
  });

  it('updateSLA counts a failed /health as down', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unreachable'));
    await tracker.updateSLA();
    const sla = readSLA();
    expect(sla.total).toBe(1);
    expect(sla.down).toBe(1);
  });

  it('re-entrant updateSLA calls do not double-count while a check is in flight', async () => {
    let resolveFetch;
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      () => new Promise((r) => { resolveFetch = r; })
    );
    const first = tracker.updateSLA();
    const second = tracker.updateSLA(); // checkAlive 滞留中 — ガードで即 return
    await second; // 早期 return を待つ
    resolveFetch({ ok: true });
    await first;
    const sla = readSLA();
    expect(sla.total).toBe(1); // 2回呼んでも1回分しかカウントしない
  });

  it('startSLATracker installs no interval under NODE_ENV=test', () => {
    const spy = jest.spyOn(global, 'setInterval');
    tracker.startSLATracker();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
