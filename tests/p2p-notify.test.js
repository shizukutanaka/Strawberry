// p2p-* 系 MVP スクリプトの optional-deps 耐性と p2p-notify の監視セマンティクスを検証
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('p2p-node 遅延 require', () => {
  test('モジュール読み込み自体は失敗しない（libp2p 未導入でも）', () => {
    expect(() => require('../src/p2p-node')).not.toThrow();
  });

  test('createNode は未導入時に手順付きエラーで失敗する', async () => {
    const { createNode } = require('../src/p2p-node');
    await expect(createNode()).rejects.toThrow(/npm i libp2p/);
  });

  test('依存モジュール群も読み込みだけなら失敗しない', () => {
    for (const m of ['../src/p2p-order', '../src/p2p-gpu', '../src/p2p-health', '../src/p2p-sync', '../src/cli']) {
      expect(() => require(m)).not.toThrow();
    }
  });

  test('p2p-sync main は未導入時に手順付きエラーで失敗する', async () => {
    const { main } = require('../src/p2p-sync');
    await expect(main()).rejects.toThrow(/ipfs-core \/ orbit-db/);
  });
});

describe('p2p-notify checkHealthFile', () => {
  const HEALTH_FILE = path.join(__dirname, '../src/health.json');
  const notify = require('../src/p2p-notify');

  afterEach(() => {
    try { fs.unlinkSync(HEALTH_FILE); } catch (_) {}
    jest.restoreAllMocks();
  });

  function writeHealth(obj) {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(obj));
  }

  test('新鮮な health.json で peerCount=0 なら NODE_DOWN を通知', async () => {
    writeHealth({ peerCount: 0, peerId: 'peer-1', timestamp: Date.now() });
    // notifyAll はモジュール内で直接呼ばれるため、logAudit の appendFileSync を観測する
    const logSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    await notify.checkHealthFile();
    const calls = logSpy.mock.calls.map(c => String(c[1]));
    expect(calls.some(l => l.includes('NODE_DOWN'))).toBe(true);
  });

  test('60秒超の stale health.json は NODE_MONITOR_STALE を通知', async () => {
    writeHealth({ peerCount: 3, peerId: 'peer-1', timestamp: Date.now() - 120_000 });
    const logSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    await notify.checkHealthFile();
    const calls = logSpy.mock.calls.map(c => String(c[1]));
    expect(calls.some(l => l.includes('NODE_MONITOR_STALE'))).toBe(true);
    expect(calls.some(l => l.includes('NODE_DOWN'))).toBe(false);
  });

  test('health.json 不在/破損では何も通知しない', async () => {
    const logSpy = jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    await notify.checkHealthFile(); // 不在
    fs.writeFileSync(HEALTH_FILE, 'not json{'); // 破損（JSON として parse 不能）
    await notify.checkHealthFile();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
