// チェックリストからGitHub Issueを自動生成するスクリプト（@octokit/rest利用）
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const CHECKLIST_FILE = process.env.CHECKLIST_ISSUES_PATH || path.join(__dirname, '../improvement_checklist2.md');
const LABELS = ['improvement', 'auto-generated'];

function repoCoords() {
  const spec = process.env.GITHUB_REPO;
  const m = /^[^/\s]+\/[^/\s]+$/.exec(spec || '');
  if (!process.env.GITHUB_TOKEN || !m) {
    throw new Error('GITHUB_TOKEN と GITHUB_REPO（owner/repo 形式）が必要です');
  }
  const [owner, repo] = spec.split('/');
  return { owner, repo };
}

// @octokit/rest は optionalDependencies（未導入環境でも require 自体を
// 失敗させないため呼び出し時に解決する）。
function octokitClient() {
  let Octokit;
  try {
    ({ Octokit } = require('@octokit/rest'));
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new Error('@octokit/rest が未導入です。npm install で optionalDependencies を導入してください');
    }
    throw e;
  }
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

async function getExistingTitles(octokit, { owner, repo }) {
  // open issue は全ページ取得しないと 100 件超で重複作成を起こす
  const issues = await octokit.paginate(octokit.issues.listForRepo, {
    owner, repo, state: 'open', per_page: 100,
  });
  return new Set(issues.map(i => i.title));
}

// labels がリポジトリに無いと issues.create が 422 で全件失敗するため事前に用意
async function ensureLabels(octokit, { owner, repo }) {
  for (const name of LABELS) {
    try {
      await octokit.issues.createLabel({ owner, repo, name });
    } catch (e) {
      if (e.status !== 422) throw e; // 既存なら 422 — それ以外は伝播
    }
  }
}

function extractChecklistTasks() {
  if (!fs.existsSync(CHECKLIST_FILE)) {
    throw new Error(`${CHECKLIST_FILE} がありません（チェックリスト未生成）`);
  }
  const lines = fs.readFileSync(CHECKLIST_FILE, 'utf8').split('\n');
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^- \[ \] (.+)/);
    if (!match) continue;
    let body = '';
    if (lines[i + 1] && lines[i + 1].includes('【改善案】')) {
      body = lines[i + 1].replace(/^-? ?【改善案】/, '').trim();
    }
    tasks.push({ title: match[1].trim(), body });
  }
  return tasks;
}

async function createIssues() {
  const coords = repoCoords();
  const octokit = octokitClient();
  const existing = await getExistingTitles(octokit, coords);
  await ensureLabels(octokit, coords);
  const tasks = extractChecklistTasks();
  let created = 0, skipped = 0, failed = 0;
  for (const task of tasks) {
    if (existing.has(task.title)) { skipped++; continue; }
    try {
      await octokit.issues.create({ ...coords, title: task.title, body: task.body || '', labels: LABELS });
      created++;
      console.log(`Issue作成: ${task.title}`);
    } catch (e) {
      failed++;
      console.error(`Issue作成失敗（${task.title}）: ${e.message}`);
    }
  }
  console.log(`Issue化: 作成 ${created} / 既存スキップ ${skipped} / 失敗 ${failed}`);
  return { created, skipped, failed };
}

if (require.main === module) {
  createIssues()
    .then(() => console.log('全未完了タスクのIssue化が完了しました'))
    .catch(e => {
      console.error(`Issue化に失敗: ${e.message}`);
      process.exit(1);
    });
}

module.exports = { createIssues, extractChecklistTasks, repoCoords };
