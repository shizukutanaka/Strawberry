// tests/unit/lightning-service-hold-invoice-gap.test.js
//
// 第7回点検: settleHoldInvoice()/cancelHoldInvoice() は `this.lnd.settleInvoice` /
// `this.lnd.cancelInvoice` を呼ぶ。だがこの2つの RPC は LND の invoicesrpc
// （`invoices.proto`、lnrpc とは別サービス）が提供するもので、lightning-service.js が
// 読み込むのは proto/lightning.proto の lnrpc.Lightning のみ（Mock 実装にも同名メソッドは
// 無い）。つまりこの2メソッドは、本番でも Mock でも、呼べば必ず
// `TypeError: this.lnd.settleInvoice is not a function` で落ちる——原因が全く分からない
// 形で。今のところ実害は無い（hold invoice 自体を発行する経路がどこにも無く、
// これらのメソッドは製品のどこからも実際には呼ばれていない）が、将来 preimage/invoice
// 生成側だけを直して呼び出しを有効化すると、このもう一段深い欠落にそこで初めて気づく
// ことになる——見た目は完成しているコードが、呼ぶと理由不明のまま壊れる。
//
// 直し方: 呼べば失敗することは避けられない（invoicesrpc を実装するのは今回のスコープ外、
// ARCHITECTURE.md 参照）。だから代わりに、失敗の理由が一目で分かる形にする
// （このファイルの setupMockLND() が明示的モックにのみ許可を出す方針と同じ）。
const { LightningService } = require('../../lightning-service');

function makeMockService() {
  const svc = new LightningService();
  svc.setupMockLND();
  return svc;
}

describe('settleHoldInvoice/cancelHoldInvoice: fail loudly, not with a bare TypeError', () => {
  it('settleHoldInvoice names the missing invoicesrpc service instead of throwing a bare TypeError', async () => {
    const svc = makeMockService();
    await expect(svc.settleHoldInvoice('deadbeef')).rejects.toThrow(/invoicesrpc/);
  });

  it('cancelHoldInvoice names the missing invoicesrpc service instead of silently swallowing the failure', async () => {
    // 旧実装は catch 節で再スローしないため、呼び出し元は「キャンセルできた」と誤解し
    // うる可能性があった。ガードはその try/catch より手前で例外を投げ、
    // runActions()（escrow-service.js）の呼び出し側にまで確実に伝播する。
    const svc = makeMockService();
    await expect(svc.cancelHoldInvoice('deadbeef')).rejects.toThrow(/invoicesrpc/);
  });

  it('the guard does not block a client that actually implements the invoicesrpc methods', async () => {
    // 将来 invoicesrpc を正しく読み込んで this.lnd に settleInvoice/cancelInvoice が
    // 生えたら、このガードが false-positive で塞がないことを確認する。
    const svc = makeMockService();
    svc.lnd.settleInvoice = (req, cb) => cb(null, {});
    svc.lnd.cancelInvoice = (req, cb) => cb(null, {});
    await expect(svc.settleHoldInvoice('deadbeef')).resolves.toBeUndefined();
    await expect(svc.cancelHoldInvoice('deadbeef')).resolves.toBeUndefined();
  });

  it('confirms the root cause directly: only lnrpc is loaded, invoicesrpc never is', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../lightning-service.js'), 'utf-8');
    const protoLoadCalls = src.match(/loadPackageDefinition\([^)]*\)\.\w+/g) || [];
    expect(protoLoadCalls.length).toBeGreaterThan(0);
    expect(protoLoadCalls.every((c) => c.endsWith('.lnrpc'))).toBe(true);
    // 実際に proto ファイルを読み込む protoLoader.load(...) の呼び出しに
    // invoices.proto を渡している箇所が無いこと（コメントでの言及は対象外）。
    const loadCalls = src.match(/protoLoader\.load\([^)]*\)/gs) || [];
    expect(loadCalls.length).toBeGreaterThan(0);
    expect(loadCalls.some((c) => /invoices\.proto/.test(c))).toBe(false);
  });
});
