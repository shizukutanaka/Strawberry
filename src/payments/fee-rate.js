// src/payments/fee-rate.js
// 運営手数料率。**この製品で手数料を語る唯一の場所**。
//
// 以前は `src/api/utils/btc-payment.js` に置かれていた。決済ロジック（src/payments/）が
// HTTP 層のユーティリティ（src/api/utils/）に依存する向きになっており、層の向きが逆だった。
// btc-onchain 経路の削除（2026-09）で btc-payment.js の他の輸出（sendBTC・calcTotalWithFee 等）
// がすべて呼び出し元を失ったため、残った FEE_RATE をここへ移してファイルごと削除した。
//
// 手数料の取り方は**控除式**に一本化されている。借り手は注文の totalPrice を払い、
// 課金確定額から手数料を差し引いた残りがプロバイダの取り分になる
// （`settlement-calculator.computeSettlement`）。削除した btc-onchain 経路だけは
// 上乗せ式（借り手に totalPrice × (1+FEE_RATE) を請求）で、同じ注文が経路によって
// 値段の違うものになっていた。
//
// NaN / 負値 / 1 以上は精算額を壊す（NaN の請求額・手数料 100% 超）。起動時に
// フェイルファストで検出する — 不正な率で 1 件でも精算すると、あとから訂正するのは
// 台帳の adjustment 仕訳が要る手作業になる。
const FEE_RATE = parseFloat(process.env.BTC_FEE_RATE || '0.015');
if (!Number.isFinite(FEE_RATE) || FEE_RATE < 0 || FEE_RATE >= 1) {
  throw new Error(`Invalid BTC_FEE_RATE: "${process.env.BTC_FEE_RATE}". Must be a finite number in [0, 1).`);
}

module.exports = { FEE_RATE };
