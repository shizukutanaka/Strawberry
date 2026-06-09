// サービス死活監視・自動復旧・外部通知のE2Eテスト
// 旧テストは (1) const import を再代入（CJS では不可）、(2) console.warn を spy（logger は
// winston 経由で console.warn を直接呼ばない）、(3) 未 export の monitorServices() を呼ぶ、
// という3点で構造的に動作しなかった。monitorServices/notifyExternalAlert を export し、
// 監査記録は auditLog モジュール参照を jest.spyOn で捕捉する方式に修正。
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

describe('Service Monitor E2E', () => {
  let svc;
  let auditSpy;

  beforeEach(() => {
    svc = new DummyService();
    monitor.setServices({ dummy: svc });
    // 監査記録を捕捉（ファイルI/Oを避ける）
    auditSpy = jest.spyOn(auditLog, 'appendAuditLog').mockImplementation(() => {});
    // 外部通知を捕捉（Slack/Sentry/LINE への実送信を避ける）
    jest.spyOn(monitor, 'notifyExternalAlert').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    monitor.setServices({});
  });

  it('auto-recovers an unhealthy service and records a service_down audit event', async () => {
    svc.healthy = false;
    await monitor.monitorServices();

    expect(svc.initCount).toBe(1); // initialize() で復旧
    const events = auditSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('service_down');
    expect(events).toContain('service_restart');
  });

  it('does nothing when the service is healthy', async () => {
    await monitor.monitorServices();
    expect(svc.initCount).toBe(0);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('records service_restart_failed when initialize throws', async () => {
    svc.healthy = false;
    svc.initialize = async () => { throw new Error('boom'); };
    await monitor.monitorServices();

    const events = auditSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain('service_down');
    expect(events).toContain('service_restart_failed');
  });
});
