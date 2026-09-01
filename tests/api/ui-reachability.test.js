// tests/api/ui-reachability.test.js
// 登録済みエンドポイントのうち、**製品（UI）からは決して到達しないもの**を機械的に数え、
// その数が増えないようにする（ラチェット）。
//
// ── なぜこれが要るか ──────────────────────────────────────────────────────
// このリポジトリでは「登録されているが誰も使わない」機能が繰り返し現れた。P2P 経由の
// マッチング、逆オークション、GPU ベンチマーク、オンチェーン BTC 決済、ピアID 管理。
// いずれも実装され、テストされ、仕様書に載り、そして**製品のどの画面からも呼ばれて
// いなかった**。個別に気づいて潰すやり方では、次に同じものが増えたときにまた見逃す。
// 実際、直近の 2 件（peerId と参考価格）はこの突き合わせを手で回して初めて見つかった。
//
// tests/api/no-dead-endpoints.test.js は「叩けば応答するか」を見る。こちらは
// 「そもそも誰かが叩くのか」を見る。応答するが誰も呼ばないエンドポイントは、
// 動くことをテストで確かめられている分だけ、壊れた機能より見つけにくい。
//
// ── 判定 ──────────────────────────────────────────────────────────────────
// 対象外（正当に API 専用）:
//   - `/admin` を含むパス … 運営が curl や管理ツールから叩く前提のもの
//   - インフラ系（/system/ /auth/ /node-info /channels /graphql /health）
// 残ったものが「一般ユーザー向けに見えるのに、製品からは到達しない」候補。
// ゼロにはできない（プログラマティックな API 面として意図的に残すものもある）ので、
// **今の数を上限として固定し、増えたら落とす**。減らしたら BASELINE も下げること。
const fs = require('fs');
const path = require('path');
const { app } = require('../../src/api/server');

const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_JS = path.join(ROOT, 'public/js');

// 2026-09 時点の実数。**上げてはいけない。** 新しいエンドポイントを足すなら、
// 同じ変更の中で UI から呼ぶか、admin 配下に置くか、足さないかを選ぶ。
const BASELINE = 37;

function collectRoutes() {
  const out = [];
  (function walk(stack, prefix) {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
          out.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        let p = '';
        if (layer.regexp && layer.regexp.source !== '^\\/?(?=\\/|$)') {
          p = layer.regexp.source
            .replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/')
            .replace('(?=\\/|$)', '').replace(/\$$/, '').replace(/\?$/, '');
        }
        walk(layer.handle.stack, prefix + p);
      }
    }
  })(app._router.stack, '');
  return out;
}

function jsFilesUnder(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) jsFilesUnder(full, out);
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** UI が実際に組み立てるパス。`${id}` 等のテンプレート穴は :x に潰して比べる。 */
function uiPaths() {
  const set = new Set();
  for (const file of jsFilesUnder(PUBLIC_JS)) {
    const src = fs.readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/['`](\/api\/v1\/[^'`]*)['`]/g)) {
      set.add(normalize(m[1]));
    }
  }
  return set;
}

function normalize(p) {
  return p.replace(/\$\{[^}]*\}/g, ':x').replace(/:\w+/g, ':x').replace(/\/$/, '') || '/';
}

const API_ONLY = /\/admin|\/system\/|\/auth\/|\/node-info|\/channels|\/graphql|\/health/;

function unreachableFromUi() {
  const ui = uiPaths();
  return collectRoutes()
    .filter((r) => r.path.startsWith('/api/v1'))
    .filter((r) => !API_ONLY.test(r.path))
    .filter((r) => !ui.has(normalize(r.path)))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
}

describe('endpoints the product itself never reaches', () => {
  it('finds both routes and UI call sites (guards against either walker finding none)', () => {
    expect(collectRoutes().length).toBeGreaterThan(50);
    expect(uiPaths().size).toBeGreaterThan(10);
  });

  it('does not grow the set of user-facing endpoints no screen calls', () => {
    const orphans = unreachableFromUi();
    // 失敗したら一覧が出る。増えた 1 本が何かはそこで分かる。
    if (orphans.length > BASELINE) {
      throw new Error(
        `製品から到達しないエンドポイントが ${orphans.length} 本（上限 ${BASELINE}）。\n`
        + '足したエンドポイントを UI から呼ぶか、/admin 配下に置くか、足さないかを選ぶこと。\n'
        + orphans.map((o) => `  ${o}`).join('\n')
      );
    }
    expect(orphans.length).toBeLessThanOrEqual(BASELINE);
  });

  it('keeps BASELINE honest (lower it when the set shrinks)', () => {
    // BASELINE が実数より大きいまま放置されると、その差分だけ黙って増やせてしまう。
    expect(unreachableFromUi().length).toBe(BASELINE);
  });
});
