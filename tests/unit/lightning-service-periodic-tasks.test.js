// tests/unit/lightning-service-periodic-tasks.test.js
//
// Regression: startPeriodicTasks() は3本の setInterval を生成していたが、
// ハンドルを保持していなかったため (a) shutdown() 後も interval が発火し続け
// 切り離された gRPC へ updateChannels がエラーログを吐き続ける、
// (b) initialize() の再呼出し（service-monitor の restart / 失敗後リトライ）で
// タイマーが重複して積み上がる、(c) unref されておらずテスト/CLI 実行で
// プロセスを終了させられない、の3問題があった。
const { LightningService } = require('../../lightning-service');

function makeService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

describe('LightningService 定期タスク管理', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('startPeriodicTasks は3本の interval を追跡する', () => {
    const svc = makeService();
    svc.startPeriodicTasks();
    try {
      expect(svc._periodicTimers).toHaveLength(3);
      for (const t of svc._periodicTimers) {
        expect(typeof t.hasRef === 'function' ? t.hasRef() : undefined).not.toBe(true);
      }
    } finally {
      svc.stopPeriodicTasks();
    }
  });

  it('タイマーは unref 済み（プロセスを終了させられる）', () => {
    const svc = makeService();
    svc.startPeriodicTasks();
    try {
      // unref 済みなら hasRef() は false を返す
      for (const t of svc._periodicTimers) {
        expect(t.hasRef()).toBe(false);
      }
    } finally {
      svc.stopPeriodicTasks();
    }
  });

  it('startPeriodicTasks の再呼出しでタイマーが重複しない（initialize 再実行経路）', async () => {
    const svc = makeService();
    const clearSpy = jest.spyOn(global, 'clearInterval');
    svc.startPeriodicTasks();
    const first = [...svc._periodicTimers];
    svc.startPeriodicTasks(); // initialize() 再呼出しの経路を直接再現
    try {
      expect(svc._periodicTimers).toHaveLength(3); // 3本積まれて6本にならない
      for (const t of first) {
        expect(clearSpy).toHaveBeenCalledWith(t); // 旧タイマーは解除済み
        expect(svc._periodicTimers).not.toContain(t);
      }
    } finally {
      svc.stopPeriodicTasks();
    }
  });

  it('shutdown() が定期タスクを解除し initialized を false へ戻す', async () => {
    const svc = makeService();
    svc.startPeriodicTasks();
    const timers = [...svc._periodicTimers];
    const clearSpy = jest.spyOn(global, 'clearInterval');
    svc.initialized = true;
    await svc.shutdown();
    expect(svc._periodicTimers).toHaveLength(0);
    expect(svc.initialized).toBe(false);
    for (const t of timers) {
      expect(clearSpy).toHaveBeenCalledWith(t);
    }
  });

  it('initialize()→shutdown()→initialize() の往復でもタイマーが累積しない', async () => {
    const svc = makeService();
    await svc.initialize(); // mock LND で完結（proto 不在フォールバック込み）
    expect(svc._periodicTimers).toHaveLength(3);
    await svc.shutdown();
    await svc.initialize();
    try {
      expect(svc._periodicTimers).toHaveLength(3);
      expect(svc.initialized).toBe(true);
    } finally {
      await svc.shutdown();
    }
  });
});
