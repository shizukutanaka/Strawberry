// src/core/virtual-gpu-manager.js - Virtual GPU Manager
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const Docker = require('dockerode');
const k8s = require('@kubernetes/client-node');
const { logger } = require('./src/utils/logger');
// child_process には .promises が存在しないため、util.promisify で exec を生成する
// (元コードの `require('child_process').promises` は undefined となり全 exec 呼び出しが壊れていた)
const exec = require('util').promisify(require('child_process').exec);
const fs = require('fs').promises;
const fsSync = require('fs'); // existsSync 等の同期APIは fs.promises に無いため別途参照
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

class VirtualGPUManager extends EventEmitter {
    /**
     * サービス死活判定: 初期化・仮想GPU数・プラットフォームごとの稼働状況を総合判定
     * @returns {Promise<boolean>}
     */
    async isHealthy() {
        // 1. initializedフラグ
        if (!this.initialized) return false;
        // 2. 仮想GPUが1つ以上管理されているか
        if (!this.virtualGPUs || this.virtualGPUs.size === 0) return false;
        // 3. プラットフォームごとの追加チェック（例: Docker/k8sならAPI応答）
        if (this.platform === 'docker') {
            try {
                await this.docker.ping();
            } catch (e) {
                return false;
            }
        }
        if (this.platform === 'kubernetes') {
            try {
                if (!this.k8sApi) return false;
                await this.k8sApi.listPodForAllNamespaces();
            } catch (e) {
                return false;
            }
        }
        return true;
    }

    constructor() {
        super();
        this.docker = new Docker();
        this.k8sApi = null;
        this.virtualGPUs = new Map();
        this.containers = new Map();
        this.allocations = new Map();
        this.platform = this.detectPlatform();
        this.initialized = false;
    }

    detectPlatform() {
        // 実行環境検出
        if (process.env.KUBERNETES_SERVICE_HOST) {
            return 'kubernetes';
        } else if (process.env.DOCKER_HOST || fsSync.existsSync('/var/run/docker.sock')) {
            return 'docker';
        } else {
            return 'native';
        }
    }

    async initialize(physicalGPUs) {
        try {
            logger.info(`Initializing Virtual GPU Manager on ${this.platform} platform...`);
            
            // プラットフォーム別初期化
            switch (this.platform) {
                case 'kubernetes':
                    await this.initializeKubernetes();
                    break;
                case 'docker':
                    await this.initializeDocker();
                    break;
                case 'native':
                    await this.initializeNative();
                    break;
            }
            
            // 物理GPU情報を保存
            this.physicalGPUs = physicalGPUs;
            
            // GPU仮想化機能チェック
            await this.checkVirtualizationSupport();
            
            // 既存の仮想GPU復元
            await this.restoreVirtualGPUs();
            
            this.initialized = true;
            logger.info('✅ Virtual GPU Manager initialized');
            
            this.emit('initialized');
            
        } catch (error) {
            logger.error('Failed to initialize Virtual GPU Manager:', error);
            throw error;
        }
    }

    async initializeKubernetes() {
        try {
            const kc = new k8s.KubeConfig();
            kc.loadFromDefault();
            
            this.k8sApi = kc.makeApiClient(k8s.CoreV1Api);
            this.k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
            
            // GPU Device Plugin確認
            const devicePlugins = await this.k8sApi.listNamespacedPod('kube-system');
            const gpuPlugin = devicePlugins.body.items.find(pod => 
                pod.metadata.name.includes('nvidia-device-plugin')
            );
            
            if (!gpuPlugin) {
                logger.warn('NVIDIA device plugin not found in Kubernetes');
            }
            
            logger.info('Kubernetes API initialized');
            
        } catch (error) {
            logger.error('Failed to initialize Kubernetes:', error);
            throw error;
        }
    }

    async initializeDocker() {
        try {
            // Docker情報取得
            const info = await this.docker.info();
            
            // NVIDIA Dockerランタイム確認
            if (!info.Runtimes || !info.Runtimes.nvidia) {
                logger.warn('NVIDIA Docker runtime not found');
            }
            
            logger.info('Docker initialized:', {
                version: info.ServerVersion,
                runtimes: Object.keys(info.Runtimes || {})
            });
            
        } catch (error) {
            logger.error('Failed to initialize Docker:', error);
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
            docker: false,
            kubernetes: false,
            vgpu: false,
            mig: false,
            srIov: false,
            gpu_passthrough: false
        };
        
        // Docker GPU サポート
        if (this.platform === 'docker') {
            try {
                const containers = await this.docker.listContainers({
                    all: true,
                    filters: { label: ['com.nvidia.volume.version'] }
                });
                support.docker = true;
            } catch {}
        }
        
        // Kubernetes GPU サポート
        if (this.platform === 'kubernetes') {
            try {
                const nodes = await this.k8sApi.listNode();
                support.kubernetes = nodes.body.items.some(node => 
                    node.status.capacity && node.status.capacity['nvidia.com/gpu']
                );
            } catch {}
        }
        
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

    async createVirtualGPU(physicalGPU, config) {
        try {
            const vgpuId = `vgpu-${uuidv4()}`;
            
            logger.info(`Creating virtual GPU ${vgpuId} from ${physicalGPU.id}`);
            
            let vgpu;
            
            // プラットフォーム別の仮想GPU作成
            switch (this.platform) {
                case 'kubernetes':
                    vgpu = await this.createK8sVirtualGPU(physicalGPU, config, vgpuId);
                    break;
                case 'docker':
                    vgpu = await this.createDockerVirtualGPU(physicalGPU, config, vgpuId);
                    break;
                case 'native':
                    vgpu = await this.createNativeVirtualGPU(physicalGPU, config, vgpuId);
                    break;
            }
            
            // 仮想GPU情報
            const virtualGPU = {
                id: vgpuId,
                physicalGPUId: physicalGPU.id,
                name: `${physicalGPU.name} (Virtual)`,
                type: this.determineVGPUType(physicalGPU, config),
                config: config,
                resources: {
                    vram: this.calculateVRAMAllocation(physicalGPU, config),
                    compute: this.calculateComputeAllocation(physicalGPU, config),
                    bandwidth: this.calculateBandwidthAllocation(physicalGPU, config)
                },
                status: 'available',
                createdAt: Date.now(),
                platform: this.platform,
                platformData: vgpu
            };
            
            this.virtualGPUs.set(vgpuId, virtualGPU);
            
            // 永続化
            await this.saveVirtualGPUConfig(virtualGPU);
            
            this.emit('vgpu:created', virtualGPU);
            
            logger.info(`Virtual GPU created: ${vgpuId}`);
            
            return virtualGPU;
            
        } catch (error) {
            logger.error('Failed to create virtual GPU:', error);
            throw error;
        }
    }

    async createK8sVirtualGPU(physicalGPU, config, vgpuId) {
        // Kubernetes Pod として仮想GPU作成
        const podManifest = {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
                name: `strawberry-vgpu-${vgpuId}`,
                namespace: 'strawberry-gpu',
                labels: {
                    app: 'strawberry',
                    component: 'vgpu',
                    vgpuId: vgpuId,
                    physicalGPU: physicalGPU.id
                }
            },
            spec: {
                containers: [{
                    name: 'gpu-worker',
                    image: 'strawberry/gpu-worker:latest',
                    resources: {
                        limits: {
                            'nvidia.com/gpu': this.calculateGPUFraction(physicalGPU, config),
                            memory: `${config.memoryLimit || '8Gi'}`,
                            cpu: `${config.cpuLimit || '4'}`
                        }
                    },
                    env: [
                        { name: 'VGPU_ID', value: vgpuId },
                        { name: 'PHYSICAL_GPU_ID', value: physicalGPU.id },
                        { name: 'CUDA_MPS_ACTIVE_THREAD_PERCENTAGE', value: String(config.computePercentage || 50) }
                    ],
                    volumeMounts: [{
                        name: 'gpu-config',
                        mountPath: '/etc/strawberry/gpu'
                    }]
                }],
                volumes: [{
                    name: 'gpu-config',
                    configMap: {
                        name: `vgpu-config-${vgpuId}`
                    }
                }],
                nodeSelector: {
                    'strawberry.network/gpu-node': 'true',
                    'nvidia.com/gpu.product': physicalGPU.model.series
                }
            }
        };
        
        // ConfigMap 作成
        await this.k8sApi.createNamespacedConfigMap('strawberry-gpu', {
            metadata: {
                name: `vgpu-config-${vgpuId}`
            },
            data: {
                'config.json': JSON.stringify(config),
                'gpu.json': JSON.stringify(physicalGPU)
            }
        });
        
        // Pod 作成
        const pod = await this.k8sApi.createNamespacedPod('strawberry-gpu', podManifest);
        
        return {
            platform: 'kubernetes',
            pod: pod.body.metadata.name,
            namespace: pod.body.metadata.namespace
        };
    }

    async createDockerVirtualGPU(physicalGPU, config, vgpuId) {
        // Docker コンテナとして仮想GPU作成
        const containerConfig = {
            Image: 'strawberry/gpu-worker:latest',
            name: `strawberry-vgpu-${vgpuId}`,
            Env: [
                `VGPU_ID=${vgpuId}`,
                `PHYSICAL_GPU_ID=${physicalGPU.id}`,
                `CUDA_VISIBLE_DEVICES=${this.getGPUIndex(physicalGPU.id)}`,
                `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=${config.computePercentage || 50}`
            ],
            HostConfig: {
                Runtime: 'nvidia',
                Resources: {
                    DeviceRequests: [{
                        Count: -1,
                        Capabilities: [['gpu']],
                        Options: {
                            'nvidia.com/gpu': String(this.getGPUIndex(physicalGPU.id))
                        }
                    }],
                    Memory: config.memoryLimit || 8 * 1024 * 1024 * 1024,
                    CpuShares: (config.cpuLimit || 4) * 1024
                },
                Mounts: [{
                    Type: 'bind',
                    Source: `/var/lib/strawberry/vgpu/${vgpuId}`,
                    Target: '/data'
                }]
            },
            Labels: {
                'strawberry.vgpu': vgpuId,
                'strawberry.physical_gpu': physicalGPU.id,
                'strawberry.gpu_model': physicalGPU.name
            }
        };
        
        // データディレクトリ作成
        await fs.mkdir(`/var/lib/strawberry/vgpu/${vgpuId}`, { recursive: true });
        
        // コンテナ作成・起動
        const container = await this.docker.createContainer(containerConfig);
        await container.start();
        
        this.containers.set(vgpuId, container);
        
        return {
            platform: 'docker',
            containerId: container.id,
            containerName: containerConfig.name
        };
    }

    async createNativeVirtualGPU(physicalGPU, config, vgpuId) {
        // ネイティブ仮想GPU作成
        let vgpu = {};
        
        if (this.migSupported && physicalGPU.model.series === 'A100') {
            // NVIDIA MIG使用
            vgpu = await this.createMIGInstance(physicalGPU, config, vgpuId);
        } else if (this.vgpuSupported) {
            // NVIDIA vGPU使用
            vgpu = await this.createVGPUInstance(physicalGPU, config, vgpuId);
        } else {
            // MPS (Multi-Process Service) 使用
            vgpu = await this.createMPSInstance(physicalGPU, config, vgpuId);
        }
        
        return {
            platform: 'native',
            ...vgpu
        };
    }

    async createMIGInstance(physicalGPU, config, vgpuId) {
        try {
            // MIGプロファイル選択
            const profile = this.selectMIGProfile(physicalGPU, config);
            
            // MIGインスタンス作成
            const { stdout: giId } = await exec(
                `nvidia-smi mig -cgi ${profile} -C -i ${this.getGPUIndex(physicalGPU.id)}`
            );
            
            const migId = giId.match(/GPU instance ID (\d+)/)[1];
            
            return {
                type: 'mig',
                migId: migId,
                profile: profile
            };
            
        } catch (error) {
            logger.error('Failed to create MIG instance:', error);
            throw error;
        }
    }

    async createVGPUInstance(physicalGPU, config, vgpuId) {
        // NVIDIA vGPU作成（要vGPUライセンス）
        try {
            const vgpuType = this.selectVGPUType(physicalGPU, config);
            
            // vGPUインスタンス作成コマンド（実際の実装はハイパーバイザー依存）
            const result = await exec(
                `nvidia-smi vgpu -c ${vgpuType} -i ${this.getGPUIndex(physicalGPU.id)}`
            );
            
            return {
                type: 'vgpu',
                vgpuType: vgpuType
            };
            
        } catch (error) {
            logger.error('Failed to create vGPU instance:', error);
            throw error;
        }
    }

    async createMPSInstance(physicalGPU, config, vgpuId) {
        // CUDA MPS (Multi-Process Service) 設定
        try {
            const mpsDir = `/var/lib/strawberry/mps/${sanitizeId(vgpuId)}`;
            await fs.mkdir(mpsDir, { recursive: true });
            
            // MPSサーバー起動スクリプト作成
            const script = `#!/bin/bash
export CUDA_VISIBLE_DEVICES=${this.getGPUIndex(physicalGPU.id)}
export CUDA_MPS_PIPE_DIRECTORY=${mpsDir}/pipe
export CUDA_MPS_LOG_DIRECTORY=${mpsDir}/log
export CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=${config.computePercentage || 50}

mkdir -p $CUDA_MPS_PIPE_DIRECTORY
mkdir -p $CUDA_MPS_LOG_DIRECTORY

nvidia-cuda-mps-control -d
`;
            
            await fs.writeFile(`${mpsDir}/start-mps.sh`, script, { mode: 0o755 });
            
            // MPSサーバー起動
            await exec(`${mpsDir}/start-mps.sh`);
            
            return {
                type: 'mps',
                mpsDirectory: mpsDir,
                threadPercentage: config.computePercentage || 50
            };
            
        } catch (error) {
            logger.error('Failed to create MPS instance:', error);
            throw error;
        }
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

            // プラットフォーム別のアクセス設定。
            // marketplace GPU（allocateGPU の遅延登録で作られる。他プロバイダのマシン上に
            // 実在し、このノードにはコンテナ/Pod の実体を持たない）は、このノードが
            // docker/k8s を検出していても setupDockerAccess/setupK8sAccess を適用できない
            // （this.containers に実体が無く 'Container not found' で throw する）。CI ランナー
            // には /var/run/docker.sock が存在し platform='docker' と誤検出されるため、
            // これを分岐しないと marketplace GPU の start が常に 500 になる。実体が無い以上
            // 正直な native アクセス（endpoint:null, deliveryImplemented:false）を用いる。
            if (vgpu.type === 'marketplace') {
                allocation.accessInfo = await this.setupNativeAccess(vgpu, allocation);
            } else {
                switch (this.platform) {
                    case 'kubernetes':
                        allocation.accessInfo = await this.setupK8sAccess(vgpu, allocation);
                        break;
                    case 'docker':
                        allocation.accessInfo = await this.setupDockerAccess(vgpu, allocation);
                        break;
                    case 'native':
                        allocation.accessInfo = await this.setupNativeAccess(vgpu, allocation);
                        break;
                }
            }

            this.allocations.set(allocation.id, allocation);
            vgpu.status = 'allocated';
            vgpu.allocationId = allocation.id;

            this.emit('vgpu:allocated', { vgpuId, allocationId: allocation.id });

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

    async getGPUBenchmarkResults(gpuId) {
        // ベンチマーク結果の永続化は未実装。結果なしを正直に返す（ルートは null→404）。
        return null;
    }

    async runGPUBenchmark(gpuId, type) {
        // ベンチマーク実行は未実装。捏造ジョブを返さず明示的に失敗させる。
        throw new Error('GPU benchmarking is not implemented');
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
        
        // プラットフォーム別のリリース処理。
        // 割り当て時（allocateVirtualGPU）と対称に、marketplace GPU は native 解放を用いる
        // （コンテナ/Pod の実体を持たないため docker/k8s 解放は無意味）。
        if (vgpu.type === 'marketplace') {
            await this.releaseNativeAccess(vgpu, allocation);
        } else {
            switch (this.platform) {
                case 'kubernetes':
                    await this.releaseK8sAccess(vgpu, allocation);
                    break;
                case 'docker':
                    await this.releaseDockerAccess(vgpu, allocation);
                    break;
                case 'native':
                    await this.releaseNativeAccess(vgpu, allocation);
                    break;
            }
        }
        
        // 状態更新
        allocation.status = 'released';
        allocation.endTime = Date.now();
        vgpu.status = 'available';
        delete vgpu.allocationId;
        
        this.emit('vgpu:released', { vgpuId: vgpu.id, allocationId });
        
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
        
        // プラットフォーム別の削除処理
        switch (this.platform) {
            case 'kubernetes':
                await this.destroyK8sVirtualGPU(vgpu);
                break;
            case 'docker':
                await this.destroyDockerVirtualGPU(vgpu);
                break;
            case 'native':
                await this.destroyNativeVirtualGPU(vgpu);
                break;
        }
        
        // レコード削除
        this.virtualGPUs.delete(vgpuId);
        await this.deleteVirtualGPUConfig(vgpuId);
        
        this.emit('vgpu:destroyed', vgpuId);
        
        logger.info(`Virtual GPU destroyed: ${vgpuId}`);
    }

    async setupK8sAccess(vgpu, allocation) {
        // Kubernetes Service作成
        const service = await this.k8sApi.createNamespacedService('strawberry-gpu', {
            metadata: {
                name: `vgpu-access-${allocation.id}`,
                labels: {
                    app: 'strawberry',
                    vgpuId: vgpu.id,
                    allocationId: allocation.id
                }
            },
            spec: {
                type: 'LoadBalancer',
                selector: {
                    vgpuId: vgpu.id
                },
                ports: [{
                    name: 'gpu-access',
                    port: 8080,
                    targetPort: 8080
                }]
            }
        });
        
        // Service IP取得待機
        let serviceIP;
        for (let i = 0; i < 30; i++) {
            const svc = await this.k8sApi.readNamespacedService(service.body.metadata.name, 'strawberry-gpu');
            if (svc.body.status.loadBalancer.ingress && svc.body.status.loadBalancer.ingress[0]) {
                serviceIP = svc.body.status.loadBalancer.ingress[0].ip;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        return {
            type: 'kubernetes',
            endpoint: `http://${serviceIP}:8080`,
            credentials: {
                token: this.generateAccessToken()
            }
        };
    }

    async setupDockerAccess(vgpu, allocation) {
        const container = this.containers.get(vgpu.id);
        if (!container) {
            throw new Error('Container not found');
        }
        
        // ポートマッピング取得
        const info = await container.inspect();
        const port = info.NetworkSettings.Ports['8080/tcp'][0].HostPort;
        
        return {
            type: 'docker',
            endpoint: `http://localhost:${port}`,
            credentials: {
                token: this.generateAccessToken()
            }
        };
    }

    async setupNativeAccess(vgpu, allocation) {
        // ネイティブアクセス設定。
        // 旧実装は実在しない `strawberry-gpu-proxy` バイナリを spawn し、誰も listen して
        // いない endpoint URL を「成功」として返していた（renter は支払い後に接続できない
        // 空約束を受け取っていた）。実プロキシ配線は別途のフォローアップ課題とし、ここでは
        // 割り当て自体（課金・スケジューリング・状態遷移）を正しく完了させることを優先する。
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

    async releaseK8sAccess(vgpu, allocation) {
        // Kubernetes Service削除
        try {
            await this.k8sApi.deleteNamespacedService(
                `vgpu-access-${allocation.id}`,
                'strawberry-gpu'
            );
        } catch (error) {
            logger.error('Failed to delete K8s service:', error);
        }
    }

    async releaseDockerAccess(vgpu, allocation) {
        // Docker アクセス解放（特に処理なし）
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

    async destroyK8sVirtualGPU(vgpu) {
        try {
            // Pod削除
            await this.k8sApi.deleteNamespacedPod(
                `strawberry-vgpu-${vgpu.id}`,
                'strawberry-gpu'
            );
            
            // ConfigMap削除
            await this.k8sApi.deleteNamespacedConfigMap(
                `vgpu-config-${vgpu.id}`,
                'strawberry-gpu'
            );
        } catch (error) {
            logger.error('Failed to destroy K8s vGPU:', error);
        }
    }

    async destroyDockerVirtualGPU(vgpu) {
        const container = this.containers.get(vgpu.id);
        if (container) {
            try {
                await container.stop();
                await container.remove();
                this.containers.delete(vgpu.id);
            } catch (error) {
                logger.error('Failed to destroy Docker vGPU:', error);
            }
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

    determineVGPUType(physicalGPU, config) {
        // 仮想GPUタイプ決定
        if (this.migSupported && physicalGPU.model.series === 'A100') {
            return 'mig';
        } else if (this.vgpuSupported) {
            return 'vgpu';
        } else if (this.platform === 'kubernetes' || this.platform === 'docker') {
            return 'container';
        } else {
            return 'mps';
        }
    }

    calculateVRAMAllocation(physicalGPU, config) {
        // VRAM割り当て計算
        const totalVRAM = physicalGPU.vram;
        const percentage = config.vramPercentage || 50;
        
        return Math.floor(totalVRAM * (percentage / 100));
    }

    calculateComputeAllocation(physicalGPU, config) {
        // 計算リソース割り当て計算
        const percentage = config.computePercentage || 50;
        
        return {
            percentage: percentage,
            cudaCores: Math.floor((physicalGPU.cudaCores || 0) * (percentage / 100)),
            tensorCores: Math.floor((physicalGPU.tensorCores || 0) * (percentage / 100))
        };
    }

    calculateBandwidthAllocation(physicalGPU, config) {
        // 帯域幅割り当て計算
        const totalBandwidth = physicalGPU.memoryBandwidth || 0;
        const percentage = config.bandwidthPercentage || 50;
        
        return Math.floor(totalBandwidth * (percentage / 100));
    }

    calculateGPUFraction(physicalGPU, config) {
        // Kubernetes GPU分数計算
        const percentage = config.computePercentage || 50;
        
        if (percentage >= 90) return '1';
        if (percentage >= 40) return '0.5';
        if (percentage >= 20) return '0.25';
        return '0.1';
    }

    selectMIGProfile(physicalGPU, config) {
        // MIGプロファイル選択
        const vramGB = this.calculateVRAMAllocation(physicalGPU, config) / 1024;
        
        if (vramGB >= 40) return '7g.40gb';
        if (vramGB >= 20) return '3g.20gb';
        if (vramGB >= 10) return '2g.10gb';
        return '1g.5gb';
    }

    selectVGPUType(physicalGPU, config) {
        // vGPUタイプ選択
        const vramGB = this.calculateVRAMAllocation(physicalGPU, config) / 1024;
        const modelSeries = physicalGPU.model.series;
        
        // モデル別vGPUプロファイル
        const profiles = {
            'RTX': {
                '48': 'NVIDIA RTX Virtual Workstation-48Q',
                '24': 'NVIDIA RTX Virtual Workstation-24Q',
                '16': 'NVIDIA RTX Virtual Workstation-16Q',
                '8': 'NVIDIA RTX Virtual Workstation-8Q',
                '4': 'NVIDIA RTX Virtual Workstation-4Q'
            },
            'A100': {
                '40': 'NVIDIA A100-40C',
                '20': 'NVIDIA A100-20C',
                '10': 'NVIDIA A100-10C',
                '5': 'NVIDIA A100-5C'
            }
        };
        
        const modelProfiles = profiles[modelSeries] || profiles['RTX'];
        
        for (const [gb, profile] of Object.entries(modelProfiles).reverse()) {
            if (vramGB >= parseInt(gb)) {
                return profile;
            }
        }
        
        return Object.values(modelProfiles).pop();
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

    async saveVirtualGPUConfig(vgpu) {
        // 仮想GPU設定の永続化
        const configPath = `/var/lib/strawberry/vgpu/configs/${vgpu.id}.json`;
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(vgpu, null, 2));
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
        
        // プラットフォーム別の統計取得
        switch (this.platform) {
            case 'kubernetes':
                return await this.getK8sVGPUStats(vgpu);
            case 'docker':
                return await this.getDockerVGPUStats(vgpu);
            case 'native':
                return await this.getNativeVGPUStats(vgpu);
        }
    }

    async getK8sVGPUStats(vgpu) {
        try {
            const metrics = await this.k8sApi.readNamespacedPodMetrics(
                `strawberry-vgpu-${vgpu.id}`,
                'strawberry-gpu'
            );
            
            return {
                cpu: metrics.body.containers[0].usage.cpu,
                memory: metrics.body.containers[0].usage.memory,
                gpu: {
                    utilization: 0, // Prometheusから取得
                    memory: 0,
                    temperature: 0
                }
            };
        } catch (error) {
            logger.error('Failed to get K8s vGPU stats:', error);
            return null;
        }
    }

    async getDockerVGPUStats(vgpu) {
        const container = this.containers.get(vgpu.id);
        if (!container) return null;
        
        try {
            const stats = await container.stats({ stream: false });
            
            return {
                cpu: stats.cpu_stats.cpu_usage.total_usage,
                memory: stats.memory_stats.usage,
                gpu: {
                    utilization: 0, // nvidia-smiから取得
                    memory: 0,
                    temperature: 0
                }
            };
        } catch (error) {
            logger.error('Failed to get Docker vGPU stats:', error);
            return null;
        }
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