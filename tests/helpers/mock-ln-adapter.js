// src/payments/ln-adapter.js
// Lightning アダプタ・インターフェース（docs/SPECIFICATION.md §6: LN 実機結線）。
// エスクロー(hold invoice)操作を実装非依存の IF に抽象化する。実機は LND/CLN gRPC で
// 実装し、テスト/開発は MockLnAdapter を使う。escrow の actions はこの IF 経由で実行する。
//
// 期待インターフェース（いずれも Promise を返す）:
//   createHoldInvoice({ amountSats, preimageHash, memo, expiry }) -> { paymentRequest, preimageHash, amountSats }
//   settleHoldInvoice(preimage)        -> { settled: true, preimage }      // preimage 公開＝確定
//   cancelHoldInvoice(preimageHash)    -> { canceled: true, preimageHash } // 取消（HTLC失効で返金）
//   payInvoice(paymentRequest, amountSats) -> { paid: true, txid, ... }    // 貸し手等への送金
//   getInfo()                          -> ノード情報

function createMockLnAdapter() {
  const calls = [];
  let seq = 0;
  return {
    calls, // テスト用: 呼び出し履歴 [name, args]
    async createHoldInvoice({ amountSats, preimageHash, memo, expiry } = {}) {
      calls.push(['createHoldInvoice', { amountSats, preimageHash, memo, expiry }]);
      seq += 1;
      return { paymentRequest: `lnbc-mock-${seq}`, preimageHash: preimageHash || `hash-${seq}`, amountSats };
    },
    async settleHoldInvoice(preimage) {
      calls.push(['settleHoldInvoice', { preimage }]);
      return { settled: true, preimage };
    },
    async cancelHoldInvoice(preimageHash) {
      calls.push(['cancelHoldInvoice', { preimageHash }]);
      return { canceled: true, preimageHash };
    },
    async payInvoice(paymentRequest, amountSats) {
      calls.push(['payInvoice', { paymentRequest, amountSats }]);
      seq += 1;
      return { paid: true, paymentRequest, amountSats, txid: `mock-tx-${seq}` };
    },
    async getInfo() {
      return { mock: true, alias: 'StrawberryMockLN' };
    },
  };
}

module.exports = { createMockLnAdapter };
