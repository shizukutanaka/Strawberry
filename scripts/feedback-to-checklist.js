// フィードバックをimprovement_checklist4.mdに自動反映するスクリプト
const fs = require('fs');
const path = require('path');

const FEEDBACK_FILE = path.join(__dirname, '../docs/feedback-log.json');
const CHECKLIST_FILE = path.join(__dirname, '../improvement_checklist4.md');

function loadFeedback() {
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
}

function appendChecklist(feedbacks) {
  if (feedbacks.length === 0) return;
  let checklist = fs.readFileSync(CHECKLIST_FILE, 'utf8');
  const marker = '<!-- AUTO_FEEDBACK_CHECKLIST -->';
  let section = `\n\n${marker}\n`;
  section += '### 現場フィードバック自動反映\n';
  feedbacks.slice(-10).forEach(fb => {
    section += `- [ ] ${fb.timestamp.slice(0,10)} ${fb.user}: ${fb.message}\n`;
  });
  section += `${marker}\n`;
  // 既存の自動反映セクションを置換/追記
  if (checklist.includes(marker)) {
    checklist = checklist.replace(new RegExp(`${marker}[\s\S]*?${marker}`), section);
  } else {
    checklist += section;
  }
  fs.writeFileSync(CHECKLIST_FILE, checklist);
  console.log('improvement_checklist4.md にフィードバックを自動反映しました。');
}

const feedbacks = loadFeedback();
appendChecklist(feedbacks);
