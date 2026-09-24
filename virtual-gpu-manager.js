// src/core/virtual-gpu-manager.js - Virtual GPU Manager
const { v4: uuidv4 } = require('uuid');
// docker/k8s プラットフォームは dockerode/@kubernetes/client-node が依存に存在せず
// 全環境で実行不能のため削除済み。native（nvidia-smi 経由）のみをサポートする。
const { logger } = require('./src/utils/logger');
// child_process には .promises が存在しないため、util.promisify で exec を生成する
// (元コードの `require('child_process').promises` は undefined となり全 exec 呼び出しが壊れていた)
const exec = require('util').promisify(require('child_process').exec);
const fs = require('fs').promises;
const path = require('path');

// シェルコマンドへ埋め込む識別子の検証（コマンドインジェクション防止）。
// 英数字・ハイフン・アンダースコア・ドット・コロンのみ許可。
function sanitizeId(value) {
  const s = String(value);
  if (!/^[A-Za-z0-9_.:-]+$/.test(s)) {
    throw new Error(`Invalid identifier for shell command: ${s}`);
  }
  return s;
}

class VirtualGPUManager {
    /**
     * サービス死活判定: 初期化状態とプラットフォーム API の応答で判定する。
     * 仮想GPUの「在庫数」は死活状態に含めない（0 個は正常な初期状態）。
     * @returns {Promise<boolean>}
     */
    async isHealthy() {
        // 1. initializedフラグ
        if (!this.initialized) return false;
        // 2. プラットフォーム別の追加チェックは不要（native のみ）。
        // 仮想GPUが 0 個なのは「まだ誰にも貸し出していない」という正常な初期状態で
        // あって障害ではないため、ヘルス条件には含めない。service-monitor は
        // unhealthy を見ると initialize() をやり直すため、在庫数を条件に入れると
        // 貸出前のサーバーで監視周期ごとに再起動ループが起きる。在庫数は死活とは無関係。
        return true;
    }

    constructor() {
        this.platform = this.detectPlatform();
        this.virtualGPUs = new Map();
        this.allocations = new Map();
        this.initialized = false;
    }

    detectPlatform() {
        // native（nvidia-smi 経由）のみ対応。docker/k8s プラットフォームは
        // dockerode/@kubernetes/client-node が依存に存在せず実行不能。
        return 'native';
    }

    async initialize(physicalGPUs) {
        try {
            logger.info(`Initializing Virtual GPU Manager on ${this.platform} platform...`);
            
            // プラットフォーム別初期化（native のみ）
            await this.initializeNative();
            
            // 物理GPU情報を保存
            this.physicalGPUs = physicalGPUs;
            
            // GPU仮想化機能チェック
            await this.checkVirtualizationSupport();
            
            // 既存の仮想GPU復元
            await this.restoreVirtualGPUs();
            
            this.initialized = true;
            logger.info('✅ Virtual GPU Manager initialized');
            
            
        } catch (error) {
            logger.error('Failed to initialize Virtual GPU Manager:', error);
            throw error;
        }
    }



    async initializeNative() {
        // ネイティブGPU仮想化の初期化
        logger.info('Using native GPU virtualization');
        
        // NVIDIA vGPU確認
        try {
            const { stdout } = await exec('nvidia-smi vgpu -q');
            if (stdout.includes('vGPU')) {
                this.vgpuSupported = true;
                logger.info('NVIDIA vGPU support detected');
            }
        } catch {
            this.vgpuSupported = false;
        }
        
        // MIG (Multi-Instance GPU) 確認
        try {
            const { stdout } = await exec('nvidia-smi mig -lgip');
            if (!stdout.includes('No MIG')) {
                this.migSupported = true;
                logger.info('NVIDIA MIG support detected');
            }
        } catch {
            this.migSupported = false;
        }
    }

    async checkVirtualizationSupport() {
        const support = {
            vgpu: false,
            mig: false,
            srIov: false,
            gpu_passthrough: false
        };
        
        // NVIDIA vGPU サポート
        support.vgpu = this.vgpuSupported || false;
        
        // NVIDIA MIG サポート
        support.mig = this.migSupported || false;
        
        // SR-IOV サポート
        try {
            const { stdout } = await exec('lspci -d ::0302 -vvv | grep -i "SR-IOV"');
            support.srIov = stdout.length > 0;
        } catch {}
        
        this.virtualizationSupport = support;
        logger.info('GPU virtualization support:', support);
        
        return support;
    }



    async allocateVirtualGPU(vgpuId, rentalId) {
        const vgpu = this.virtualGPUs.get(vgpuId);
        if (!vgpu) {
            throw new Error('Virtual GPU not found');
        }

        if (vgpu.status !== 'available') {
            throw new Error(`Virtual GPU is ${vgpu.status}`);
        }

        // TOCTOU 対策: 最初の await の前に同期的に 'allocating' へ遷移させ、
        // 並行リクエストが同一 GPU を二重確保するのを防ぐ。失敗時は available に戻す。
        vgpu.status = 'allocating';
        try {
            // 割り当て作成
            const allocation = {
                id: `alloc-${uuidv4()}`,
                vgpuId: vgpuId,
                rentalId: rentalId,
                startTime: Date.now(),
                status: 'active',
                accessInfo: await this.generateAccessInfo(vgpu)
            };

            allocation.accessInfo = await this.setupNativeAccess(vgpu, allocation);

            this.allocations.set(allocation.id, allocation);
            vgpu.status = 'allocated';
            vgpu.allocationId = allocation.id;


            return allocation;
        } catch (e) {
            // 確保処理途中で失敗したら利用可能状態へロールバック
            vgpu.status = 'available';
            throw e;
        }
    }

    // ── ルート互換 API（呼び出し規約アダプタ）─────────────────────────────
    // src/api/routes/{gpu,order} は allocateGPU/releaseGPU/getGPU* を呼ぶが、
    // クラス本来の API は allocateVirtualGPU/releaseVirtualGPU/getVirtualGPUStats。
    // 名前・シグネチャの差異により vgpu 有効時は必ず TypeError になっていた。
    // ここで薄いアダプタを提供し、呼び出し側の規約（{success} 返却・gpuId 起点の解放）を吸収する。
    // gpuRecord は呼び出し元（order/index.js の /start）が既に持っている marketplace
    // GPU レコード。省略時（既存呼び出し規約テスト・未知IDの検証等）は遅延登録を行わず、
    // 従来通り未登録 GPU への割り当ては {success:false} で失敗する。
    async allocateGPU(gpuId, rentalId, gpuRecord = null) {
        try {
            if (gpuRecord) {
                this.ensureVirtualGPU(gpuId, gpuRecord);
            }
            const allocation = await this.allocateVirtualGPU(gpuId, rentalId);
            return { success: true, allocationId: allocation.id, ...allocation };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    // marketplace GPU（このノードの物理検出を経ていない GPU — 他プロバイダのマシン上に
    // 実在する可能性がある）用の最小限の仮想GPUエントリを遅延登録する。
    // createVirtualGPU()/createNativeVirtualGPU() は nvidia-smi 等の実ハードウェア操作を
    // 伴うため使えない（そのGPUは本ノード上に物理的に存在しない）。
    // ルート互換アダプタ（allocateGPU/releaseGPU 等）は gpuId をそのまま vgpuId として
    // this.virtualGPUs を検索するため、必ず gpuId をキーとして登録する。
    ensureVirtualGPU(gpuId, gpuRecord) {
        if (this.virtualGPUs.has(gpuId)) return this.virtualGPUs.get(gpuId);
        const virtualGPU = {
            id: gpuId,
            physicalGPUId: gpuId,
            name: gpuRecord.name || 'Marketplace GPU',
            type: 'marketplace',
            config: {},
            resources: {
                vram: typeof gpuRecord.memoryGB === 'number' ? gpuRecord.memoryGB : null,
                compute: null,
                bandwidth: null,
            },
            status: 'available',
            createdAt: Date.now(),
            platform: this.platform,
            platformData: null,
        };
        this.virtualGPUs.set(gpuId, virtualGPU);
        logger.info(`Lazily registered marketplace GPU as virtual GPU: ${gpuId}`);
        return virtualGPU;
    }

    async releaseGPU(gpuId, rentalId) {
        const vgpu = this.virtualGPUs.get(gpuId);
        let allocationId = vgpu && vgpu.allocationId;
        if (!allocationId) {
            // gpuId から特定できなければ rentalId でアクティブな割り当てを逆引き
            for (const [id, a] of this.allocations) {
                if (a.rentalId === rentalId && a.status === 'active') { allocationId = id; break; }
            }
        }
        if (!allocationId) {
            throw new Error('Active allocation not found for GPU');
        }
        return this.releaseVirtualGPU(allocationId);
    }

    async getGPUUsageStats(gpuId) {
        if (!this.virtualGPUs.has(gpuId)) return null;
        return this.getVirtualGPUStats(gpuId);
    }

    async getGPUDetails(gpuId) {
        return this.virtualGPUs.get(gpuId) || null;
    }

    async getGPUAvailability(gpuId) {
        const vgpu = this.virtualGPUs.get(gpuId);
        if (!vgpu) return null;
        return { status: vgpu.status, available: vgpu.status === 'available' };
    }

    async releaseVirtualGPU(allocationId) {
        const allocation = this.allocations.get(allocationId);
        if (!allocation) {
            throw new Error('Allocation not found');
        }
        
        const vgpu = this.virtualGPUs.get(allocation.vgpuId);
        if (!vgpu) {
            throw new Error('Virtual GPU not found');
        }
        
        await this.releaseNativeAccess(vgpu, allocation);
        
        // 状態更新
        allocation.status = 'released';
        allocation.endTime = Date.now();
        vgpu.status = 'available';
        delete vgpu.allocationId;
        // released エントリは active フィルタでも get でも二度と読まれず、永続化
        // もされない（監査複製は order.allocationDetails）— Map から除かないと
        // アロケーションごとにメモリが無制限に成長する。
        this.allocations.delete(allocationId);

        return allocation;
    }

    async destroyVirtualGPU(vgpuId) {
        const vgpu = this.virtualGPUs.get(vgpuId);
        if (!vgpu) {
            throw new Error('Virtual GPU not found');
        }
        
        if (vgpu.status === 'allocated') {
            throw new Error('Cannot destroy allocated virtual GPU');
        }
        
        logger.info(`Destroying virtual GPU ${vgpuId}`);
        
        await this.destroyNativeVirtualGPU(vgpu);
        
        // レコード削除
        this.virtualGPUs.delete(vgpuId);
        // この vGPU の残存アロケーション（released 残骸等）も除去する。
        for (const [id, a] of this.allocations) {
            if (a.vgpuId === vgpuId) this.allocations.delete(id);
        }
        await this.deleteVirtualGPUConfig(vgpuId);
        
        
        logger.info(`Virtual GPU destroyed: ${vgpuId}`);
    }



    async setupNativeAccess(vgpu, allocation) {
        // ネイティブアクセス設定。実プロキシ配線は別途のフォローアップ課題とし、
        // ここでは割り当て自体（課金・スケジューリング・状態遷移）を正しく完了させる
        // ことを優先する。
        // トークンは実際に発行して記録するが、endpoint は null にし
        // deliveryImplemented:false で「まだ配信未実装」であることを明示する。
        const accessToken = this.generateAccessToken();

        return {
            type: 'native',
            endpoint: null,
            credentials: {
                token: accessToken
            },
            deliveryImplemented: false,
            message: 'GPU access delivery is not yet implemented for native allocations. Billing, scheduling, and rental state are fully active.',
        };
    }



    async releaseNativeAccess(vgpu, allocation) {
        // プロキシプロセス終了。setupNativeAccess で記録した allocation.proxyPid を
        // 第一手段とする。pkill -f パターンは「同一 vgpuId の別割当を巻き込む / 再 exec で
        // cmdline が変わり取り逃す」リスクがあり、孤児プロキシとバインドポートをリークさせる。
        const pid = allocation && allocation.proxyPid;
        if (pid) {
            try {
                process.kill(pid, 'SIGTERM');
                return;
            } catch (error) {
                // 既に終了済み(ESRCH)なら成功扱い。それ以外は pkill にフォールバック。
                if (error && error.code === 'ESRCH') return;
                logger.debug(`process.kill(${pid}) failed, falling back to pkill:`, error);
            }
        }
        try {
            await exec(`pkill -f "strawberry-gpu-proxy.*${sanitizeId(vgpu.id)}"`);
        } catch (error) {
            logger.debug('Failed to kill proxy process:', error);
        }
    }



    async destroyNativeVirtualGPU(vgpu) {
        const platformData = vgpu.platformData;
        
        try {
            switch (platformData.type) {
                case 'mig':
                    // MIGインスタンス削除
                    await exec(`nvidia-smi mig -dgi -gi ${sanitizeId(platformData.migId)}`);
                    break;

                case 'vgpu':
                    // vGPUインスタンス削除
                    await exec(`nvidia-smi vgpu -d -v ${sanitizeId(vgpu.id)}`);
                    break;
                    
                case 'mps':
                    // MPSサーバー停止
                    await exec(`echo quit | nvidia-cuda-mps-control`);
                    await fs.rm(platformData.mpsDirectory, { recursive: true, force: true });
                    break;
            }
        } catch (error) {
            logger.error('Failed to destroy native vGPU:', error);
        }
    }


    getGPUIndex(physicalGPUId) {
        // 物理GPU IDからインデックス取得
        const index = Array.from(this.physicalGPUs.keys()).indexOf(physicalGPUId);
        return index >= 0 ? index : 0;
    }

    generateAccessToken() {
        // アクセストークン生成
        return require('crypto').randomBytes(32).toString('base64');
    }

    async generateAccessInfo(vgpu) {
        // アクセス情報生成
        return {
            vgpuId: vgpu.id,
            type: vgpu.type,
            resources: vgpu.resources,
            platform: vgpu.platform
        };
    }

    async deleteVirtualGPUConfig(vgpuId) {
        // 仮想GPU設定の削除
        const configPath = `/var/lib/strawberry/vgpu/configs/${vgpuId}.json`;
        await fs.unlink(configPath).catch(() => {});
    }

    async restoreVirtualGPUs() {
        // 保存された仮想GPU設定の復元
        try {
            const configDir = '/var/lib/strawberry/vgpu/configs';
            const files = await fs.readdir(configDir).catch(() => []);
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const data = await fs.readFile(path.join(configDir, file), 'utf8');
                        const vgpu = JSON.parse(data);
                        this.virtualGPUs.set(vgpu.id, vgpu);
                        logger.info(`Restored virtual GPU: ${vgpu.id}`);
                    } catch (error) {
                        logger.error(`Failed to restore vGPU ${file}:`, error);
                    }
                }
            }
        } catch (error) {
            logger.error('Failed to restore virtual GPUs:', error);
        }
    }

    async getVirtualGPUStats(vgpuId) {
        const vgpu = this.virtualGPUs.get(vgpuId);
        if (!vgpu) {
            throw new Error('Virtual GPU not found');
        }
        
        return await this.getNativeVGPUStats(vgpu);
    }



    async getNativeVGPUStats(vgpu) {
        // ネイティブvGPU統計取得
        try {
            const { stdout } = await exec(
                `nvidia-smi --id=${this.getGPUIndex(vgpu.physicalGPUId)} --query-gpu=utilization.gpu,utilization.memory,temperature.gpu --format=csv,noheader,nounits`
            );

            // 出力形式が想定外（区切り・欠損）だと undefined→NaN が統計へ混入するため検証する。
            const parts = stdout.trim().split(',').map(p => p.trim());
            if (parts.length < 3) {
                throw new Error(`Unexpected nvidia-smi output: "${stdout.trim()}"`);
            }
            const [utilization, memory, temperature] = parts.map(p => parseFloat(p));
            if ([utilization, memory, temperature].some(v => Number.isNaN(v))) {
                throw new Error(`Failed to parse GPU metrics: "${stdout.trim()}"`);
            }

            return { gpu: { utilization, memory, temperature } };
        } catch (error) {
            logger.error('Failed to get native vGPU stats:', error);
            return null;
        }
    }

    async shutdown() {
        logger.info('Shutting down Virtual GPU Manager...');
        
        try {
            // 全アロケーション解放
            for (const [allocationId, allocation] of this.allocations) {
                if (allocation.status === 'active') {
                    await this.releaseVirtualGPU(allocationId);
                }
            }
            
            // 全仮想GPU削除
            for (const vgpuId of this.virtualGPUs.keys()) {
                await this.destroyVirtualGPU(vgpuId);
            }
            
            logger.info('Virtual GPU Manager shutdown complete');
            
        } catch (error) {
            logger.error('Error during Virtual GPU Manager shutdown:', error);
            throw error;
        }
    }
}

module.exports = { VirtualGPUManager };