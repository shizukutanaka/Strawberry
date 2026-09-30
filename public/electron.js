// public/electron.js - Electron デスクトップシェルのメインプロセス
// public/ 配下の SPA をデスクトップアプリとして動かすための最小・ハードニング済み実装。
// 実行: npx electron public/electron.js（または npm run desktop）
// リモートサーバを指す場合: STRAWBERRY_URL=https://your-host npx electron public/electron.js
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

// preload の監査チャネルからのエントリを main 側のロガーへ流す。
// sandboxed preload からは fs/相対 require が使えないため、ログ出力はここで行う。
const { logger } = require('../src/utils/logger');

// リモート API/SPA を読み込む場合の起点 URL。未指定なら同梱の index.html を開く。
// http: は localhost デバッグ用途のみ許可し、それ以外は https に限定する。
const STRAWBERRY_URL = process.env.STRAWBERRY_URL || '';
if (STRAWBERRY_URL) {
  let parsed;
  try {
    parsed = new URL(STRAWBERRY_URL);
  } catch (e) {
    logger.error(`Invalid STRAWBERRY_URL: ${e.message}`);
    process.exitCode = 1;
  }
  const isLocalHttp = parsed && parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed && parsed.protocol !== 'https:' && !isLocalHttp) {
    logger.error(`STRAWBERRY_URL must be https:// (http is allowed only for localhost): ${STRAWBERRY_URL}`);
    process.exitCode = 1;
  }
}
if (process.exitCode) app.exit(1);

// 文字列前方一致だと https://host が https://host.evil.example を許してしまうため origin で比較する。
const ALLOWED_ORIGIN = (() => {
  try { return STRAWBERRY_URL ? new URL(STRAWBERRY_URL).origin : null; } catch (_) { return null; }
})();
const isAllowedUrl = (url) => {
  try {
    const target = new URL(url);
    if (STRAWBERRY_URL) return ALLOWED_ORIGIN !== null && target.origin === ALLOWED_ORIGIN;
    return target.protocol === 'file:';
  } catch (_) {
    return false;
  }
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // renderer に Node API を露出させない。IPC は preload の contextBridge 経由のみ。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // SPA は API サーバへ fetch するだけなのでプラグイン類は不要
      plugins: false,
      devTools: process.env.NODE_ENV !== 'production',
    },
  });

  // window.open / target=_blank はアプリ内で開かず OS のブラウザへ委譲する
  // （任意オリジンのページを権限あるコンテキストで開かないための定型防御）。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // will-navigate を起点 URL 内に制限し、リダイレクト・リンク経由で
  // 任意サイトへ main frame が遷移するのを防ぐ。
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) event.preventDefault();
  });

  if (STRAWBERRY_URL) {
    win.loadURL(STRAWBERRY_URL);
  } else {
    win.loadFile(path.join(__dirname, 'index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  // preload が投げた監査エントリ（API 呼び出し記録）を main の logger に転送。
  // ipcRenderer.send は任意オブジェクトを構造化クローンで送れるため検証は最小限に。
  ipcMain.on('strawberry:audit', (_event, entry) => {
    try {
      if (entry && typeof entry === 'object') {
        logger.info({ type: 'preload-audit', ...entry });
      }
    } catch (_) { /* 監査転送の失敗は UI を止めない */ }
  });

  createWindow();
  // macOS では全ウィンドウが閉じてもプロセスが残る慣習のため Dock クリックで再生成
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
