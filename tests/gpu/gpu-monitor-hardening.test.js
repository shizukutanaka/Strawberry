// src/gpu 監視モジュールの健全性ガード:
// - execSync(nvidia-smi) のタイムアウト（ドライバハングでイベントループ停止しないこと）
// - 同一異常の継続中は通知を抑制（アラート嵐防止）
// - 正常復帰後の再障害は再通知
// - recordGpuError が通知を担うため呼び出し側は二重通知しない（1イベント1通知）
// - 監視タイマーは unref + stop() でプロセス終了を妨げない
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execSync: jest.fn() };
});
jest.mock('../../src/gpu/gpu-error-history', () => ({
  recordGpuError: jest.fn().mockResolvedValue(undefined),
}));

const { execSync } = require('child_process');
const { recordGpuError } = require('../../src/gpu/gpu-error-history');

const health = require('../../src/gpu/gpu-health-monitor');
const { GpuLivenessMonitor } = require('../../src/gpu/gpu-liveness-monitor');

const THRESHOLDS = { temp: 85, fan: 95, mem: 95, retired: 1 };
const UNHEALTHY_CSV = 'GPU-abc, 90, 50, 10, 8192, 4096, 4096, 0, 0\n';
const HEALTHY_CSV = 'GPU-abc, 60, 50, 10, 8192, 4096, 4096, 0, 0\n';

beforeEach(() => {
  execSync.mockReset();
  recordGpuError.mockClear();
  health._lastAlertSignature.clear();
});

describe('gpu-health-monitor hardening', () => {
  it('nvidia-smi execSync にタイムアウトを渡す（イベントループブロック防止）', () => {
    execSync.mockReturnValue(HEALTHY_CSV);
    health._checkGpuHealthTick(THRESHOLDS);
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('nvidia-smi'),
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('同一異常の継続中は重複通知しないが、回復→再障害では再通知する', async () => {
    execSync.mockReturnValue(UNHEALTHY_CSV);
    await health._checkGpuHealthTick(THRESHOLDS);
    await health._checkGpuHealthTick(THRESHOLDS);
    expect(recordGpuError).toHaveBeenCalledTimes(1); // 2 tick で1回のみ

    execSync.mockReturnValue(HEALTHY_CSV);
    await health._checkGpuHealthTick(THRESHOLDS);    // 回復でシグネチャ消去
    execSync.mockReturnValue(UNHEALTHY_CSV);
    await health._checkGpuHealthTick(THRESHOLDS);
    expect(recordGpuError).toHaveBeenCalledTimes(2); // 新規障害として再通知
  });

  it('監視タイマーは unref 済みで stop で解除できる', () => {
    const t = health.monitorGpuHealth(THRESHOLDS, 60_000);
    expect(t.hasRef()).toBe(false); // タイマーがプロセス終了を妨げない
    health.stopGpuHealthMonitor();
  });

  it('evaluateGpuHealth は memTotal=0 で誤検知しない（0 除算ガード）', () => {
    const alerts = health._evaluateGpuHealth(
      { temp: 50, fan: 50, memTotal: 0, memUsed: 0, retiredPending: 0, retiredCount: 0 },
      THRESHOLDS
    );
    expect(alerts).toEqual([]);
  });
});

describe('gpu-liveness-monitor hardening', () => {
  it('死活異常は1イベントにつき recordGpuError 1回（二重通知なし）で監視対象から除去', async () => {
    const mon = new GpuLivenessMonitor();
    mon.registerRental('order-1', 'gpu-1', 'user-1');
    mon.activeRentals.get('order-1').lastHeartbeat = Date.now() - 120_000; // 2分前 = タイムアウト

    await mon.checkLiveness();
    expect(recordGpuError).toHaveBeenCalledTimes(1);
    expect(recordGpuError.mock.calls[0][1]).toContain('order-1');
    expect(mon.activeRentals.has('order-1')).toBe(false);

    await mon.checkLiveness();
    expect(recordGpuError).toHaveBeenCalledTimes(1); // 除去済みなので再通知しない
  });

  it('start() の interval は unref 済みで stop() で解除できる', () => {
    const mon = new GpuLivenessMonitor();
    mon.start(60_000);
    expect(mon.interval.hasRef()).toBe(false);
    mon.stop();
    expect(mon.interval).toBeNull();
  });
});
