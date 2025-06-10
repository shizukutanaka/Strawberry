// GPU障害履歴記録・取得の自動テスト雛形（Jest）
const fs = require('fs');
const path = require('path');
const { recordGpuError, getGpuErrorHistory } = require('../../src/gpu/gpu-error-history');

const HISTORY_PATH = path.join(__dirname, '../../logs/gpu-error-history.json');

describe('GPU障害履歴', () => {
  beforeEach(() => {
    if (fs.existsSync(HISTORY_PATH)) fs.unlinkSync(HISTORY_PATH);
  });

  it('障害記録・履歴取得ができる', async () => {
    await recordGpuError('gpu-1', 'overheat', { temp: 99 });
    await recordGpuError('gpu-1', 'fan error', { fan: 0 });
    const hist = getGpuErrorHistory('gpu-1');
    expect(hist.length).toBe(2);
    expect(hist[0].error).toBe('overheat');
    expect(hist[1].context.fan).toBe(0);
  });

  it('履歴は最大100件でローテーション', async () => {
    for (let i = 0; i < 110; ++i) await recordGpuError('gpu-2', `err${i}`);
    const hist = getGpuErrorHistory('gpu-2');
    expect(hist.length).toBe(100);
    expect(hist[0].error).toBe('err10');
    expect(hist[99].error).toBe('err109');
  });
});
