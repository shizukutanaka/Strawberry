// src/gpu/gpu-auto-heal.js — vGPU コンテナの自動修復（improvement_checklist2 項目9）。
//
// virtual-gpu-manager の公開 API のみを使い、プロビジョニング済み vGPU インスタンスの
// 健全性を定期プローブする。getVirtualGPUStats が連続して閾値回数失敗したインスタンスは
// 実体（Pod/コンテナ/プロセス）が死んでいると見なし、release → destroy → 同じ物理GPU上への
// 再作成 → 以前の借り手への再割当（リスケジューリング）を実行する。
//
// 設計上の性質:
// - ユーザーのワークロードを破棄・再作成する攻撃的な動作のため env opt-in:
//   GPU_AUTO_HEAL_INTERVAL_MS を設定しない限り起動しない（BACKUP_INTERVAL_HOURS と同規約）。
// - 修復対象は「既に死んでいる」インスタンスのみ。健全なインスタンスには触れない。
// - destroy は allocated 状態では拒否される（Cannot destroy allocated virtual GPU）ため、
//   先にアクティブ割当を release して status を available に戻す必要がある。
// - 死んだインスタンスでは release のプラットフォーム teardown 自体が失敗し得る。
//   公開 API に強制解放が無いため、release/destroy が失敗したインスタンスは
//   「手動介入が必要」として warn を記録し、その ID を諦める（無限リトライ・ログ洪水を防ぐ）。
// - タイマーは unref 化し、NODE_ENV=test では既定で起動しない（allowInTest で検証可能）。
// - tick の重なり防止・障害カウンタ Map の消失エントリ掃除も備える（常駐ループの定型健全性）。

const { logger } = require('../core/logger');
const { registerDaemon, unregisterDaemon } = require('../utils/daemon-registry');

const DEFAULT_FAILURE_THRESHOLD = 3;

class GpuAutoHealer {
  /**
   * @param {VirtualGPUManager} vgpuManager  監視対象（virtualGPUs/allocations Map + 公開 API）
   * @param {object} gpuRepository           物理GPU参照（getById）。再作成の母体解決に使う。
   * @param {number} intervalMs              プローブ間隔
   * @param {number} failureThreshold        連続失敗で修復に進む閾値
   * @param {boolean} allowInTest            NODE_ENV=test でも起動を許可
   */
  constructor({ vgpuManager, gpuRepository = null, intervalMs, failureThreshold = DEFAULT_FAILURE_THRESHOLD, allowInTest = false } = {}) {
    if (!vgpuManager) throw new Error('gpu-auto-heal: vgpuManager is required');
    this.manager = vgpuManager;
    this.gpuRepository = gpuRepository;
    this.intervalMs = intervalMs;
    this.failureThreshold = failureThreshold;
    this.allowInTest = allowInTest;
    this._timer = null;
    this._ticking = false;
    // vgpuId -> { failures, gaveUp }。成功時・vgpu 消失時に掃除するため増殖しない。
    this._state = new Map();
  }

  start() {
    if (this._timer) return; // 再初期化で多重化しない
    if (!(this.intervalMs > 0)) return;
    if (process.env.NODE_ENV === 'test' && !this.allowInTest) return;
    this._timer = setInterval(() => {
      this.tick().catch((e) => logger.warn(`gpu-auto-heal tick error: ${e.message}`));
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    registerDaemon('gpu-auto-heal', () => this.stop());
    logger.info(`gpu-auto-heal: started (every ${Math.round(this.intervalMs / 1000)}s, threshold ${this.failureThreshold})`);
  }

  stop() {
    unregisterDaemon('gpu-auto-heal');
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async tick() {
    if (this._ticking) return; // 前回 tick が残っている間は重ならない
    this._ticking = true;
    try {
      for (const [vgpuId, vgpu] of this.manager.virtualGPUs) {
        const st = this._state.get(vgpuId);
        if (st && st.gaveUp) continue;
        try {
          await this.manager.getVirtualGPUStats(vgpuId);
          this._state.delete(vgpuId); // 健全 → カウンタ掃除
        } catch (e) {
          const failures = (st ? st.failures : 0) + 1;
          this._state.set(vgpuId, { failures, gaveUp: false });
          if (failures >= this.failureThreshold) {
            await this._heal(vgpuId, vgpu).catch((err) =>
              logger.warn(`gpu-auto-heal: heal ${vgpuId} failed: ${err.message}`));
          }
        }
      }
      // 消失した vgpu のエントリを掃除（増殖防止）
      for (const id of this._state.keys()) {
        if (!this.manager.virtualGPUs.has(id)) this._state.delete(id);
      }
    } finally {
      this._ticking = false;
    }
  }

  // 死んだ vgpu を修復する。成功で再作成 vgpu、不可で null を返す。
  async _heal(vgpuId, vgpu) {
    logger.warn(`gpu-auto-heal: ${vgpuId} unhealthy for ${this.failureThreshold} probes — attempting heal`);

    // 1) アクティブ割当を退避（リスケジューリング用に rentalId を控える）し、
    //    destroy が拒否されないよう status を available へ戻す。死んだ実体では
    //    teardown が失敗し得るため各 release は個別に best-effort。
    const affected = [...this.manager.allocations.values()]
      .filter((a) => a.vgpuId === vgpuId && a.status === 'active');
    for (const a of affected) {
      try {
        await this.manager.releaseVirtualGPU(a.id);
      } catch (e) {
        logger.warn(`gpu-auto-heal: release ${a.id} on ${vgpuId} failed: ${e.message}`);
      }
    }

    // 2) 壊れた実体を破棄。release が失敗して 'allocated' のまま残った場合や
    //    プラットフォーム削除自体が失敗する場合は公開 API では強制できないため
    //    手動介入を促して諦める。
    try {
      await this.manager.destroyVirtualGPU(vgpuId);
    } catch (e) {
      const st = this._state.get(vgpuId);
      if (st) st.gaveUp = true;
      logger.warn(`gpu-auto-heal: cannot destroy ${vgpuId} (${e.message}) — manual intervention required`);
      return null;
    }

    // 3) 同一物理GPUの config で再作成。母体レコードが無ければ再配置不能。
    const physicalGPU = this.gpuRepository
      ? await this.gpuRepository.getById(vgpu.physicalGPUId)
      : null;
    if (!physicalGPU) {
      logger.warn(`gpu-auto-heal: physical GPU ${vgpu.physicalGPUId} not found — ${vgpuId} destroyed, cannot reschedule`);
      this._state.delete(vgpuId);
      return null;
    }
    const recreated = await this.manager.createVirtualGPU(physicalGPU, vgpu.config);

    // 4) 以前の借り手へ再割当（リスケジューリング）。各割当は独立に試す。
    let rescheduled = 0;
    for (const a of affected) {
      try {
        await this.manager.allocateVirtualGPU(recreated.id, a.rentalId);
        rescheduled += 1;
      } catch (e) {
        logger.warn(`gpu-auto-heal: reschedule rental ${a.rentalId} onto ${recreated.id} failed: ${e.message}`);
      }
    }

    logger.info(`gpu-auto-heal: ${vgpuId} healed -> ${recreated.id} (${rescheduled}/${affected.length} allocations rescheduled)`);
    this._state.delete(vgpuId);
    return recreated;
  }
}

// services.js のシングルトンに対して呼ぶ起動ヘルパー。env 未設定なら起動しない（opt-in）。
function startGpuAutoHeal(vgpuManager, { gpuRepository, intervalMs, failureThreshold, allowInTest } = {}) {
  const resolvedInterval = intervalMs !== undefined
    ? intervalMs
    : Number(process.env.GPU_AUTO_HEAL_INTERVAL_MS || 0);
  const healer = new GpuAutoHealer({
    vgpuManager,
    gpuRepository,
    intervalMs: resolvedInterval,
    failureThreshold: failureThreshold !== undefined
      ? failureThreshold
      : Number(process.env.GPU_AUTO_HEAL_FAILURE_THRESHOLD || DEFAULT_FAILURE_THRESHOLD),
    allowInTest,
  });
  healer.start();
  return healer;
}

module.exports = { GpuAutoHealer, startGpuAutoHeal };
