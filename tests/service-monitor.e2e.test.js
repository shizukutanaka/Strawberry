// サービス死活監視・自動復旧・Slack通知のE2Eテスト
const { setServices } = require('../src/core/service-monitor');
const { appendAuditLog } = require('../src/utils/audit-log');

// 疑似サービス
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
  beforeEach(() => {
    svc = new DummyService();
    setServices({ dummy: svc });
  });

  it('should auto-recover unhealthy service and log/audit/notify', async () => {
    svc.healthy = false;
    // auditログ監視用
    let auditMsg = null;
    const origAppend = appendAuditLog;
    global.__notified = false;
    jest.spyOn(global.console, 'warn').mockImplementation((msg) => {
      if (msg.includes('ExternalAlert')) global.__notified = true;
    });
    appendAuditLog = (event, data) => { auditMsg = { event, data }; };
    await require('../src/core/service-monitor').monitorServices();
    expect(svc.initCount).toBe(1);
    expect(auditMsg.event).toBe('service_down');
    expect(global.__notified).toBe(true);
    appendAuditLog = origAppend;
    global.console.warn.mockRestore();
  });
});
