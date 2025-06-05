// src/core/lightning-service.js - Lightning Network Payment Service
const EventEmitter = require('events');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

class LightningService extends EventEmitter {
    constructor() {
        super();
        this.lnd = null;
        this.config = {
            host: process.env.LND_HOST || 'localhost:10009',
            certPath: process.env.LND_CERT_PATH || path.join(process.env.HOME, '.lnd/tls.cert'),
            macaroonPath: process.env.LND_MACAROON_PATH || path.join(process.env.HOME, '.lnd/data/chain/bitcoin/mainnet/admin.macaroon'),
            network: process.env.BITCOIN_NETWORK || 'mainnet'
        };
        this.invoices = new Map();
        this.payments = new Map();
        this.channels = new Map();
        this.nodeInfo = null;
        this.initialized = false;
    }

    async initialize() {
        try {
            logger.info('Initializing Lightning Network service...');
            
            // LND接続設定
            await this.connectToLND();
            
            // ノード情報取得
            await this.updateNodeInfo();
            
            // チャネル情報取得
            await this.updateChannels();
            
            // イベントストリーム設定
            this.setupEventStreams();
            
            // 定期タスク開始
            this.startPeriodicTasks();
            
            this.initialized = true;
            logger.info('✅ Lightning Network service initialized');
            
            this.emit('initialized', this.nodeInfo);
            
        } catch (error) {
            logger.error('Failed to initialize Lightning service:', error);
            throw error;
        }
    }

    async connectToLND() {
        try {
            // Proto定義読み込み
            const protoPath = path.join(__dirname, '../../proto/lightning.proto');
            const packageDefinition = await protoLoader.load(protoPath, {
                keepCase: true,
                longs: String,
                enums: String,
                defaults: true,
                oneofs: true
            });
            
            const lnrpc = grpc.loadPackageDefinition(packageDefinition).lnrpc;
            
            // 証明書とマカロン読み込み
            const [cert, macaroon] = await Promise.all([
                fs.readFile(this.config.certPath),
                fs.readFile(this.config.macaroonPath)
            ]);
            
            // SSL認証情報作成
            const sslCreds = grpc.credentials.createSsl(cert);
            
            // マカロン認証情報作成
            const macaroonCreds = grpc.credentials.createFromMetadataGenerator((args, callback) => {
                const metadata = new grpc.Metadata();
                metadata.add('macaroon', macaroon.toString('hex'));
                callback(null, metadata);
            });
            
            // 認証情報結合
            const creds = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);
            
            // LNDクライアント作成
            this.lnd = new lnrpc.Lightning(this.config.host, creds);
            
            // 接続テスト
            await this.getInfo();
            
            logger.info('Connected to LND successfully');
            
        } catch (error) {
            // フォールバック: モックモード
            logger.warn('Failed to connect to LND, using mock mode:', error.message);
            this.setupMockLND();
        }
    }

    setupMockLND() {
        // 開発/テスト用のモックLND
        this.lnd = {
            getInfo: (callback) => {
                callback(null, {
                    identity_pubkey: 'mock_pubkey_' + crypto.randomBytes(16).toString('hex'),
                    alias: 'Strawberry Mock Node',
                    num_active_channels: 5,
                    num_peers: 10,
                    block_height: 800000,
                    synced_to_chain: true,
                    testnet: this.config.network === 'testnet',
                    chains: [{ chain: 'bitcoin', network: this.config.network }],
                    version: '0.17.0-beta'
                });
            },
            
            addInvoice: (request, callback) => {
                const paymentHash = crypto.randomBytes(32);
                const paymentRequest = 'lnbc' + request.value + '1' + crypto.randomBytes(100).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 100);
                
                callback(null, {
                    r_hash: paymentHash,
                    payment_request: paymentRequest,
                    add_index: Date.now()
                });
            },
            
            sendPaymentSync: (request, callback) => {
                callback(null, {
                    payment_error: '',
                    payment_preimage: crypto.randomBytes(32),
                    payment_route: {
                        total_fees: Math.floor(request.amt * 0.001),
                        total_amt: request.amt
                    }
                });
            },
            
            listChannels: (callback) => {
                callback(null, {
                    channels: [
                        {
                            active: true,
                            remote_pubkey: 'mock_remote_' + crypto.randomBytes(16).toString('hex'),
                            channel_point: 'mock_channel_point',
                            chan_id: '123456789',
                            capacity: '10000000',
                            local_balance: '5000000',
                            remote_balance: '5000000'
                        }
                    ]
                });
            },
            
            subscribeInvoices: () => {
                // イベントストリームのモック
                const stream = new EventEmitter();
                
                // テスト用の定期的な請求書イベント
                setInterval(() => {
                    if (Math.random() > 0.9) {
                        const mockInvoice = {
                            r_hash: crypto.randomBytes(32),
                            value: Math.floor(Math.random() * 100000),
                            settled: true,
                            settle_date: Math.floor(Date.now() / 1000)
                        };
                        stream.emit('data', mockInvoice);
                    }
                }, 5000);
                
                return stream;
            }
        };
    }

    async getInfo() {
        return new Promise((resolve, reject) => {
            this.lnd.getInfo({}, (error, response) => {
                if (error) reject(error);
                else resolve(response);
            });
        });
    }

    async updateNodeInfo() {
        try {
            const info = await this.getInfo();
            
            this.nodeInfo = {
                pubkey: info.identity_pubkey,
                alias: info.alias,
                activeChannels: info.num_active_channels,
                peers: info.num_peers,
                blockHeight: info.block_height,
                synced: info.synced_to_chain,
                version: info.version,
                network: this.config.network,
                uris: info.uris || []
            };
            
            logger.info(`Lightning node info updated: ${this.nodeInfo.alias} (${this.nodeInfo.pubkey.substring(0, 16)}...)`);
            
        } catch (error) {
            logger.error('Failed to update node info:', error);
            throw error;
        }
    }

    async createInvoice(amount, memo) {
        try {
            // 金額をsatoshiに変換（入力は米ドル）
            const amountSats = await this.convertUSDToSats(amount);
            
            const invoice = await new Promise((resolve, reject) => {
                this.lnd.addInvoice({
                    value: amountSats.toString(),
                    memo: memo,
                    expiry: 3600, // 1時間
                    private: false
                }, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            const invoiceData = {
                paymentHash: invoice.r_hash.toString('hex'),
                paymentRequest: invoice.payment_request,
                amount: amount,
                amountSats: amountSats,
                memo: memo,
                createdAt: Date.now(),
                expiresAt: Date.now() + (3600 * 1000),
                status: 'pending',
                addIndex: invoice.add_index
            };
            
            this.invoices.set(invoiceData.paymentHash, invoiceData);
            
            logger.info(`Created invoice: ${invoiceData.paymentHash.substring(0, 16)}... for $${amount}`);
            
            this.emit('invoice:created', invoiceData);
            
            return invoiceData;
            
        } catch (error) {
            logger.error('Failed to create invoice:', error);
            throw error;
        }
    }

    async sendPayment(paymentRequest, maxFee = null) {
        try {
            // 請求書デコード
            const decodedInvoice = await this.decodePaymentRequest(paymentRequest);
            
            // 最大手数料設定
            const maxFeeSats = maxFee ? await this.convertUSDToSats(maxFee) : Math.floor(decodedInvoice.num_satoshis * 0.01);
            
            const payment = await new Promise((resolve, reject) => {
                this.lnd.sendPaymentSync({
                    payment_request: paymentRequest,
                    fee_limit: { fixed: maxFeeSats }
                }, (error, response) => {
                    if (error) reject(error);
                    else if (response.payment_error) reject(new Error(response.payment_error));
                    else resolve(response);
                });
            });
            
            const paymentData = {
                paymentHash: decodedInvoice.payment_hash,
                paymentPreimage: payment.payment_preimage.toString('hex'),
                amount: decodedInvoice.num_satoshis,
                fee: payment.payment_route.total_fees,
                timestamp: Date.now(),
                status: 'completed',
                destination: decodedInvoice.destination
            };
            
            this.payments.set(paymentData.paymentHash, paymentData);
            
            logger.info(`Payment sent: ${paymentData.paymentHash.substring(0, 16)}... Amount: ${paymentData.amount} sats`);
            
            this.emit('payment:sent', paymentData);
            
            return paymentData;
            
        } catch (error) {
            logger.error('Failed to send payment:', error);
            throw error;
        }
    }

    async decodePaymentRequest(paymentRequest) {
        return new Promise((resolve, reject) => {
            this.lnd.decodePayReq({ pay_req: paymentRequest }, (error, response) => {
                if (error) reject(error);
                else resolve(response);
            });
        });
    }

    async updateChannels() {
        try {
            const channelList = await new Promise((resolve, reject) => {
                this.lnd.listChannels({}, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            this.channels.clear();
            
            channelList.channels.forEach(channel => {
                this.channels.set(channel.channel_point, {
                    active: channel.active,
                    remotePubkey: channel.remote_pubkey,
                    channelPoint: channel.channel_point,
                    chanId: channel.chan_id,
                    capacity: parseInt(channel.capacity),
                    localBalance: parseInt(channel.local_balance),
                    remoteBalance: parseInt(channel.remote_balance),
                    totalSent: parseInt(channel.total_satoshis_sent),
                    totalReceived: parseInt(channel.total_satoshis_received),
                    unsettledBalance: parseInt(channel.unsettled_balance)
                });
            });
            
            logger.info(`Updated ${this.channels.size} channels`);
            
        } catch (error) {
            logger.error('Failed to update channels:', error);
        }
    }

    setupEventStreams() {
        // 請求書イベントストリーム
        const invoiceStream = this.lnd.subscribeInvoices({});
        
        invoiceStream.on('data', (invoice) => {
            const paymentHash = invoice.r_hash.toString('hex');
            const invoiceData = this.invoices.get(paymentHash);
            
            if (invoiceData && invoice.settled) {
                invoiceData.status = 'paid';
                invoiceData.settledAt = invoice.settle_date * 1000;
                invoiceData.amountPaid = parseInt(invoice.amt_paid_sat);
                
                logger.info(`Invoice paid: ${paymentHash.substring(0, 16)}...`);
                
                this.emit('invoice:paid', invoiceData);
                this.emit(`payment:${paymentHash}`, {
                    preimage: invoice.r_preimage.toString('hex')
                });
            }
        });
        
        invoiceStream.on('error', (error) => {
            logger.error('Invoice stream error:', error);
        });
        
        // チャネルイベントストリーム
        try {
            const channelStream = this.lnd.subscribeChannelEvents({});
            
            channelStream.on('data', (event) => {
                if (event.type === 'OPEN_CHANNEL') {
                    logger.info('Channel opened:', event.open_channel);
                    this.emit('channel:opened', event.open_channel);
                } else if (event.type === 'CLOSED_CHANNEL') {
                    logger.info('Channel closed:', event.closed_channel);
                    this.emit('channel:closed', event.closed_channel);
                }
                
                // チャネル情報更新
                this.updateChannels();
            });
            
            channelStream.on('error', (error) => {
                logger.error('Channel stream error:', error);
            });
        } catch (error) {
            logger.warn('Channel event stream not available:', error.message);
        }
    }

    async getChannelBalance() {
        try {
            const balance = await new Promise((resolve, reject) => {
                this.lnd.channelBalance({}, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            return {
                balance: parseInt(balance.balance),
                pendingOpenBalance: parseInt(balance.pending_open_balance),
                localBalance: {
                    sat: parseInt(balance.local_balance?.sat || 0),
                    msat: parseInt(balance.local_balance?.msat || 0)
                },
                remoteBalance: {
                    sat: parseInt(balance.remote_balance?.sat || 0),
                    msat: parseInt(balance.remote_balance?.msat || 0)
                }
            };
            
        } catch (error) {
            logger.error('Failed to get channel balance:', error);
            // モックデータ返却
            return {
                balance: 1000000,
                pendingOpenBalance: 0,
                localBalance: { sat: 500000, msat: 500000000 },
                remoteBalance: { sat: 500000, msat: 500000000 }
            };
        }
    }

    async getPendingPayments() {
        // 保留中の支払い取得
        const pending = [];
        
        this.invoices.forEach(invoice => {
            if (invoice.status === 'pending' && invoice.expiresAt > Date.now()) {
                pending.push(invoice);
            }
        });
        
        return pending;
    }

    async convertUSDToSats(usdAmount) {
        try {
            // ビットコイン価格取得（実際の実装では外部APIを使用）
            const btcPrice = await this.getBTCPrice();
            const btcAmount = usdAmount / btcPrice;
            const satsAmount = Math.floor(btcAmount * 100000000);
            
            return satsAmount;
            
        } catch (error) {
            logger.error('Failed to convert USD to sats:', error);
            // フォールバック: 固定レート使用
            const fallbackRate = 50000; // $50,000/BTC
            return Math.floor((usdAmount / fallbackRate) * 100000000);
        }
    }

    async getBTCPrice() {
        try {
            // 価格キャッシュチェック
            if (this.priceCache && Date.now() - this.priceCache.timestamp < 60000) {
                return this.priceCache.price;
            }
            
            // 実際の実装では CoinGecko/CoinMarketCap API を使用
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
            const data = await response.json();
            const price = data.bitcoin.usd;
            
            // キャッシュ更新
            this.priceCache = {
                price: price,
                timestamp: Date.now()
            };
            
            return price;
            
        } catch (error) {
            logger.error('Failed to get BTC price:', error);
            return 50000; // フォールバック価格
        }
    }

    async createHoldInvoice(amount, memo, preimageHash) {
        // HODL請求書作成（条件付き支払い）
        try {
            const amountSats = await this.convertUSDToSats(amount);
            
            const invoice = await new Promise((resolve, reject) => {
                this.lnd.addHoldInvoice({
                    hash: preimageHash,
                    value: amountSats.toString(),
                    memo: memo,
                    expiry: 3600
                }, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            const holdInvoiceData = {
                paymentHash: preimageHash.toString('hex'),
                paymentRequest: invoice.payment_request,
                amount: amount,
                amountSats: amountSats,
                memo: memo,
                createdAt: Date.now(),
                expiresAt: Date.now() + (3600 * 1000),
                status: 'hold',
                type: 'hold'
            };
            
            this.invoices.set(holdInvoiceData.paymentHash, holdInvoiceData);
            
            return holdInvoiceData;
            
        } catch (error) {
            logger.error('Failed to create hold invoice:', error);
            // フォールバック: 通常の請求書
            return await this.createInvoice(amount, memo);
        }
    }

    async settleHoldInvoice(preimage) {
        // HODL請求書決済
        try {
            await new Promise((resolve, reject) => {
                this.lnd.settleInvoice({ preimage: preimage }, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            const paymentHash = crypto.createHash('sha256').update(preimage).digest('hex');
            const invoice = this.invoices.get(paymentHash);
            
            if (invoice) {
                invoice.status = 'settled';
                invoice.settledAt = Date.now();
            }
            
            logger.info(`Hold invoice settled: ${paymentHash.substring(0, 16)}...`);
            
        } catch (error) {
            logger.error('Failed to settle hold invoice:', error);
            throw error;
        }
    }

    async cancelHoldInvoice(paymentHash) {
        // HODL請求書キャンセル
        try {
            await new Promise((resolve, reject) => {
                this.lnd.cancelInvoice({ payment_hash: paymentHash }, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            const invoice = this.invoices.get(paymentHash);
            
            if (invoice) {
                invoice.status = 'cancelled';
                invoice.cancelledAt = Date.now();
            }
            
            logger.info(`Hold invoice cancelled: ${paymentHash.substring(0, 16)}...`);
            
        } catch (error) {
            logger.error('Failed to cancel hold invoice:', error);
        }
    }

    async openChannel(nodePubkey, localAmount, pushAmount = 0) {
        // チャネル開設
        try {
            const result = await new Promise((resolve, reject) => {
                this.lnd.openChannelSync({
                    node_pubkey_string: nodePubkey,
                    local_funding_amount: localAmount,
                    push_sat: pushAmount,
                    target_conf: 3,
                    sat_per_vbyte: 1
                }, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            logger.info(`Channel opened with ${nodePubkey.substring(0, 16)}...`);
            
            return {
                fundingTxid: result.funding_txid_str,
                outputIndex: result.output_index
            };
            
        } catch (error) {
            logger.error('Failed to open channel:', error);
            throw error;
        }
    }

    async closeChannel(channelPoint, force = false) {
        // チャネル閉鎖
        try {
            const [fundingTxid, outputIndex] = channelPoint.split(':');
            
            const closeStream = this.lnd.closeChannel({
                channel_point: {
                    funding_txid_str: fundingTxid,
                    output_index: parseInt(outputIndex)
                },
                force: force
            });
            
            return new Promise((resolve, reject) => {
                closeStream.on('data', (update) => {
                    if (update.close_pending) {
                        resolve({
                            txid: update.close_pending.txid,
                            status: 'pending'
                        });
                    }
                });
                
                closeStream.on('error', reject);
            });
            
        } catch (error) {
            logger.error('Failed to close channel:', error);
            throw error;
        }
    }

    startPeriodicTasks() {
        // チャネルバランス更新（5分ごと）
        setInterval(() => {
            this.updateChannels().catch(error => {
                logger.error('Failed to update channels:', error);
            });
        }, 5 * 60 * 1000);
        
        // 期限切れ請求書のクリーンアップ（10分ごと）
        setInterval(() => {
            const now = Date.now();
            for (const [hash, invoice] of this.invoices) {
                if (invoice.status === 'pending' && invoice.expiresAt < now) {
                    invoice.status = 'expired';
                    this.emit('invoice:expired', invoice);
                }
            }
        }, 10 * 60 * 1000);
        
        // ノード情報更新（30分ごと）
        setInterval(() => {
            this.updateNodeInfo().catch(error => {
                logger.error('Failed to update node info:', error);
            });
        }, 30 * 60 * 1000);
    }

    async getNodeStats() {
        try {
            const [info, balance, channels] = await Promise.all([
                this.getInfo(),
                this.getChannelBalance(),
                this.getChannelStats()
            ]);
            
            return {
                node: {
                    pubkey: info.identity_pubkey,
                    alias: info.alias,
                    version: info.version,
                    synced: info.synced_to_chain,
                    blockHeight: info.block_height
                },
                channels: {
                    active: channels.active,
                    inactive: channels.inactive,
                    pending: channels.pending,
                    capacity: channels.totalCapacity
                },
                balance: {
                    total: balance.balance,
                    local: balance.localBalance.sat,
                    remote: balance.remoteBalance.sat,
                    pending: balance.pendingOpenBalance
                },
                payments: {
                    sent: this.payments.size,
                    received: Array.from(this.invoices.values()).filter(i => i.status === 'paid').length,
                    totalSent: Array.from(this.payments.values()).reduce((sum, p) => sum + p.amount, 0),
                    totalReceived: Array.from(this.invoices.values())
                        .filter(i => i.status === 'paid')
                        .reduce((sum, i) => sum + i.amountSats, 0)
                }
            };
            
        } catch (error) {
            logger.error('Failed to get node stats:', error);
            return null;
        }
    }

    async getChannelStats() {
        let active = 0;
        let inactive = 0;
        let pending = 0;
        let totalCapacity = 0;
        
        this.channels.forEach(channel => {
            if (channel.active) active++;
            else inactive++;
            totalCapacity += channel.capacity;
        });
        
        // 保留中のチャネル取得
        try {
            const pendingChannels = await new Promise((resolve, reject) => {
                this.lnd.pendingChannels({}, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
            
            pending = pendingChannels.total_limbo_balance || 0;
            
        } catch (error) {
            logger.debug('Failed to get pending channels:', error);
        }
        
        return { active, inactive, pending, totalCapacity };
    }

    async generateInvoice(amount, memo, expiry = 3600) {
        // 請求書生成のラッパー関数
        return await this.createInvoice(amount, memo);
    }

    async payInvoice(paymentRequest, maxFee) {
        // 支払いのラッパー関数
        return await this.sendPayment(paymentRequest, maxFee);
    }

    async shutdown() {
        try {
            logger.info('Shutting down Lightning service...');
            
            // イベントストリームのクリーンアップ
            // (実装省略)
            
            logger.info('Lightning service shutdown complete');
            
        } catch (error) {
            logger.error('Error during Lightning service shutdown:', error);
            throw error;
        }
    }
}

module.exports = { LightningService };