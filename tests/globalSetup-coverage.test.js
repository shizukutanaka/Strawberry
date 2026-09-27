// tests/globalSetup-coverage.test.js
// globalSetup のリセット対象が createJsonRepository('X.json') で作られる全永続ファイルを
// 網羅しているかを構造的に検証する。
// 背景: watches.json が長期間リストから漏れており、probe61-price-watch 等が作成した
// ウォッチがテスト実行間で蓄積し続けていた。将来リポジトリが追加されたときに
// globalSetup 側の更新漏れをこのテストが捕捉する。
const fs = require('fs');
const path = require('path');
const globalSetup = require('./globalSetup');

const DB_DIR = path.join(__dirname, '../src/db/json');
const DATA_DIR = path.join(__dirname, '../data');

describe('globalSetup のリセット網羅性', () => {
  it('createJsonRepository で作られる全ファイルをリセット対象がカバーする', () => {
    // src/db/json/ 内の createJsonRepository('X.json' 呼び出しを走査
    const repoFiles = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.js'));
    const declared = new Set();
    for (const f of repoFiles) {
      const src = fs.readFileSync(path.join(DB_DIR, f), 'utf8');
      for (const m of src.matchAll(/createJsonRepository\(\s*['"]([\w-]+)\.json['"]/g)) {
        declared.add(m[1]);
      }
    }
    expect(declared.size).toBeGreaterThan(0);

    // globalSetup.js 内のリセット対象名を抽出（arrayFiles/objectFiles/defaultFiles）
    const setupSrc = fs.readFileSync(path.join(__dirname, 'globalSetup.js'), 'utf8');
    const reset = new Set();
    for (const m of setupSrc.matchAll(/['"]([\w-]+)['"]/g)) {
      reset.add(m[1]);
    }

    for (const name of declared) {
      expect(reset.has(name)).toBe(true);
    }
  });

  it('globalSetup を実行すると watches.json が空配列にリセットされる', async () => {
    // 実リセットの回帰テスト: 汚れた状態を書いて globalSetup を呼び、空に戻るか見る
    const target = path.join(DATA_DIR, 'watches.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(target, JSON.stringify([{ id: 'stale-watch' }]));
    await globalSetup();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual([]);
  });

  it('sla.json は配列ではなく sla-tracker の初期オブジェクト形状でリセットされる', async () => {
    // '[]' でリセットすると sla-tracker の loadSLA() → history.push が TypeError になる
    const target = path.join(DATA_DIR, 'sla.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ total: 999 }));
    await globalSetup();
    const sla = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(sla).toEqual({ total: 0, up: 0, down: 0, history: [] });
  });
});
