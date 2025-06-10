// KPI推移グラフ画像をSlackに投稿するスクリプト（@slack/web-api利用）
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
const FILE_PATH = path.join(__dirname, '../docs/kpi-trend.png');

if (!SLACK_TOKEN || !SLACK_CHANNEL) {
  console.error('SLACK_BOT_TOKENまたはSLACK_CHANNELが未設定です');
  process.exit(1);
}

const web = new WebClient(SLACK_TOKEN);

async function uploadGraph() {
  if (!fs.existsSync(FILE_PATH)) {
    console.log('KPI推移グラフがありません');
    return;
  }
  try {
    await web.files.upload({
      channels: SLACK_CHANNEL,
      file: fs.createReadStream(FILE_PATH),
      filename: 'kpi-trend.png',
      title: 'KPI推移グラフ',
      initial_comment: '最新のKPI週次推移グラフです'
    });
    console.log('SlackにKPI推移グラフを通知しました');
  } catch (err) {
    console.error('Slackへの画像投稿に失敗:', err.message);
  }
}

if (require.main === module) {
  uploadGraph();
}

module.exports = { uploadGraph };
