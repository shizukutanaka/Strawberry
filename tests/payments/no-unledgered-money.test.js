// tests/payments/no-unledgered-money.test.js
// **台帳に行を書かずに金を動かす経路が存在しない**ことを機械的に保証する。
//
// ── なぜこの検査が要るか ──────────────────────────────────────────────────
// この製品は「帳簿を 3 つの不変条件で自動突き合わせしている」と主張していた。
// その主張に対して一つ問うと崩れた: **その不変条件は金を見ているのか、記録を見ているのか。**
//
// 見ていたのは記録だった。`reconcile()` が読むのは PaymentRepository と LedgerRepository の
// 2 つだけで、台帳に行を書かずに送金する経路があれば、その金はどの不変条件からも見えない。
// そして実在した: `POST /payment/btc`（btc-onchain）は
//   - 「オンチェーン」を名乗りながら中身は Lightning API 呼び出しで、
//   - 支払い時点で（GPU 起動前に）プロバイダへ全額を送金し、
//   - その送金は台帳に載らないので、注文完了時に収益台帳が**もう一度**同額を計上し、
//   - それでも 3 つの不変条件はすべて healthy を返し続けた。
// 帳簿は合っていた。合っていなかったのは現金である。
//
// 経路は削除した（2026-09）。だが「気づいて消した」では次に同じものが足されたとき
// また見逃す。このリポジトリで繰り返し採ってきた方針どおり、**人が思い出さなくても
// 止まる形**にする。ここで表明するのは 2 つの向きの性質:
//   1. 金が動くなら必ず台帳の行になる  … 外部送金の呼び出し元がゼロであること
//   2. 台帳の行には必ず実送金の証跡がある … reconciliation の noUnbackedPayouts
// 片方だけでは監査にならない。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

function jsFilesUnder(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      jsFilesUnder(full, out);
    } else if (ent.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

// 行コメント・ブロックコメントを落とす（経緯の説明にキーワードが出るのは正当なので）。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no code path moves funds outside the ledger', () => {
  // 外部へ資金を送り出す痕跡。過去に実在した 2 実装（OpenNode の /v2/withdrawals、
  // LNbits の out:true 送金）と、それを包んでいた関数名を名指しする。
  const OUTBOUND = [
    { name: 'sendLightningPayment()', re: /\bsendLightningPayment\b/ },
    { name: 'sendBTC()', re: /\bsendBTC\b/ },
    { name: 'OpenNode withdrawal endpoint', re: /\/v2\/withdrawals/ },
    { name: 'LNbits outbound payment body', re: /out\s*:\s*true/ },
  ];

  it('has source files to check at all (guards against the walker finding none)', () => {
    expect(jsFilesUnder(SRC).length).toBeGreaterThan(50);
  });

  it('contains no outbound payment call site anywhere under src/', () => {
    const hits = [];
    for (const file of jsFilesUnder(SRC)) {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const { name, re } of OUTBOUND) {
        if (re.test(code)) hits.push(`${path.relative(ROOT, file)}: ${name}`);
      }
    }
    // 送金が必要になったら、この配列を空に戻すのではなく **台帳の payout 行を書いてから
    // 送る** 設計にすること（payout-ledger.completePayout が txid を記録する経路）。
    expect(hits).toEqual([]);
  });

  it('registers no route under /payment/btc', () => {
    const { app } = require('../../src/api/server');
    const paths = [];
    (function walk(stack, prefix) {
      for (const layer of stack) {
        if (layer.route) paths.push(prefix + layer.route.path);
        else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
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
    expect(paths.filter((p) => /\/payment\/btc/.test(p))).toEqual([]);
  });
});

describe('reconciliation watches the other direction too', () => {
  const { reconcile } = require('../../src/payments/reconciliation');
  const stub = (payments, ledger, orders = {}) => ({
    PaymentRepository: { getAll: () => payments },
    OrderRepository: { getById: (id) => orders[id] || null },
    LedgerRepository: { getAll: () => ledger },
  });

  it('flags a paid payout that carries no txid', () => {
    const r = reconcile(stub([], [
      { id: 'po1', kind: 'payout', status: 'paid', amountSats: 5000, userId: 'u1' },
    ]));
    expect(r.invariants.noUnbackedPayouts).toBe(false);
    expect(r.unbackedPayouts).toHaveLength(1);
    expect(r.totals.unbackedPayoutSats).toBe(5000);
  });

  it('accepts a paid payout that records a txid', () => {
    const r = reconcile(stub([], [
      { id: 'po1', kind: 'payout', status: 'paid', amountSats: 5000, userId: 'u1', txid: 'abcd1234' },
    ]));
    expect(r.invariants.noUnbackedPayouts).toBe(true);
    expect(r.unbackedPayouts).toEqual([]);
  });

  it('reports money received against no order instead of silently dropping it', () => {
    // 管理者発行の汎用インボイスは注文に紐づかない。不整合ではないが、
    // 黙って捨てると「見えていない金」になる。
    const r = reconcile(stub([{ status: 'paid', amount: 777 }], []));
    expect(r.totals.unattributedPaidSats).toBe(777);
    expect(r.invariants.conservationHolds).toBe(true);
  });
});

describe('crediting a completed order stays single-entry', () => {
  // btc-onchain の二重払いは「送金 + 台帳計上」という別種の二重だったが、
  // 経路を 1 本にしたあとも台帳側の冪等性が効いていることを確かめる。
  const payoutLedger = require('../../src/payments/payout-ledger');

  it('credits the provider exactly once even if the sweep runs twice', () => {
    const rows = [];
    const Ledger = {
      getByOrderId: (id) => rows.filter((r) => r.orderId === id),
      createUnique: (rec, pred) => {
        const existing = rows.find(pred);
        if (existing) return { ok: false, reason: 'exists', existing };
        const row = { id: `l${rows.length + 1}`, ...rec };
        rows.push(row);
        return { ok: true, row };
      },
    };
    const order = {
      id: 'o1', status: 'completed', userId: 'renter', providerId: 'prov',
      durationMinutes: 60,
    };
    const deps = {
      LedgerRepository: Ledger,
      PaymentRepository: { getByOrderId: () => [{ status: 'paid', amount: 100000 }] },
      EscrowRepository: { getByOrderId: () => [] },
    };

    const first = payoutLedger.creditOrder(order, deps);
    expect(first.credited).toBe(true);

    const second = payoutLedger.creditOrder(order, deps);
    expect(second.credited).toBe(false);
    expect(second.reason).toBe('already_credited');

    expect(rows.filter((r) => r.kind === 'earning')).toHaveLength(1);
  });
});
