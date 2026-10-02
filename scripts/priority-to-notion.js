// 優先度付きフィードバックをNotion進捗ボードに転記（@notionhq/client利用）
const fs = require('fs');
const path = require('path');
const { readJsonArray } = require('./lib/read-json');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');

// @notionhq/client は optionalDependencies — engines 不適合・未導入環境でも
// NOTION_* 未設定の明示エラーが先に出るよう遅延初期化する。
let notion = null;
function getNotion() {
  if (!notion) {
    const { Client } = require('@notionhq/client');
    notion = new Client({ auth: NOTION_TOKEN });
  }
  return notion;
}

async function addFeedbackToNotion(feedback) {
  await getNotion().pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: {
      '日時': { date: { start: feedback.timestamp } },
      'ユーザー': { title: [{ text: { content: feedback.user } }] },
      '内容': { rich_text: [{ text: { content: feedback.message } }] },
      '優先度': { select: { name: feedback.priority } },
      'ステータス': { select: { name: '未対応' } }
    }
  });
}

async function main() {
  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    throw new Error('NOTION_TOKENとNOTION_DB_IDが未設定です (.env で指定してください)');
  }
  if (!fs.existsSync(PRIORITY_FILE)) return;
  const feedbacks = readJsonArray(PRIORITY_FILE);
  for (const fb of feedbacks) {
    await addFeedbackToNotion(fb);
  }
  console.log('Notion進捗ボードに転記しました。');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { main };
