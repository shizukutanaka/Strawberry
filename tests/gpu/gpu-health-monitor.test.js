// GPU健康監視の自動テスト雛形（Jest）
const { monitorGpuHealth } = require('../../src/gpu/gpu-health-monitor');

describe('GPU健康監視', () => {
  it('監視関数がエラーなく起動する', done => {
    // 実環境依存のため、起動テストのみ
    monitorGpuHealth({}, 1000); // 1秒間隔で即return
    setTimeout(() => done(), 1100);
  });
});
