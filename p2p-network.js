// src/core/p2p-network.js - P2P Network Module
const EventEmitter = require('events');
const Libp2p = require('libp2p');
const TCP = require('@libp2p/tcp');
const WebSockets = require('@libp2p/websockets');
const Mplex = require('@libp2p/mplex');
const { Noise } = require('@chainsafe/libp2p-noise');
const KadDHT = require('@libp2p/kad-dht');
const Gossipsub = require('@libp2p/gossipsub');
const Bootstrap = require('@libp2p/bootstrap');
const PeerId = require('peer-id');
const { logger } = require('../utils/logger');
const crypto = require('crypto');

class P2PNetwork extends EventEmitter {
    /**
     * サービス死活判定: ノード稼働・ピア接続数・initializedを総合判定
     * @returns {Promise<boolean>}
     */
    async isHealthy() {
        // 1. initializedフラグ
        if (!this.initialized) return false;
        // 2. ノードが存在し、稼働中か
        if (!this.node || typeof this.node.isStarted !== 'function' || !this.node.isStarted()) return false;
        // 3. ピアが1つ以上接続されているか
        try {
            const peers = (typeof this.node.getPeers === 'function') ? await this.node.getPeers() : this.peers;
            if (!peers || (peers.size !== undefined ? peers.size : peers.length) === 0) return false;
        } catch (e) {
            return false;
        }
        return true;
    }

    constructor() {
        super();
        this.node = null;
        this.peers = new Map();
        this.gpuRegistry = new Map();
        this.messageHandlers = new Map();
        this.latencyCache = new Map();
        this.config = {
            bootstrapNodes: [
                '/ip4/bootstrap1.strawberry.network/tcp/4001/p2p/QmBootstrap1...',
                '/ip4/bootstrap2.strawberry.network/tcp/4001/p2p/QmBootstrap2...',
                '/ip6/2001:db8::1/tcp/4001/p2p/QmBootstrap3...'
            ],
            maxPeers: 50,
            announceInterval: 60000, // 1分
            discoveryInterval: 30000, // 30秒
            latencyCacheTimeout: 300000 // 5分
        };
    }

    async start() {
        try {
            logger.info('Starting P2P network...');
            
            // PeerID生成または読み込み
            const peerId = await this.getOrCreatePeerId();
            
            // Libp2pノード作成
            this.node = await Libp2p.create({
                peerId,
                addresses: {
                    listen: [
                        '/ip4/0.0.0.0/tcp/0',
                        '/ip4/0.0.0.0/tcp/0/ws'
                    ]
                },
                modules: {
                    transport: [TCP, WebSockets],
                    streamMuxer: [Mplex],
                    connEncryption: [Noise],
                    dht: KadDHT,
                    pubsub: Gossipsub
                },
                config: {
                    dht: {
                        enabled: true,
                        randomWalk: {
                            enabled: true,
                            interval: 300000 // 5分
                        }
                    },
                    pubsub: {
                        enabled: true,
                        emitSelf: false,
                        signMessages: true,
                        strictSigning: true
                    },
                    peerDiscovery: {
                        bootstrap: {
                            enabled: true,
                            list: this.config.bootstrapNodes
                        }
                    },
                    relay: {
                        enabled: true,
                        hop: {
                            enabled: true,
                            active: true
                        }
                    }
                }
            });
            
            // イベントリスナー設定
            this.setupEventListeners();
            
            // プロトコルハンドラー設定
            this.setupProtocolHandlers();
            
            // ノード起動
            await this.node.start();
            
            const addresses = this.node.multiaddrs.map(ma => ma.toString());
            logger.info('P2P node started with addresses:', addresses);
            
            // 定期タスク開始
            this.startPeriodicTasks();
            
            this.emit('started', { peerId: peerId.toB58String(), addresses });
            
        } catch (error) {
            logger.error('Failed to start P2P network:', error);
            throw error;
        }
    }

    async getOrCreatePeerId() {
        try {
            // 保存されたPeerIDを読み込み
            const fs = require('fs').promises;
            const path = require('path');
            const peerIdPath = path.join(process.cwd(), '.strawberry', 'peer-id.json');
            
            try {
                const peerIdData = await fs.readFile(peerIdPath, 'utf8');
                return await PeerId.createFromJSON(JSON.parse(peerIdData));
            } catch (error) {
                // 新規作成
                const peerId = await PeerId.create({ bits: 2048, keyType: 'RSA' });
                
                // 保存
                await fs.mkdir(path.dirname(peerIdPath), { recursive: true });
                await fs.writeFile(peerIdPath, JSON.stringify(peerId.toJSON()));
                
                return peerId;
            }
        } catch (error) {
            logger.error('Failed to get/create peer ID:', error);
            throw error;
        }
    }

    setupEventListeners() {
        // ピア接続イベント
        this.node.connectionManager.on('peer:connect', (connection) => {
            const peerId = connection.remotePeer.toB58String();
            logger.info(`Connected to peer: ${peerId}`);
            
            this.peers.set(peerId, {
                id: peerId,
                connection: connection,
                connectedAt: Date.now(),
                latency: null,
                gpus: []
            });
            
            this.emit('peer:connected', { peerId });
            
            // GPU情報交換
            this.exchangeGPUInfo(peerId);
        });
        
        // ピア切断イベント
        this.node.connectionManager.on('peer:disconnect', (connection) => {
            const peerId = connection.remotePeer.toB58String();
            logger.info(`Disconnected from peer: ${peerId}`);
            
            // ピアのGPUを削除
            const peer = this.peers.get(peerId);
            if (peer) {
                peer.gpus.forEach(gpuId => {
                    this.gpuRegistry.delete(gpuId);
                    this.emit('gpu:removed', gpuId);
                });
            }
            
            this.peers.delete(peerId);
            this.emit('peer:disconnected', { peerId });
        });
        
        // Pubsubメッセージ
        this.node.pubsub.on('strawberry:gpu:announce', (msg) => {
            this.handleGPUAnnounce(msg);
        });
        
        this.node.pubsub.on('strawberry:gpu:remove', (msg) => {
            this.handleGPURemove(msg);
        });
        
        this.node.pubsub.on('strawberry:network:stats', (msg) => {
            this.handleNetworkStats(msg);
        });
    }

    setupProtocolHandlers() {
        // GPU情報交換プロトコル
        this.node.handle('/strawberry/gpu/1.0.0', async ({ stream }) => {
            try {
                const data = await this.readStream(stream);
                const request = JSON.parse(data.toString());
                
                let response;
                switch (request.type) {
                    case 'list':
                        response = await this.handleGPUListRequest(request);
                        break;
                    case 'details':
                        response = await this.handleGPUDetailsRequest(request);
                        break;
                    case 'access':
                        response = await this.handleGPUAccessRequest(request);
                        break;
                    default:
                        response = { error: 'Unknown request type' };
                }
                
                await this.writeStream(stream, JSON.stringify(response));
                
            } catch (error) {
                logger.error('Error handling GPU protocol:', error);
                await this.writeStream(stream, JSON.stringify({ error: error.message }));
            }
        });
        
        // レイテンシ測定プロトコル
        this.node.handle('/strawberry/ping/1.0.0', async ({ stream }) => {
            try {
                const data = await this.readStream(stream);
                await this.writeStream(stream, data); // エコーバック
            } catch (error) {
                logger.error('Error handling ping:', error);
            }
        });
        
        // セキュアチャネルプロトコル
        this.node.handle('/strawberry/secure/1.0.0', async ({ stream, connection }) => {
            try {
                const data = await this.readStream(stream);
                const request = JSON.parse(data.toString());
                
                if (request.type === 'establish') {
                    const response = await this.establishSecureChannel(
                        connection.remotePeer.toB58String(),
                        request
                    );
                    await this.writeStream(stream, JSON.stringify(response));
                }
            } catch (error) {
                logger.error('Error handling secure protocol:', error);
            }
        });
    }

    async announceGPU(gpuInfo) {
        try {
            // GPU情報を登録
            this.gpuRegistry.set(gpuInfo.id, {
                ...gpuInfo,
                peerId: this.node.peerId.toB58String(),
                announcedAt: Date.now()
            });
            
            // Pubsubでブロードキャスト
            const announcement = {
                type: 'gpu:announce',
                peerId: this.node.peerId.toB58String(),
                gpu: gpuInfo,
                timestamp: Date.now(),
                signature: await this.signMessage(JSON.stringify(gpuInfo))
            };
            
            await this.node.pubsub.publish(
                'strawberry:gpu:announce',
                Buffer.from(JSON.stringify(announcement))
            );
            
            // DHTに登録
            const key = `/strawberry/gpu/${gpuInfo.id}`;
            await this.node.contentRouting.put(
                Buffer.from(key),
                Buffer.from(JSON.stringify(gpuInfo))
            );
            
            logger.info(`Announced GPU: ${gpuInfo.id}`);
            
        } catch (error) {
            logger.error('Failed to announce GPU:', error);
            throw error;
        }
    }

    async removeGPU(gpuId) {
        try {
            this.gpuRegistry.delete(gpuId);
            
            // Pubsubで削除通知
            const removal = {
                type: 'gpu:remove',
                peerId: this.node.peerId.toB58String(),
                gpuId: gpuId,
                timestamp: Date.now()
            };
            
            await this.node.pubsub.publish(
                'strawberry:gpu:remove',
                Buffer.from(JSON.stringify(removal))
            );
            
            // DHTから削除
            const key = `/strawberry/gpu/${gpuId}`;
            await this.node.contentRouting.delete(Buffer.from(key));
            
            logger.info(`Removed GPU: ${gpuId}`);
            
        } catch (error) {
            logger.error('Failed to remove GPU:', error);
            throw error;
        }
    }

    async discoverGPUs(filters = {}) {
        try {
            const allGPUs = [];
            
            // DHTから検索
            const prefix = '/strawberry/gpu/';
            const results = await this.node.contentRouting.findProviders(
                Buffer.from(prefix),
                { timeout: 10000 }
            );
            
            for await (const provider of results) {
                try {
                    const gpuData = await this.requestGPUList(provider.id.toB58String());
                    allGPUs.push(...gpuData);
                } catch (error) {
                    logger.debug(`Failed to get GPU list from ${provider.id}:`, error);
                }
            }
            
            // ローカルレジストリも含める
            this.gpuRegistry.forEach(gpu => {
                if (gpu.peerId !== this.node.peerId.toB58String()) {
                    allGPUs.push(gpu);
                }
            });
            
            // 重複削除
            const uniqueGPUs = Array.from(
                new Map(allGPUs.map(gpu => [gpu.id, gpu])).values()
            );
            
            // フィルタリング
            return uniqueGPUs.filter(gpu => {
                if (filters.minVRAM && gpu.vram < filters.minVRAM) return false;
                if (filters.maxPrice && gpu.pricing?.hourlyRate > filters.maxPrice) return false;
                if (filters.location && gpu.region !== filters.location) return false;
                if (filters.gpuModel && !gpu.name.includes(filters.gpuModel)) return false;
                return true;
            });
            
        } catch (error) {
            logger.error('Failed to discover GPUs:', error);
            return [];
        }
    }

    async requestGPUList(peerId) {
        try {
            const stream = await this.node.dialProtocol(
                peerId,
                '/strawberry/gpu/1.0.0'
            );
            
            await this.writeStream(stream, JSON.stringify({ type: 'list' }));
            const response = await this.readStream(stream);
            
            return JSON.parse(response.toString()).gpus || [];
            
        } catch (error) {
            logger.error(`Failed to request GPU list from ${peerId}:`, error);
            throw error;
        }
    }

    async requestGPUAccess(peerId, accessRequest) {
        try {
            const stream = await this.node.dialProtocol(
                peerId,
                '/strawberry/gpu/1.0.0'
            );
            
            await this.writeStream(stream, JSON.stringify({
                type: 'access',
                ...accessRequest
            }));
            
            const response = await this.readStream(stream);
            const accessInfo = JSON.parse(response.toString());
            
            if (accessInfo.error) {
                throw new Error(accessInfo.error);
            }
            
            // セキュアチャネル確立
            const secureChannel = await this.establishSecureChannel(peerId, {
                gpuId: accessRequest.gpuId,
                sessionId: accessInfo.sessionId
            });
            
            return {
                ...accessInfo,
                secureChannel: secureChannel
            };
            
        } catch (error) {
            logger.error(`Failed to request GPU access from ${peerId}:`, error);
            throw error;
        }
    }

    async releaseGPUAccess(peerId, releaseRequest) {
        try {
            const stream = await this.node.dialProtocol(
                peerId,
                '/strawberry/gpu/1.0.0'
            );
            
            await this.writeStream(stream, JSON.stringify({
                type: 'release',
                ...releaseRequest
            }));
            
            const response = await this.readStream(stream);
            return JSON.parse(response.toString());
            
        } catch (error) {
            logger.error(`Failed to release GPU access from ${peerId}:`, error);
            throw error;
        }
    }

    async measureLatency(peerId) {
        // キャッシュチェック
        const cached = this.latencyCache.get(peerId);
        if (cached && Date.now() - cached.timestamp < this.config.latencyCacheTimeout) {
            return cached.latency;
        }
        
        try {
            const measurements = [];
            
            // 複数回測定して平均を取る
            for (let i = 0; i < 3; i++) {
                const start = Date.now();
                
                const stream = await this.node.dialProtocol(
                    peerId,
                    '/strawberry/ping/1.0.0'
                );
                
                const pingData = crypto.randomBytes(32);
                await this.writeStream(stream, pingData);
                const pongData = await this.readStream(stream);
                
                if (pingData.equals(pongData)) {
                    measurements.push(Date.now() - start);
                }
                
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            const avgLatency = measurements.reduce((a, b) => a + b) / measurements.length;
            
            // キャッシュ更新
            this.latencyCache.set(peerId, {
                latency: avgLatency,
                timestamp: Date.now()
            });
            
            return avgLatency;
            
        } catch (error) {
            logger.error(`Failed to measure latency to ${peerId}:`, error);
            return 999999; // 高いレイテンシ値を返す
        }
    }

    async establishSecureChannel(peerId, params) {
        try {
            // ECDH鍵交換
            const ecdh = crypto.createECDH('secp256k1');
            const publicKey = ecdh.generateKeys();
            
            const stream = await this.node.dialProtocol(
                peerId,
                '/strawberry/secure/1.0.0'
            );
            
            await this.writeStream(stream, JSON.stringify({
                type: 'establish',
                publicKey: publicKey.toString('base64'),
                sessionId: params.sessionId
            }));
            
            const response = await this.readStream(stream);
            const { peerPublicKey, sessionToken } = JSON.parse(response.toString());
            
            // 共有秘密鍵生成
            const sharedSecret = ecdh.computeSecret(
                Buffer.from(peerPublicKey, 'base64')
            );
            
            // セッション鍵導出
            const sessionKey = crypto.pbkdf2Sync(
                sharedSecret,
                sessionToken,
                10000,
                32,
                'sha256'
            );
            
            return {
                sessionId: params.sessionId,
                sessionKey: sessionKey.toString('base64'),
                algorithm: 'aes-256-gcm',
                established: Date.now()
            };
            
        } catch (error) {
            logger.error('Failed to establish secure channel:', error);
            throw error;
        }
    }

    handleGPUAnnounce(msg) {
        try {
            const announcement = JSON.parse(msg.data.toString());
            
            // 署名検証
            if (!this.verifySignature(announcement)) {
                logger.warn('Invalid GPU announcement signature');
                return;
            }
            
            // 自分のアナウンスは無視
            if (announcement.peerId === this.node.peerId.toB58String()) {
                return;
            }
            
            // GPU登録
            this.gpuRegistry.set(announcement.gpu.id, {
                ...announcement.gpu,
                peerId: announcement.peerId,
                announcedAt: announcement.timestamp
            });
            
            // ピア情報更新
            const peer = this.peers.get(announcement.peerId);
            if (peer && !peer.gpus.includes(announcement.gpu.id)) {
                peer.gpus.push(announcement.gpu.id);
            }
            
            this.emit('gpu:announced', announcement.gpu);
            
        } catch (error) {
            logger.error('Error handling GPU announce:', error);
        }
    }

    handleGPURemove(msg) {
        try {
            const removal = JSON.parse(msg.data.toString());
            
            // 自分の削除通知は無視
            if (removal.peerId === this.node.peerId.toB58String()) {
                return;
            }
            
            // GPU削除
            this.gpuRegistry.delete(removal.gpuId);
            
            // ピア情報更新
            const peer = this.peers.get(removal.peerId);
            if (peer) {
                peer.gpus = peer.gpus.filter(id => id !== removal.gpuId);
            }
            
            this.emit('gpu:removed', removal.gpuId);
            
        } catch (error) {
            logger.error('Error handling GPU remove:', error);
        }
    }

    handleNetworkStats(msg) {
        try {
            const stats = JSON.parse(msg.data.toString());
            
            // ネットワーク統計を更新
            this.emit('network:stats', {
                peerId: stats.peerId,
                stats: stats.data
            });
            
        } catch (error) {
            logger.error('Error handling network stats:', error);
        }
    }

    async handleGPUListRequest(request) {
        const localGPUs = Array.from(this.gpuRegistry.values())
            .filter(gpu => gpu.peerId === this.node.peerId.toB58String());
        
        return {
            gpus: localGPUs,
            timestamp: Date.now()
        };
    }

    async handleGPUDetailsRequest(request) {
        const gpu = this.gpuRegistry.get(request.gpuId);
        
        if (!gpu) {
            return { error: 'GPU not found' };
        }
        
        return {
            gpu: gpu,
            timestamp: Date.now()
        };
    }

    async handleGPUAccessRequest(request) {
        // GPU アクセスリクエストの処理
        // この部分はGPU仮想化マネージャーと連携
        
        const gpu = this.gpuRegistry.get(request.gpuId);
        if (!gpu || gpu.peerId !== this.node.peerId.toB58String()) {
            return { error: 'GPU not found or not owned by this peer' };
        }
        
        // アクセス認証
        if (!await this.validatePaymentProof(request.paymentProof)) {
            return { error: 'Invalid payment proof' };
        }
        
        // セッション作成
        const sessionId = crypto.randomBytes(16).toString('hex');
        const accessToken = crypto.randomBytes(32).toString('base64');
        
        return {
            sessionId: sessionId,
            accessToken: accessToken,
            endpoint: `wss://gpu.strawberry.network/${request.gpuId}`,
            credentials: {
                username: `gpu-${request.gpuId}`,
                password: accessToken
            },
            expiresAt: Date.now() + (request.duration * 60 * 60 * 1000)
        };
    }

    async exchangeGPUInfo(peerId) {
        try {
            // 自分のGPU情報を送信
            const localGPUs = Array.from(this.gpuRegistry.values())
                .filter(gpu => gpu.peerId === this.node.peerId.toB58String());
            
            for (const gpu of localGPUs) {
                await this.announceGPU(gpu);
            }
            
            // 相手のGPU情報を要求
            const peerGPUs = await this.requestGPUList(peerId);
            
            // 登録
            peerGPUs.forEach(gpu => {
                this.gpuRegistry.set(gpu.id, {
                    ...gpu,
                    peerId: peerId
                });
            });
            
            logger.info(`Exchanged GPU info with ${peerId}: ${peerGPUs.length} GPUs`);
            
        } catch (error) {
            logger.error(`Failed to exchange GPU info with ${peerId}:`, error);
        }
    }

    startPeriodicTasks() {
        // GPU再アナウンス
        setInterval(async () => {
            const localGPUs = Array.from(this.gpuRegistry.values())
                .filter(gpu => gpu.peerId === this.node.peerId.toB58String());
            
            for (const gpu of localGPUs) {
                await this.announceGPU(gpu);
            }
        }, this.config.announceInterval);
        
        // ピア発見
        setInterval(async () => {
            try {
                const peers = await this.node.peerRouting.findPeers();
                logger.debug(`Discovered ${peers.length} peers`);
            } catch (error) {
                logger.error('Peer discovery error:', error);
            }
        }, this.config.discoveryInterval);
        
        // ネットワーク統計ブロードキャスト
        setInterval(async () => {
            const stats = {
                peerId: this.node.peerId.toB58String(),
                data: {
                    connectedPeers: this.peers.size,
                    registeredGPUs: Array.from(this.gpuRegistry.values())
                        .filter(gpu => gpu.peerId === this.node.peerId.toB58String()).length,
                    bandwidth: await this.getTotalBandwidth(),
                    uptime: process.uptime()
                },
                timestamp: Date.now()
            };
            
            await this.node.pubsub.publish(
                'strawberry:network:stats',
                Buffer.from(JSON.stringify(stats))
            );
        }, 60000); // 1分ごと
        
        // 古いエントリのクリーンアップ
        setInterval(() => {
            const now = Date.now();
            const timeout = 10 * 60 * 1000; // 10分
            
            // 古いGPUエントリを削除
            for (const [gpuId, gpu] of this.gpuRegistry) {
                if (gpu.peerId !== this.node.peerId.toB58String() && 
                    now - gpu.announcedAt > timeout) {
                    this.gpuRegistry.delete(gpuId);
                    this.emit('gpu:timeout', gpuId);
                }
            }
            
            // 古いレイテンシキャッシュを削除
            for (const [peerId, cache] of this.latencyCache) {
                if (now - cache.timestamp > this.config.latencyCacheTimeout) {
                    this.latencyCache.delete(peerId);
                }
            }
        }, 300000); // 5分ごと
    }

    async signMessage(message) {
        // メッセージ署名
        const msgHash = crypto.createHash('sha256').update(message).digest();
        const signature = await this.node.peerId.privKey.sign(msgHash);
        return signature.toString('base64');
    }

    verifySignature(data) {
        // 署名検証の簡易実装
        // 実際の実装では適切な署名検証が必要
        return true;
    }

    async validatePaymentProof(proof) {
        // Lightning Network支払い証明の検証
        // 実際の実装ではLightningサービスと連携
        return true;
    }

    async readStream(stream) {
        const chunks = [];
        for await (const chunk of stream.source) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    async writeStream(stream, data) {
        await stream.sink([Buffer.from(data)]);
    }

    getConnectedPeers() {
        return Array.from(this.peers.values());
    }

    async getTotalBandwidth() {
        // 帯域幅計測の実装
        const stats = await this.node.metrics.getBandwidth();
        return {
            in: stats.in,
            out: stats.out,
            total: stats.in + stats.out
        };
    }

    async stop() {
        try {
            logger.info('Stopping P2P network...');
            
            // 全GPUの削除通知
            const localGPUs = Array.from(this.gpuRegistry.values())
                .filter(gpu => gpu.peerId === this.node.peerId.toB58String());
            
            for (const gpu of localGPUs) {
                await this.removeGPU(gpu.id);
            }
            
            // ノード停止
            await this.node.stop();
            
            // クリーンアップ
            this.peers.clear();
            this.gpuRegistry.clear();
            this.latencyCache.clear();
            
            logger.info('P2P network stopped');
            
        } catch (error) {
            logger.error('Error stopping P2P network:', error);
            throw error;
        }
    }
}

module.exports = { P2PNetwork };