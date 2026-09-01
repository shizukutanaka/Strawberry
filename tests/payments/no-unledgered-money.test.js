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
// また見逃す——実際、この検査の**最初の版がそれをやった**。消したばかりの API 名を手で
// 並べたので、生きていた `lightning.payInvoice()` の直呼び 2 箇所（`POST /payment` と
// `POST /payments/pay`。どちらも admin 限定だが、送金しても台帳の payout 行を書かないので
// プロバイダは同じ額をもう一度申請できた）を素通りさせた。列挙は必ず古くなる。このリポジトリで繰り返し採ってきた方針どおり、**人が思い出さなくても
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
  // 「送金の呼び出し元」を**列挙で持たない**。最初にこの検査を書いたとき、消したばかりの
  // API 名（sendBTC / sendLightningPayment / OpenNode の /v2/withdrawals）を手で並べたので、
  // 生きている送金経路——`lightning.payInvoice()` を直接叩く 2 つの admin ルート——を
  // まるごと見逃した。同じ穴が 2 箇所そのまま残っていた。
  // このリポジトリで繰り返し学んだとおり、**リストを手で持つと次に必ず漏れる**。
  // ここではソースから機械的に導く: Lightning サービスのメソッド呼び出しのうち
  // 名前が送金を意味するもの（pay / send / withdraw）を全部拾い、許可した 1 箇所だけで
  // あることを表明する。新しい送金メソッドが増えても自動的に拾われる。
  const SEND_METHOD = /\b(?:lightning|_lightning|ln|adapter)\s*\.\s*((?:pay|send|withdraw)[A-Za-z]*)\s*\(/g;

  // 許可された 2 箇所だけ。
  //  - payment/index.js … 唯一の実送金。出金申請の行に束縛されているので必ず台帳に残る
  //  - action-executor.js … エスクロー FSM の actions を**注入されたアダプタ**へ振り分ける
  //    ディスパッチ表。本番の呼び出し側はどこも lnAdapter を渡していないため到達しない
  //    （下の検査でその事実自体を固定する）。将来 hold invoice で結線するときは、
  //    そのとき台帳の payout 行をどう書くかを必ず決めること
  const ALLOWED = new Set([
    'src/api/routes/payment/index.js',
    'src/payments/action-executor.js',
  ]);

  it('has source files to check at all (guards against the walker finding none)', () => {
    expect(jsFilesUnder(SRC).length).toBeGreaterThan(50);
  });

  it('calls a Lightning send method from exactly one place, and that place settles a payout', () => {
    const sites = [];
    for (const file of jsFilesUnder(SRC)) {
      const rel = path.relative(ROOT, file);
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const m of code.matchAll(SEND_METHOD)) sites.push({ rel, method: m[1] });
    }
    const outside = sites.filter((x) => !ALLOWED.has(x.rel));
    expect(outside.map((x) => `${x.rel}: ${x.method}()`)).toEqual([]);
    // 許可した側も「あるはず」を確かめる（正規表現が壊れて 0 件になったのを
    // green と誤読しないため）
    expect(sites.length).toBeGreaterThan(0);
  });

  it('sends only from the payout-completion handler, which requires a requested payout row', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/api/routes/payment/index.js'), 'utf-8'
    );
    const idx = src.indexOf('lightning.payInvoice(');
    expect(idx).toBeGreaterThan(-1);
    // 送金の手前で、申請中の出金として実在することを確かめている
    const before = src.slice(0, idx);
    expect(before).toMatch(/payoutLedger\.pendingPayouts\(\)/);
    // 送金の直後に台帳へ確定を書いている
    expect(src.slice(idx)).toMatch(/payoutLedger\.completePayout\(/);
  });

  it('injects no LN adapter into any production escrow service', () => {
    // action-executor が送金し得るのは lnAdapter を渡された場合だけで、本番の
    // createEscrowService() はどこも渡していない。ARCHITECTURE.md はかつてこれを
    // 「money-movement gap 解決済み」と書いていたが、実行されるのは actions の**計算**まで
    // で、送金は誰も行っていなかった。結線したくなったら、そのとき台帳の payout 行を
    // どう書くかを決めるまでこの検査が止める。
    const hits = [];
    for (const file of jsFilesUnder(SRC)) {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      // 定義側 `function createEscrowService({ repository, lnAdapter })` は呼び出しではない。
      for (const m of code.matchAll(/(?<!function\s)createEscrowService\(([^)]*)\)/g)) {
        if (/lnAdapter/.test(m[1])) hits.push(path.relative(ROOT, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it('contains no outbound HTTP payment call site anywhere under src/', () => {
    // 過去に実在した HTTP 版（OpenNode の /v2/withdrawals、LNbits の out:true 送金）。
    // gRPC 側は上の導出検査が見る。
    const HTTP_OUTBOUND = [
      { name: 'OpenNode withdrawal endpoint', re: /\/v2\/withdrawals/ },
      { name: 'LNbits outbound payment body', re: /out\s*:\s*true/ },
      { name: 'sendBTC()', re: /\bsendBTC\b/ },
      { name: 'sendLightningPayment()', re: /\bsendLightningPayment\b/ },
    ];
    const hits = [];
    for (const file of jsFilesUnder(SRC)) {
      const code = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const { name, re } of HTTP_OUTBOUND) {
        if (re.test(code)) hits.push(`${path.relative(ROOT, file)}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('registers no raw payment passthrough route', () => {
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
    const normalized = paths.map((p) => p.replace(/\/$/, ''));
    // /payment/btc（オンチェーン二段送金）、/payment（生の BOLT11 パススルー）、
    // /payments/pay（同上）。いずれも台帳に行を書かずに金を動かしていた。
    expect(normalized.filter((p) => /\/payment\/btc$|^\/api\/v1\/payment$|\/payments\/pay$/.test(p)))
      .toEqual([]);
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
