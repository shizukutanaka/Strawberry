// alert-* スクリプト（期限切れ/高優先度フィードバックの Slack 通知）の共有部品。
// 3本が同じ「feedback-priority.json 読込 → フィルタ → Slack 送信」を
// ガード無しで複製していたため集約。
const fs = require('fs');
const path = require('path');
const { sendSlackMessage } = require('../slack-feedback-bot');

const PRIORITY_FILE = process.env.FEEDBACK_PRIORITY_PATH || path.join(__dirname, '../../docs/feedback-priority.json');

// feedback-priority.json を配列として読む。未作成は []、破損/非配列は
// 「どのファイルが壊れたか」を含む例外（サイレントに空扱いするとアラートが
// 静かに止まるため）。
function loadPriorityFeedback(filePath = PRIORITY_FILE) {
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
  return parsed.filter(fb => fb !== null && typeof fb === 'object');
}

function isOverdue(due) {
  if (!due) return false;
  const dueDate = new Date(due);
  return !Number.isNaN(dueDate.getTime()) && dueDate < new Date();
}

// エントリの期限フィールドはスキーマ化されていないため既知キーを順に参照する。
function dueOf(fb) {
  return fb.due || fb.deadline || fb.期限 || fb.date;
}

function formatEntry(fb) {
  const d = dueOf(fb) || '';
  const user = typeof fb.user === 'string' ? fb.user : (fb.user || '');
  const message = typeof fb.message === 'string' ? fb.message : String(fb.message ?? '');
  const ts = typeof fb.timestamp === 'string' ? fb.timestamp : '';
  const head = [d, ts].filter(Boolean).join(' ');
  return `- ${head} ${user}: ${message}`.replace(/\s+/g, ' ').trim();
}

// Slack は長文を分割して送る。通知失敗は呼び出し側でキャッチする。
function sendAlert(title, entries) {
  const lines = entries.map(formatEntry);
  let msg = `${title}が${entries.length}件あります\n`;
  const chunks = [];
  let cur = msg;
  for (const line of lines) {
    if ((cur + line + '\n').length > 3000) {
      chunks.push(cur);
      cur = '';
    }
    cur += line + '\n';
  }
  if (cur.trim()) chunks.push(cur);
  for (const chunk of chunks) sendSlackMessage(chunk);
  return chunks.length;
}

module.exports = { loadPriorityFeedback, isOverdue, dueOf, formatEntry, sendAlert };
