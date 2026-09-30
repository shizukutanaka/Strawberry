// anomaly-detector の堅牢性ガード:
// - logs/ 不在の新規環境でも reportAnomaly が例外を投げない（mkdir 追加の回帰検知）
// - appendFileSync 失敗が報告呼び出しを殺さない
// - detectRequestAnomaly の IP カウンタが上限でバウンドされる（無制限増殖防止）
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    appendFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => '[]'),
    writeFileSync: jest.fn(),
    renameSync: jest.fn(),
  };
});

const { reportAnomaly, detectRequestAnomaly, _ipRequestTimestamps } =
  require('../../src/utils/anomaly-detector');

describe('anomaly-detector hardening', () => {
  beforeEach(() => {
    _ipRequestTimestamps.clear();
    jest.clearAllMocks();
  });

  it('reportAnomaly は logs/ 不在でも投げずディレクトリを作成する', () => {
    const fsm = require('fs');
    expect(() => reportAnomaly('test_type', { x: 1 })).not.toThrow();
    // mkdirSync(recursive) が呼ばれていること（ENOENT での暗黙失敗を防ぐ）
    expect(fsm.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('logs'), { recursive: true });
  });

  it('appendFileSync が失敗しても reportAnomaly は投げない（報告経路の堅牢化）', () => {
    const fsm = require('fs');
    fsm.appendFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => reportAnomaly('test_type', {})).not.toThrow();
  });

  it('detectRequestAnomaly: 同一 IP の 100 回超で異常検知', () => {
    const req = { ip: '203.0.113.1' };
    let hit = false;
    for (let i = 0; i < 101; i++) hit = detectRequestAnomaly(req);
    expect(hit).toBe(true);
  });

  it('IP カウンタ Map は上限でバウンドされる（無制限増殖の防止）', () => {
    // 大量のユニーク IP を流しても内部状態が増殖し続けないこと
    for (let i = 0; i < 10_500; i++) {
      detectRequestAnomaly({ ip: `10.0.${Math.floor(i / 256)}.${i % 256}` });
    }
    expect(_ipRequestTimestamps.size).toBeLessThanOrEqual(10_001);
  });
});
