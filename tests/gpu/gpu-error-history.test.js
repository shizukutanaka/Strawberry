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

  it('並行 recordGpuError がエントリを失わない（lost-update 回帰）', async () => {
    // health/liveness 両モニタが同時発火し得る。ロック無しだと read-modify-write で
    // 後勝ちとなり一方のエントリが消える。
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => recordGpuError(`gpu-par-${i}`, `err${i}`))
    );
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    expect(Object.keys(raw).filter(k => k.startsWith('gpu-par-'))).toHaveLength(50);
  });

  it('破損した履歴ファイルは .corrupt-* へ退避され上書きされない', async () => {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, '{broken json!!!');
    await recordGpuError('gpu-x', 'after-corruption');
    const files = fs.readdirSync(path.dirname(HISTORY_PATH));
    const quarantined = files.filter(f => f.startsWith('gpu-error-history.json.corrupt-'));
    expect(quarantined.length).toBeGreaterThanOrEqual(1);
    // 退避ファイルは破損のまま保持（証跡）
    expect(fs.readFileSync(path.join(path.dirname(HISTORY_PATH), quarantined[0]), 'utf-8'))
      .toBe('{broken json!!!');
    // 新規履歴は正常に再開している
    expect(getGpuErrorHistory('gpu-x').length).toBe(1);
    // 後始末
    for (const f of quarantined) fs.unlinkSync(path.join(path.dirname(HISTORY_PATH), f));
  });

  it('未知 gpuId が MAX_GPU_KEYS(1000) 超の新規鍵を作る場合は最古鍵を除く', async () => {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const seed = {};
    for (let i = 0; i < 1000; i++) seed[`old-${i}`] = [{ time: 't', error: 'e', stack: null, context: {} }];
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(seed));
    await recordGpuError('brand-new-gpu', 'overflow');
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    expect(Object.keys(raw)).toHaveLength(1000);
    expect(raw['old-0']).toBeUndefined();   // 最古の挿入キーが除かれた
    expect(raw['old-1']).toBeDefined();
    expect(raw['brand-new-gpu']).toHaveLength(1);
  });

  it('既存履歴が既に上限超過している場合は上限まで戻す（1件だけでは回復しない）', async () => {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    const seed = {};
    for (let i = 0; i < 1200; i++) seed[`old-${i}`] = [{ time: 't', error: 'e', stack: null, context: {} }];
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(seed));
    await recordGpuError('brand-new-gpu', 'overflow');
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
    expect(Object.keys(raw)).toHaveLength(1000);
    expect(raw['brand-new-gpu']).toHaveLength(1);
    // 最古の201キーが除かれ、残りは上限内
    expect(raw['old-200']).toBeUndefined();
    expect(raw['old-201']).toBeDefined();
  });
});
