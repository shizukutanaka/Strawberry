// slack-notify-checklist-kpi の dotenv 読み込み順序を検証する。
// slack-feedback-bot は require 時に process.env.SLACK_WEBHOOK_URL を定数へ
// 捕捉するため、呼び出し側スクリプトは require より先に dotenv を読む必要がある。
// 未対応だと .env に webhook を設定していても常に「未設定スキップ」になる。
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '../../scripts/slack-notify-checklist-kpi.js');
const REPORT = path.resolve(__dirname, '../../docs/checklist-kpi-report.md');

function runScript(cwd) {
  const env = { ...process.env };
  delete env.SLACK_WEBHOOK_URL; // dotenv は既存 env を上書きしないため除去する
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    env,
    timeout: 15000,
  });
  return `${res.stdout || ''}${res.stderr || ''}`;
}

describe('slack-notify-checklist-kpi', () => {
  let savedReport = null;
  let reportExisted = false;

  beforeAll(() => {
    // スクリプトの通知経路は REPORT_FILE 存在時のみ辿るので生成物を一時配置
    reportExisted = fs.existsSync(REPORT);
    if (reportExisted) savedReport = fs.readFileSync(REPORT, 'utf8');
    fs.writeFileSync(REPORT, '# test report\n');
  });

  afterAll(() => {
    if (reportExisted) fs.writeFileSync(REPORT, savedReport);
    else fs.rmSync(REPORT, { force: true });
  });

  test('.env の SLACK_WEBHOOK_URL が通知経路へ届く', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-env-'));
    // 接続不能でも良いアドレス: sendSlackMessage は error を握り潰す設計
    fs.writeFileSync(path.join(cwd, '.env'), 'SLACK_WEBHOOK_URL=https://127.0.0.1:9/hook\n');
    const out = runScript(cwd);
    expect(out).not.toContain('SLACK_WEBHOOK_URL未設定');
    expect(out).toContain('通知しました');
  });

  test('.env 不在時は webhook 未設定としてスキップする', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-noenv-'));
    const out = runScript(cwd);
    expect(out).toContain('SLACK_WEBHOOK_URL未設定');
  });
});
