// feedback パイプライン（feedback-bot → priority → checklist/sheets/report）の
// 共有読込み経路。各スクリプトが独自に JSON.parse(fs.readFileSync(...)) していたが、
// 破損ログで全段が無情報クラッシュし、message/timestamp の型前提でも落ちていた。
const fs = require('fs');
const path = require('path');

// 既定は docs/feedback-log.json。FEEDBACK_LOG_PATH で差し替え可能（テスト・別環境分離用）。
const DEFAULT_FEEDBACK_FILE = path.join(__dirname, '../../docs/feedback-log.json');

function feedbackFilePath() {
  return process.env.FEEDBACK_LOG_PATH || DEFAULT_FEEDBACK_FILE;
}

// 1 行でも不正なら処理全体を止めるのではなく、フィールドを文字列へ正規化して返す。
// timestamp は ISO 文字列前提でない行（旧版や手編集）も捨てずに透過する。
function normalizeEntry(fb) {
  if (fb === null || typeof fb !== 'object') return null;
  const user = typeof fb.user === 'string' && fb.user.trim() ? fb.user : '(unknown)';
  const message = typeof fb.message === 'string' ? fb.message : String(fb.message ?? '');
  if (!message.trim()) return null; // 内容のない行はどの消費側にも意味を持たない
  const timestamp = typeof fb.timestamp === 'string' && fb.timestamp ? fb.timestamp : new Date(0).toISOString();
  return { ...fb, user, message, timestamp };
}

// ログ未作成なら []。破損 JSON や非配列は「どのファイルが壊れたか」を含む例外にする
// （サイレントに空配列扱いすると、書込み側が上書きで証跡を消し得るため）。
function loadFeedback(filePath = feedbackFilePath()) {
  if (!fs.existsSync(filePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`${filePath} が破損しています: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} は配列ではありません（期待しない構造のため処理を中止）`);
  }
  return parsed.map(normalizeEntry).filter(Boolean);
}

module.exports = { loadFeedback, normalizeEntry, feedbackFilePath, DEFAULT_FEEDBACK_FILE };
