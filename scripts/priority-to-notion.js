// 優先度付きフィードバックをNotion進捗ボードに転記（@notionhq/client利用）
const fs = require('fs');
const path = require('path');
// @notionhq/client は optionalDependencies — 未導入環境での MODULE_NOT_FOUND を避けるため遅延 require。
const { requireOptional } = require('./lib/optional-dep');
const { readJsonArray } = require('./lib/read-json');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const PRIORITY_FILE = path.join(__dirname, '../docs/feedback-priority.json');

async function addFeedbackToNotion(feedback, notion) {
  await notion.pages.create({
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
  const { Client } = requireOptional('@notionhq/client');
  const notion = new Client({ auth: NOTION_TOKEN });
  for (const fb of feedbacks) {
    await addFeedbackToNotion(fb, notion);
  }
  console.log('Notion進捗ボードに転記しました。');
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { main };
