// チェックリストからGitHub Issueを自動生成するスクリプト（@octokit/rest利用）
const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const CHECKLIST_FILE = path.join(__dirname, '../improvement_checklist2.md');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // 形式: username/repo

if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.error('GITHUB_TOKENまたはGITHUB_REPOが未設定です');
  process.exit(1);
}

const [owner, repo] = GITHUB_REPO.split('/');
const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function getExistingIssues() {
  const issues = await octokit.issues.listForRepo({ owner, repo, state: 'open', per_page: 100 });
  return issues.data.map(issue => issue.title);
}

function extractChecklistTasks() {
  const text = fs.readFileSync(CHECKLIST_FILE, 'utf8');
  const lines = text.split('\n');
  const tasks = [];
  let lastTitle = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // チェックボックス未完了項目
    const match = line.match(/^- \[ \] (.+)/);
    if (match) {
      lastTitle = match[1].trim();
      // 直後に【改善案】があれば本文に含める
      let body = '';
      if (lines[i+1] && lines[i+1].includes('【改善案】')) {
        body = lines[i+1].replace(/^-? ?【改善案】/, '').trim();
      }
      tasks.push({ title: lastTitle, body });
    }
  }
  return tasks;
}

async function createIssues() {
  const existingTitles = await getExistingIssues();
  const tasks = extractChecklistTasks();
  for (const task of tasks) {
    if (existingTitles.includes(task.title)) continue;
    await octokit.issues.create({
      owner,
      repo,
      title: task.title,
      body: task.body || '',
      labels: ['improvement', 'auto-generated']
    });
    console.log(`Issue作成: ${task.title}`);
  }
}

if (require.main === module) {
  createIssues().then(() => console.log('全未完了タスクのIssue化が完了しました')).catch(console.error);
}

module.exports = { createIssues };
