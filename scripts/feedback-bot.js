// シンプルな現場フィードバック吸い上げBot（CLI/フォーム連携用サンプル）
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../src/db/json/atomicWrite');

// 既定は docs/feedback-log.json。FEEDBACK_LOG_PATH で差し替え可能（テスト・
// 別環境への分離用）。
const FEEDBACK_FILE = process.env.FEEDBACK_LOG_PATH || path.join(__dirname, '../docs/feedback-log.json');

const { sendSlackMessage } = require('./slack-feedback-bot');

const MAX_MESSAGE_LEN = 4000;
const MAX_USER_LEN = 128;

function loadLog() {
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  } catch (e) {
    // 破損ファイルをそのまま append 対象にすると、以降の全投稿が JSON.parse で
    // クラッシュして記録できなくなる。証跡を残しつつ新規に開始する。
    const quarantine = `${FEEDBACK_FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(FEEDBACK_FILE, quarantine);
      console.error(`フィードバックログが破損していたため退避しました: ${quarantine}`);
    } catch (_) {
      console.error('フィードバックログが破損しています（退避失敗、新規開始）');
    }
    return [];
  }
  if (!Array.isArray(parsed)) {
    throw new Error('feedback-log.json is not an array — refusing to overwrite unexpected data');
  }
  return parsed;
}

function submitFeedback({ user, message, timestamp }) {
  // CLI/フォーム連携の入口。型と長さを検査してログ肥大化・非文字列混入を防ぐ。
  if (typeof user !== 'string' || !user.trim() || user.length > MAX_USER_LEN) {
    throw new Error(`user must be a non-empty string <= ${MAX_USER_LEN} chars`);
  }
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_LEN) {
    throw new Error(`message must be a non-empty string <= ${MAX_MESSAGE_LEN} chars`);
  }
  const log = loadLog();
  const entry = { user, message, timestamp: timestamp || new Date().toISOString() };
  log.push(entry);
  // 書き込み途中のクラッシュでログ全体が半壊しないようアトミック write を使う。
  atomicWriteJSON(FEEDBACK_FILE, log);
  // Slack通知
  try {
    sendSlackMessage(`【新規フィードバック】${entry.user}: ${entry.message} (${entry.timestamp})`);
  } catch (e) {
    console.error('Slack通知失敗:', e);
  }
  console.log('フィードバックを記録しました。');
}

// 使い方例
// node scripts/feedback-bot.js "yourname" "改善案や現場の声をここに記入"
if (require.main === module) {
  const [,, user, ...msg] = process.argv;
  if (!user || msg.length === 0) {
    console.log('使い方: node scripts/feedback-bot.js <ユーザー名> <フィードバック内容>');
    process.exit(1);
  }
  try {
    submitFeedback({ user, message: msg.join(' ') });
  } catch (e) {
    console.error(`フィードバック記録失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { submitFeedback };
