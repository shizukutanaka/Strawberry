// p2p-notify の状態遷移通知テスト。
// 連続ダウン中にポーリング毎回通知すると監視チャネルがスパム化するため、
// 通知は up→down / down→up の遷移時のみに限定されていることを検証する。

const path = require('path');
const fs = require('fs');
const os = require('os');

const mockSendNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/utils/notifier', () => ({
  sendNotification: (...a) => mockSendNotification(...a),
  NotifyType: { WEBHOOK: 'WEBHOOK' },
}));
const axios = require('axios');
jest.mock('axios');

const tmpLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'notify-')), 'audit.log');
process.env.MONITOR_LOG_PATH = tmpLog;
process.env.GENERIC_WEBHOOK = 'https://hooks.example.com/x';
process.env.MONITOR_TARGETS = 'http://target-a.local/health,http://target-b.local/health';

const notify = require('../../src/p2p-notify');

describe('p2p-notify state-transition alerting', () => {
  beforeEach(() => { jest.clearAllMocks(); notify._resetTargetState(); });

  it('alerts once on up→down, stays silent while down persists, and alerts once on recovery', async () => {
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await notify.checkExternalTargets();          // down #1 → notify
    await notify.checkExternalTargets();          // still down → silent
    expect(mockSendNotification).toHaveBeenCalledTimes(2); // target A + B、各1回

    axios.get.mockResolvedValue({ status: 200 });
    await notify.checkExternalTargets();          // down→up → RECOVERY notify
    await notify.checkExternalTargets();          // still up → silent
    expect(mockSendNotification).toHaveBeenCalledTimes(4); // +各1回の復帰通知
  });

  it('treats non-200 responses as down and tracks targets independently', async () => {
    axios.get
      .mockResolvedValueOnce({ status: 503 })     // A: down
      .mockResolvedValue({ status: 200 });        // B: up（初期 up→up で通知なし）
    await notify.checkExternalTargets();
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
  });
});
