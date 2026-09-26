// GPU障害監視スクリプトのテスト（Jest）
// monitor() は Promise を返すため、非同期コールバックの完了を待機して検証する。
jest.mock('child_process', () => ({ exec: jest.fn() }));
jest.mock('../../scripts/slack-feedback-bot', () => ({ sendSlackMessage: jest.fn() }));

const { exec } = require('child_process');
const { sendSlackMessage } = require('../../scripts/slack-feedback-bot');
const { monitor } = require('../../scripts/gpu-failure-monitor');

describe('GPU障害監視スクリプト', () => {
  beforeEach(() => {
    exec.mockReset();
    sendSlackMessage.mockReset();
  });

  it('正常系: 健全な nvidia-smi 出力では通知しない', async () => {
    // temp=45, P0, util=50, fan=40 はすべて正常範囲
    exec.mockImplementation((cmd, cb) => { if (cb) cb(null, '45, P0, 50, 40', ''); });
    await monitor();
    expect(exec).toHaveBeenCalledWith(expect.stringContaining('nvidia-smi'), expect.any(Function));
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it('障害系: 高温なら Slack 通知とリカバリを実行する', async () => {
    exec.mockImplementation((cmd, cb) => { if (cb) cb(null, '92, P0, 10, 60', ''); });
    await monitor();
    expect(sendSlackMessage).toHaveBeenCalledWith(expect.stringContaining('GPU障害検知'));
  });

  it('nvidia-smi 実行失敗時はエラー通知して解決する', async () => {
    exec.mockImplementation((cmd, cb) => { if (cb) cb(new Error('nvidia-smi: not found'), '', ''); });
    await expect(monitor()).resolves.toBeUndefined();
    expect(sendSlackMessage).toHaveBeenCalledWith(expect.stringContaining('nvidia-smi実行失敗'));
  });
});
