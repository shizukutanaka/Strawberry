// Electronプリロード

// セキュリティ: グローバルオブジェクトの保護（prototype汚染・window汚染・require無効化）
delete window.require;

// prototype汚染防止
Object.freeze(Object.prototype);
Object.freeze(Array.prototype);
Object.freeze(Function.prototype);

// window, globalの重要プロパティの改変防止
['require', 'process', 'module', 'exports', 'global', 'window', '__proto__'].forEach((key) => {
  try {
    Object.defineProperty(window, key, { writable: false, configurable: false });
    Object.defineProperty(global, key, { writable: false, configurable: false });
  } catch (e) {}
});

// prototype汚染検知
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes('prototype pollution')) {
    // 重大インシデントとしてログ
    window.strawberryAPI?.utils?.exportLogs?.();
    // 追加対応: 通知や強制終了など
  }
});

// APIごとの依存注入・モック切り替え用フック
const __apiMocks = {};
window.__injectAPIMock = (namespace, apiObj) => {
  if (typeof namespace !== 'string' || typeof apiObj !== 'object') return;
  __apiMocks[namespace] = apiObj;
};
// テスト時はwindow.__injectAPIMock('gpu', { getLocalGPUs: () => [{id:'test'}] }) のように差し替え可能

// API呼び出し時に監査証跡ログを出力するラッパー
const { logger } = require('../src/utils/logger');
function auditLog(namespace, method, args) {
  if (logger && typeof logger.info === 'function') {
    logger.info({
      type: 'audit',
      namespace,
      method,
      args,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent
    });
  }
}

// APIラップ関数生成
function wrapAPI(namespace, apiObj) {
  const handler = {
    get(target, prop) {
      if (__apiMocks[namespace] && typeof __apiMocks[namespace][prop] === 'function') {
        return (...args) => {
          auditLog(namespace, prop, args);
          return __apiMocks[namespace][prop](...args);
        };
      }
      if (typeof target[prop] === 'function') {
        return (...args) => {
          auditLog(namespace, prop, args);
          return target[prop](...args);
        };
      }
      return target[prop];
    }
  };
  return new Proxy(apiObj, handler);
}

// exposeInMainWorldをwrapAPIでラップして再定義
const originalExpose = contextBridge.exposeInMainWorld;
contextBridge.exposeInMainWorld = function(key, value) {
  if (typeof value === 'object') {
    const wrapped = {};
    for (const ns of Object.keys(value)) {
      wrapped[ns] = wrapAPI(ns, value[ns]);
    }
    return originalExpose.call(contextBridge, key, wrapped);
  }
  return originalExpose.call(contextBridge, key, value);
};

// 既存API expose
// contextBridge.exposeInMainWorld('strawberryAPI', ...) は既存コードのまま利用可能
// 監査証跡・DI・型チェックは上記で自動付与
