// フィードバックをimprovement_checklist4.mdに自動反映するスクリプト
const fs = require('fs');
const path = require('path');
const { loadFeedback } = require('./lib/feedback-store');

const CHECKLIST_FILE = process.env.FEEDBACK_CHECKLIST_PATH || path.join(__dirname, '../improvement_checklist4.md');
const MARKER = '<!-- AUTO_FEEDBACK_CHECKLIST -->';

// チェックリスト未作成でもフィードバックを失わないよう、無ければ空から開始する。
function readChecklist() {
  if (!fs.existsSync(CHECKLIST_FILE)) return '';
  return fs.readFileSync(CHECKLIST_FILE, 'utf8');
}

function appendChecklist(feedbacks, checklist = readChecklist()) {
  if (feedbacks.length === 0) return checklist;
  let section = `\n\n${MARKER}\n`;
  section += '### 現場フィードバック自動反映\n';
  feedbacks.slice(-10).forEach(fb => {
    section += `- [ ] ${String(fb.timestamp).slice(0, 10)} ${fb.user}: ${fb.message}\n`;
  });
  section += `${MARKER}\n`;
  // 既存の自動反映セクションを置換/追記
  if (checklist.includes(MARKER)) {
    checklist = checklist.replace(new RegExp(`${MARKER}[\\s\\S]*?${MARKER}`), section);
  } else {
    checklist += section;
  }
  fs.writeFileSync(CHECKLIST_FILE, checklist);
  console.log('improvement_checklist4.md にフィードバックを自動反映しました。');
  return checklist;
}

if (require.main === module) {
  try {
    appendChecklist(loadFeedback());
  } catch (e) {
    console.error(`チェックリスト反映に失敗: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { appendChecklist };
