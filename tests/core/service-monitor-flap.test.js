// tests/core/service-monitor-flap.test.js
// 復旧しないサービスがあるときに、監視が通知を撃ち続けないこと。
//
// きっかけ: サーバのログに
//   [Monitor] VirtualGPUManager unhealthy. Attempting restart.
//   [Monitor] VirtualGPUManager restarted successfully.
// が 10 秒ごとに延々と出ていた。原因は 2 つ重なっていた。
//
//  1. VirtualGPUManager.isHealthy() が「割り当て中の仮想 GPU が 0 件なら unhealthy」と
//     判定していた。稼働中のレンタルがゼロはマーケットプレイスの**通常の状態**であって
//     障害ではない。「暇」と「壊れている」を混同していた。
//  2. 監視側は unhealthy を検出するたびに service_down と service_restart を送っていた。
//     バックオフも状態遷移の判定も無いので、復旧しないサービスが 1 つあると
//     10 秒ごとに通知が 2 通ずつ永久に飛ぶ。
//
// 通知が実際には送信されていなかった間（別途修正済み）は誰も気づけなかった。
// 通知が機能するようになった以上、これはチャネルを埋め尽くす。
const monitor = require('../../src/core/service-monitor');
const alerts = require('../../src/utils/external-alerts');

function fakeService(healthySeq) {
  let i = 0;
  return {
    restarts: 0,
    async isHealthy() {
      const v = healthySeq[Math.min(i, healthySeq.length - 1)];
      i += 1;
      return v;
    },
    async initialize() { this.restarts += 1; },
  };
}

let notified;
beforeEach(() => {
  monitor._resetMonitorStateForTest();
  notified = [];
  jest.spyOn(alerts, 'notifyAll').mockImplementation(async (event) => {
    notified.push(event);
    return [];
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  monitor.setServices({});
});

describe('a service that stays down', () => {
  it('alerts once, not on every check', async () => {
    const svc = fakeService([false]);
    monitor.setServices({ Flaky: svc });
    for (let i = 0; i < 5; i++) await monitor.monitorServices();
    expect(notified.filter((e) => e === 'service_down')).toHaveLength(1);
  });

  it('backs off instead of restarting on every tick', async () => {
    // 同じやり方で失敗し続ける再起動を 10 秒ごとに繰り返しても復旧しない。
    const svc = fakeService([false]);
    monitor.setServices({ Flaky: svc });
    for (let i = 0; i < 5; i++) await monitor.monitorServices();
    expect(svc.restarts).toBe(1); // 初回のみ。以降はバックオフ中
  });

  it('gives up restarting after a bounded number of attempts', async () => {
    const svc = fakeService([false]);
    monitor.setServices({ Flaky: svc });
    // バックオフを無効化して試行回数の上限だけを見る
    for (let i = 0; i < 30; i++) {
      const st = monitor._monitorStateForTest('Flaky');
      if (st) st.nextAttemptAt = 0;
      await monitor.monitorServices();
    }
    expect(svc.restarts).toBeLessThanOrEqual(10);
    expect(monitor._monitorStateForTest('Flaky').consecutiveFailures).toBeGreaterThan(10);
  });
});

describe('a healthy service', () => {
  it('produces no alerts at all', async () => {
    monitor.setServices({ Fine: fakeService([true]) });
    for (let i = 0; i < 5; i++) await monitor.monitorServices();
    expect(notified).toEqual([]);
  });

  it('is never restarted', async () => {
    const svc = fakeService([true]);
    monitor.setServices({ Fine: svc });
    for (let i = 0; i < 5; i++) await monitor.monitorServices();
    expect(svc.restarts).toBe(0);
  });
});

describe('recovery', () => {
  it('reports recovery exactly once when the service comes back', async () => {
    const svc = fakeService([false, false, true, true, true]);
    monitor.setServices({ Recovering: svc });
    for (let i = 0; i < 5; i++) await monitor.monitorServices();
    expect(notified.filter((e) => e === 'service_down')).toHaveLength(1);
    expect(notified.filter((e) => e === 'service_recovered')).toHaveLength(1);
  });

  it('re-arms so a second outage alerts again', async () => {
    // 一度復旧したら状態をリセットし、次に落ちたときはまた通知する。
    const svc = fakeService([false, true, false]);
    monitor.setServices({ Bouncy: svc });
    await monitor.monitorServices(); // down
    await monitor.monitorServices(); // recovered
    await monitor.monitorServices(); // down again
    expect(notified.filter((e) => e === 'service_down')).toHaveLength(2);
  });
});

describe('an idle GPU manager is not a broken one', () => {
  it('reports healthy with zero allocated virtual GPUs', async () => {
    // これが無限再起動ループの元になっていた判定。
    const { VirtualGPUManager } = require('../../virtual-gpu-manager');
    const m = new VirtualGPUManager();
    await m.initialize();
    expect(m.virtualGPUs.size).toBe(0);
    expect(await m.isHealthy()).toBe(true);
  });

  it('reports unhealthy before initialization', async () => {
    const { VirtualGPUManager } = require('../../virtual-gpu-manager');
    const m = new VirtualGPUManager();
    expect(await m.isHealthy()).toBe(false);
  });
});
