// サイズ上限付きの行追記。上限到達時は file.log → file.log.1 へロールオーバー
// して新ファイルを開始する — 追記を止めて監査面を「暗くする」より、直近の
// 証跡を残す方がフォレンジック補助ログでは有効。ディスク使用は最大 2×上限で
// 境界化される。上限は audit-log.js と同じ MAX_AUDIT_LOG_MB（既定 50MB）。
const fs = require('fs');

const MAX_LOG_BYTES = () => (process.env.MAX_AUDIT_LOG_MB
  ? parseInt(process.env.MAX_AUDIT_LOG_MB, 10)
  : 50) * 1024 * 1024;

function appendBoundedLine(filePath, line) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size >= MAX_LOG_BYTES()) {
      try { fs.unlinkSync(filePath + '.1'); } catch (_) { /* 旧ローテーション無し */ }
      fs.renameSync(filePath, filePath + '.1');
    }
  } catch (_) { /* ファイル未作成ならそのまま追記 */ }
  fs.appendFileSync(filePath, line);
}

module.exports = { appendBoundedLine };
