// service-monitor の外部通知を状態遷移ベース化する回帰テスト。
// 旧実装は不健全な tick ごとに外部通知を発していた（10秒間隔でアラート嵐）。
// 健全→不健全エッジで1回、継続中は RENOTIFY_MS 間隔の再通知のみ、復帰で
// service_recovered 1回、という Nagios/PagerDuty 型の契約を固定する。
const monitor = require('../src/core/service-monitor');
const auditLog = require('../src/utils/audit-log');

class DummyService {
  constructor() {
    this.initialized = true;
    this.healthy = true;
    this.initCount = 0;
  }
  async isHealthy() { return this.healthy; }
  async initialize() { this.initCount++; this.initialized = true; this.healthy = true; }
}

describe('Service Monitor 通知遷移', () => {
  let svc;
  let notifySpy;

  beforeEach(() => {
    svc = new DummyService();
    monitor.setServices({ dummy: svc });
    jest.spyOn(auditLog, 'appendAuditLog').mockImplementation(() => {});
    notifySpy = jest.spyOn(monitor, 'notifyExternalAlert').mockResolvedValue(undefined);
    monitor._resetMonitorStateForTest();
  });

  afterEach(() => {
    monitor.setServices({});
    monitor.stopMonitor();
    jest.restoreAllMocks();
  });

  const notifiedEvents = () => notifySpy.mock.calls.map((c) => c[0]);

  it('連続する不健全 tick では service_down を1回だけ通知する', async () => {
    svc.healthy = false;
    svc.initialize = async () => { svc.initCount++; }; // 復旧しない
    await monitor.monitorServices();
    await monitor.monitorServices();
    await monitor.monitorServices();

    expect(notifiedEvents().filter(e => e === 'service_down')).toHaveLength(1);
    expect(svc.initCount).toBe(3); // restart 試行自体は毎 tick 続く
  });

  it('再起動失敗の通知も継続中はスロットルされる', async () => {
    svc.healthy = false;
    svc.initialize = async () => { throw new Error('boom'); };
    await monitor.monitorServices();
    await monitor.monitorServices();

    expect(notifiedEvents().filter(e => e === 'service_restart_failed')).toHaveLength(1);
  });

  it('復帰で service_recovered を1回送り、再度のダウンで再通知する', async () => {
    svc.healthy = false;
    svc.initialize = async () => { svc.initCount++; };
    await monitor.monitorServices();
    await monitor.monitorServices();

    svc.healthy = true;
    await monitor.monitorServices();
    expect(notifiedEvents().filter(e => e === 'service_recovered')).toHaveLength(1);

    // 健全 tick が続いても recovered は再送されない
    await monitor.monitorServices();
    expect(notifiedEvents().filter(e => e === 'service_recovered')).toHaveLength(1);

    // 新しいダウンは新しい遷移として通知される
    svc.healthy = false;
    await monitor.monitorServices();
    expect(notifiedEvents().filter(e => e === 'service_down')).toHaveLength(2);
  });

  it('再通知間隔 (RENOTIFY_MS) 超過で service_down を再送する', async () => {
    jest.useFakeTimers();
    try {
      svc.healthy = false;
      svc.initialize = async () => { svc.initCount++; };
      await monitor.monitorServices();
      await monitor.monitorServices();
      expect(notifiedEvents().filter(e => e === 'service_down')).toHaveLength(1);

      jest.setSystemTime(Date.now() + monitor.RENOTIFY_MS + 1000);
      await monitor.monitorServices();
      expect(notifiedEvents().filter(e => e === 'service_down')).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('前回 tick 未完了の呼び出しはスキップする（再入防止）', async () => {
    let release;
    svc.isHealthy = jest.fn(() => new Promise((r) => { release = r; }));
    const first = monitor.monitorServices();
    await monitor.monitorServices(); // 前回未完 → 即 return
    expect(svc.isHealthy).toHaveBeenCalledTimes(1);
    release(true);
    await first;
  });

  it('startMonitor の二重起動はタイマーを増やさない', () => {
    const spy = jest.spyOn(global, 'setInterval');
    monitor.startMonitor();
    monitor.startMonitor();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
