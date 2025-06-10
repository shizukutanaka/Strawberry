// GPU障害自動検知・復旧・Slack通知スクリプト
const { exec } = require('child_process');
const { sendSlackMessage } = require('./slack-feedback-bot');

// Windows: nvidia-smi, Linux: nvidia-smi, Mac: 未対応
const CHECK_CMD = 'nvidia-smi --query-gpu=temperature.gpu,pstate,utilization.gpu,fan.speed --format=csv,noheader,nounits';

function parseStatus(stdout) {
  // 例: "45, P0, 98, 60"
  const [temp, pstate, util, fan] = stdout.trim().split(/, ?/);
  return {
    temp: Number(temp),
    pstate,
    util: Number(util),
    fan: Number(fan)
  };
}

function isFailure(status) {
  // 例: 90度超・P8固定・利用率0%・ファン0% = 障害
  return status.temp > 85 || status.pstate === 'P8' || status.util < 5;
}

function tryRecovery() {
  // Windows/Linux共通の簡易リカバリ例（サービス再起動など）
  // 本番用は運用方針に応じてカスタマイズ
  exec('echo GPUリカバリ処理(例)');
}

function monitor() {
  exec(CHECK_CMD, (err, stdout, stderr) => {
    if (err) {
      sendSlackMessage('【GPU監視エラー】nvidia-smi実行失敗: ' + err.message);
      return;
    }
    try {
      const status = parseStatus(stdout);
      if (isFailure(status)) {
        sendSlackMessage(`【GPU障害検知】\n温度:${status.temp}℃\n状態:${status.pstate}\n利用率:${status.util}%\nファン:${status.fan}%\n→自動リカバリ試行`);
        tryRecovery();
      }
    } catch (e) {
      sendSlackMessage('【GPU監視パースエラー】' + e.message);
    }
  });
}

if (require.main === module) {
  monitor();
}

module.exports = { monitor };
