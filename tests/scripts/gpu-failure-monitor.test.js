// GPU障害監視スクリプトのテスト雛形（Jest）
const { monitor } = require('../../scripts/gpu-failure-monitor');

describe('GPU障害監視スクリプト', () => {
  it('正常系: nvidia-smiコマンド実行時にエラーなく終了', done => {
    // 実際のコマンド実行は環境依存のため、ここでは単純な呼び出しテスト
    monitor();
    done();
  });
});
