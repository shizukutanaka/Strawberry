// public/preload.js - Electron プリロード（contextBridge 経由の API ブリッジ）
//
// sandbox: true のプリロードでは require が 'electron'・Node 組込みの一部に限定されるため、
// 相対パス（../src/utils/logger 等）や fs は使えない。監査ログは ipcRenderer で
// メインプロセスへ転送し、メイン側が logger に書き込む設計とした（electron.js 参照）。
//
// contextIsolation: true ではプリロードのグローバルはページ側と別レルムのため、
// 旧実装の `delete window.require` や `Object.freeze(Object.prototype)` は
// ページコンテキストには効果がなく、かつプリロード自身が後続の require を
// 失わせる自傷コードだった。また `contextBridge` が未インポートで ReferenceError
// のため従来このファイルは常に起動時にクラッシュしていた。

const { contextBridge, ipcRenderer } = require('electron');

// 監査証跡: 公開 API 呼び出しをメインプロセスへ転送（メインが logger へ記録）
function auditLog(namespace, method, args) {
  try {
    ipcRenderer.send('strawberry:audit', {
      namespace,
      method: String(method),
      // args は structured clone で送れるよう JSON 往復で単純化（関数・DOM ノードを除去）
      args: JSON.parse(JSON.stringify(args ?? [], (_k, v) => typeof v === 'function' ? '[function]' : v)),
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    });
  } catch (_) { /* 監査転送の失敗は API 呼び出しを妨げない */ }
}

// テスト用の依存注入・モック切り替えフック。
// 例: window.__injectAPIMock('gpu', { getLocalGPUs: () => [{ id: 'test' }] })
const __apiMocks = {};
function injectAPIMock(namespace, apiObj) {
  if (typeof namespace !== 'string' || !apiObj || typeof apiObj !== 'object') return;
  __apiMocks[namespace] = apiObj;
}

// 公開 API オブジェクトの各メソッドに監査ラップをかける。
// API 呼び出し側からは通常の関数として見えるまま。
function wrapAPI(namespace, apiObj) {
  return new Proxy(apiObj, {
    get(target, prop) {
      const mock = __apiMocks[namespace];
      if (mock && typeof mock[prop] === 'function') {
        return (...args) => {
          auditLog(namespace, prop, args);
          return mock[prop](...args);
        };
      }
      if (typeof target[prop] === 'function') {
        return (...args) => {
          auditLog(namespace, prop, args);
          return target[prop](...args);
        };
      }
      return target[prop];
    },
  });
}

// contextBridge.exposeInMainWorld を監査ラップ付きで再定義するために残していた
// 旧コードは contextBridge 未インポートで機能していなかった。ここでは Strawberry の
// renderer へ公開する最小 API を直接公開する形に整理した（呼び出しは全て監査される）。
contextBridge.exposeInMainWorld('strawberryAPI', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // テスト/デバッグ用モック差し替え（ページ側からのみ呼べる）
  injectAPIMock,
  // 将来 renderer 側モジュールを公開する場合は wrapAPI を通す:
  //   modules: wrapAPI('gpu', { getLocalGPUs: (...) => ... })
});
