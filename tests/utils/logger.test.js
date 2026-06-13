// ロギングユーティリティの自動テスト（Jest）
const fs = require('fs');
const path = require('path');
const { logger } = require('../../src/utils/logger');

const logDir = path.join(__dirname, '../../logs');
const combinedLog = path.join(logDir, 'combined.log');
const errorLog = path.join(logDir, 'error.log');

// winston の File トランスポートはストリームを開いたまま保持するため、
// テストでファイルを unlink するとログは削除済み inode へ書かれ、パス上のファイルには
// 反映されない（旧テストの flakiness の原因）。代わりに「一意なマーカー」を毎回生成し、
// ファイル末尾に出現するまで短くポーリングする（unlink しない）。
// ファイル末尾のみを読む（最大 1MB）。ログが巨大化しても readFileSync の
// ERR_STRING_TOO_LONG を避けつつ、直近に書いたマーカーを確実に検出できる。
function readTail(file, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function waitForMatch(file, marker, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        if (fs.existsSync(file) && readTail(file).includes(marker)) {
          return resolve(true);
        }
      } catch (_) { /* 書込み途中の読取りは無視 */ }
      if (Date.now() - start > timeoutMs) return reject(new Error(`marker not found in ${path.basename(file)}: ${marker}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('logger', () => {
  it('infoログがcombined.logに出力される', async () => {
    const marker = `info-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logger.info(marker);
    await expect(waitForMatch(combinedLog, marker)).resolves.toBe(true);
  });

  it('errorログがerror.logに出力される', async () => {
    const marker = `error-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logger.error(marker);
    await expect(waitForMatch(errorLog, marker)).resolves.toBe(true);
  });

  it('errorログはcombined.logにも複製される', async () => {
    const marker = `dual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    logger.error(marker);
    await expect(waitForMatch(combinedLog, marker)).resolves.toBe(true);
  });
});
