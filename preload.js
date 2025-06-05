// public/preload.js - Electron Preload Script
const { contextBridge, ipcRenderer, shell } = require('electron');
const path = require('path');

// セキュアなAPI露出
contextBridge.exposeInMainWorld('strawberryAPI', {
    // システム情報
    system: {
        getPlatform: () => process.platform,
        getArch: () => process.arch,
        getVersion: () => process.versions,
        getAppVersion: () => ipcRenderer.invoke('get-app-version'),
        getSystemInfo: () => ipcRenderer.invoke('get-system-info')
    },

    // GPU管理
    gpu: {
        // ローカルGPU
        getLocalGPUs: () => ipcRenderer.invoke('get-local-gpus'),
        refreshGPUs: () => ipcRenderer.invoke('refresh-gpus'),
        getGPUStatus: (gpuId) => ipcRenderer.invoke('get-gpu-status', gpuId),
        runBenchmark: (gpuId) => ipcRenderer.invoke('run-benchmark', gpuId),
        
        // GPU貸出
        startLending: (gpuId, pricing) => ipcRenderer.invoke('start-gpu-lending', gpuId, pricing),
        stopLending: (gpuId) => ipcRenderer.invoke('stop-gpu-lending', gpuId),
        updatePricing: (gpuId, pricing) => ipcRenderer.invoke('update-gpu-pricing', gpuId, pricing),
        getLendingStatus: (gpuId) => ipcRenderer.invoke('get-lending-status', gpuId),
        
        // GPU借用
        getAvailableGPUs: (filters) => ipcRenderer.invoke('get-available-gpus', filters),
        rentGPU: (gpuId, duration) => ipcRenderer.invoke('rent-gpu', gpuId, duration),
        stopRental: (rentalId) => ipcRenderer.invoke('stop-gpu-rental', rentalId),
        getRentalStatus: (rentalId) => ipcRenderer.invoke('get-rental-status', rentalId),
        
        // GPU接続
        connectToGPU: (credentials) => ipcRenderer.invoke('connect-to-gpu', credentials),
        disconnectFromGPU: (sessionId) => ipcRenderer.invoke('disconnect-from-gpu', sessionId),
        executeGPUCommand: (sessionId, command) => ipcRenderer.invoke('execute-gpu-command', sessionId, command)
    },

    // 支払い管理
    payment: {
        // Lightning Network
        createInvoice: (amount, memo) => ipcRenderer.invoke('create-invoice', amount, memo),
        payInvoice: (paymentRequest) => ipcRenderer.invoke('pay-invoice', paymentRequest),
        checkPaymentStatus: (paymentHash) => ipcRenderer.invoke('check-payment-status', paymentHash),
        getPaymentHistory: (options) => ipcRenderer.invoke('get-payment-history', options),
        
        // ウォレット
        getBalance: () => ipcRenderer.invoke('get-wallet-balance'),
        getChannels: () => ipcRenderer.invoke('get-lightning-channels'),
        openChannel: (nodeId, amount) => ipcRenderer.invoke('open-channel', nodeId, amount),
        closeChannel: (channelId) => ipcRenderer.invoke('close-channel', channelId)
    },

    // ネットワーク管理
    network: {
        // P2P
        getPeers: () => ipcRenderer.invoke('get-p2p-peers'),
        connectToPeer: (peerId) => ipcRenderer.invoke('connect-to-peer', peerId),
        disconnectFromPeer: (peerId) => ipcRenderer.invoke('disconnect-from-peer', peerId),
        getNetworkStats: () => ipcRenderer.invoke('get-network-stats'),
        
        // 通信
        sendMessage: (peerId, message) => ipcRenderer.invoke('send-p2p-message', peerId, message),
        broadcastMessage: (message) => ipcRenderer.invoke('broadcast-p2p-message', message)
    },

    // ユーザー管理
    user: {
        // 認証
        login: (credentials) => ipcRenderer.invoke('user-login', credentials),
        logout: () => ipcRenderer.invoke('user-logout'),
        register: (userData) => ipcRenderer.invoke('user-register', userData),
        getCurrentUser: () => ipcRenderer.invoke('get-current-user'),
        updateProfile: (updates) => ipcRenderer.invoke('update-user-profile', updates),
        
        // 設定
        getSettings: () => ipcRenderer.invoke('get-settings'),
        saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
        resetSettings: () => ipcRenderer.invoke('reset-settings')
    },

    // データ管理
    data: {
        // 統計
        getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
        getGPUMetrics: (gpuId, timeRange) => ipcRenderer.invoke('get-gpu-metrics', gpuId, timeRange),
        getRentalStats: (timeRange) => ipcRenderer.invoke('get-rental-stats', timeRange),
        getEarningsReport: (timeRange) => ipcRenderer.invoke('get-earnings-report', timeRange),
        
        // 履歴
        getRentalHistory: (options) => ipcRenderer.invoke('get-rental-history', options),
        getLendingHistory: (options) => ipcRenderer.invoke('get-lending-history', options),
        getTransactionHistory: (options) => ipcRenderer.invoke('get-transaction-history', options),
        
        // エクスポート
        exportData: (type, options) => ipcRenderer.invoke('export-data', type, options),
        importData: (type, data) => ipcRenderer.invoke('import-data', type, data)
    },

    // 通知管理
    notification: {
        show: (title, body, options) => ipcRenderer.invoke('show-notification', title, body, options),
        getNotifications: () => ipcRenderer.invoke('get-notifications'),
        markAsRead: (notificationId) => ipcRenderer.invoke('mark-notification-read', notificationId),
        clearNotifications: () => ipcRenderer.invoke('clear-notifications'),
        
        // 設定
        getNotificationSettings: () => ipcRenderer.invoke('get-notification-settings'),
        updateNotificationSettings: (settings) => ipcRenderer.invoke('update-notification-settings', settings)
    },

    // ファイル操作
    file: {
        // ダイアログ
        showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
        showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
        showMessageBox: (options) => ipcRenderer.invoke('show-message-box', options),
        
        // ファイル操作
        readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
        writeFile: (filePath, data) => ipcRenderer.invoke('write-file', filePath, data),
        deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
        
        // ディレクトリ
        readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
        createDirectory: (dirPath) => ipcRenderer.invoke('create-directory', dirPath),
        
        // パス
        getAppPath: (name) => ipcRenderer.invoke('get-app-path', name),
        resolvePath: (...paths) => path.join(...paths)
    },

    // アプリケーション制御
    app: {
        // ウィンドウ
        minimizeWindow: () => ipcRenderer.send('minimize-window'),
        maximizeWindow: () => ipcRenderer.send('maximize-window'),
        closeWindow: () => ipcRenderer.send('close-window'),
        setAlwaysOnTop: (flag) => ipcRenderer.send('set-always-on-top', flag),
        
        // アプリケーション
        relaunch: () => ipcRenderer.send('relaunch-app'),
        quit: () => ipcRenderer.send('quit-app'),
        checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
        installUpdate: () => ipcRenderer.invoke('install-update'),
        
        // トレイ
        minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
        showFromTray: () => ipcRenderer.send('show-from-tray')
    },

    // 外部リンク
    shell: {
        openExternal: (url) => shell.openExternal(url),
        openPath: (path) => shell.openPath(path),
        showItemInFolder: (path) => shell.showItemInFolder(path),
        beep: () => shell.beep()
    },

    // イベントリスナー
    on: (channel, callback) => {
        // 許可されたチャンネルのみ
        const validChannels = [
            // GPU イベント
            'gpu:status:changed',
            'gpu:temperature:warning',
            'gpu:error',
            'gpu:benchmark:progress',
            'gpu:benchmark:complete',
            
            // レンタルイベント
            'rental:started',
            'rental:stopped',
            'rental:expired',
            'rental:payment:received',
            
            // 貸出イベント
            'lending:started',
            'lending:stopped',
            'lending:rental:request',
            'lending:earnings:updated',
            
            // 支払いイベント
            'payment:received',
            'payment:sent',
            'payment:failed',
            'invoice:created',
            'invoice:paid',
            'invoice:expired',
            
            // ネットワークイベント
            'peer:connected',
            'peer:disconnected',
            'network:status:changed',
            'message:received',
            
            // システムイベント
            'system:idle',
            'power:status:changed',
            'update:available',
            'update:downloaded',
            'update:progress',
            
            // 通知イベント
            'notification:clicked',
            'notification:closed',
            
            // エラーイベント
            'error:occurred',
            'warning:raised'
        ];

        if (validChannels.includes(channel)) {
            // Renderer プロセスで使用するリスナー登録
            const subscription = (event, ...args) => callback(...args);
            ipcRenderer.on(channel, subscription);
            
            // クリーンアップ用の解除関数を返す
            return () => {
                ipcRenderer.removeListener(channel, subscription);
            };
        } else {
            console.error(`Invalid channel: ${channel}`);
            return () => {};
        }
    },

    // 一度だけ実行するイベントリスナー
    once: (channel, callback) => {
        const validChannels = [
            'app:ready',
            'gpu:initialized',
            'network:initialized',
            'payment:initialized'
        ];

        if (validChannels.includes(channel)) {
            ipcRenderer.once(channel, (event, ...args) => callback(...args));
        }
    },

    // イベント削除
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },

    // ユーティリティ
    utils: {
        // 暗号化
        encrypt: (data, password) => ipcRenderer.invoke('encrypt-data', data, password),
        decrypt: (encryptedData, password) => ipcRenderer.invoke('decrypt-data', encryptedData, password),
        hash: (data, algorithm) => ipcRenderer.invoke('hash-data', data, algorithm),
        
        // フォーマット
        formatCurrency: (amount, currency) => ipcRenderer.invoke('format-currency', amount, currency),
        formatDuration: (seconds) => ipcRenderer.invoke('format-duration', seconds),
        formatFileSize: (bytes) => ipcRenderer.invoke('format-file-size', bytes),
        
        // 検証
        validateGPUConfig: (config) => ipcRenderer.invoke('validate-gpu-config', config),
        validatePaymentRequest: (request) => ipcRenderer.invoke('validate-payment-request', request),
        
        // デバッグ
        getDebugInfo: () => ipcRenderer.invoke('get-debug-info'),
        enableDebugMode: (enabled) => ipcRenderer.invoke('enable-debug-mode', enabled),
        exportLogs: () => ipcRenderer.invoke('export-logs')
    }
});

// セキュリティ: グローバルオブジェクトの保護
delete window.require;
delete window.exports;
delete window.module;

// コンテキスト分離の確認
console.log('🍓 Strawberry API initialized in isolated context');

// エラーハンドリング
window.addEventListener('error', (event) => {
    console.error('Renderer process error:', event.error);
    ipcRenderer.send('renderer-error', {
        message: event.error.message,
        stack: event.error.stack,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
    });
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    ipcRenderer.send('renderer-unhandled-rejection', {
        reason: event.reason,
        promise: event.promise
    });
});

// パフォーマンス監視
const performanceObserver = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    entries.forEach((entry) => {
        if (entry.duration > 100) { // 100ms以上の処理を記録
            ipcRenderer.send('performance-metric', {
                name: entry.name,
                duration: entry.duration,
                startTime: entry.startTime,
                entryType: entry.entryType
            });
        }
    });
});

performanceObserver.observe({ entryTypes: ['measure', 'navigation'] });

// メモリ使用量監視
setInterval(() => {
    if (performance.memory) {
        const memoryUsage = {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
        };
        
        // 90%以上使用している場合は警告
        const usage = memoryUsage.usedJSHeapSize / memoryUsage.jsHeapSizeLimit;
        if (usage > 0.9) {
            ipcRenderer.send('memory-warning', memoryUsage);
        }
    }
}, 30000); // 30秒ごと