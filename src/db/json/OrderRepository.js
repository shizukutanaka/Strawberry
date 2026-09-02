// ファイルベースJSONストレージによる注文リポジトリ
const { createJsonRepository } = require('./createJsonRepository');
const { isTerminalOrderStatus } = require('../../orders/order-status');

module.exports = createJsonRepository('orders.json', {
  finders: {
    getByUserId: { field: 'userId', many: true },
  },
  // 終わった注文は接続情報（SSH 鍵・パスワード・トークン）を持たない。
  //
  // これは以前、終端へ遷移させる各所で `accessDelivery: null` を書いて守っていた。
  // 守れていたのは 8 経路中 3 本だけで、SLA 違反による自動終了・係争の裁定（返金/棄却）・
  // 期限切れ active 注文の失効・係争の自動裁定の 5 本は、レンタルが終わったあとも
  // 暗号化された認証情報を data/orders.json に残し続けていた。保持期間が長いほど
  // ファイル流出時の被害が広がるうえ、6 本目の終端経路を足す人がまた忘れる。
  //
  // 「消し忘れないように気をつける」ではなく「終端状態の注文には書けない」形にする。
  // 復号鍵は残り続けるので、平文が漏れるわけではない。だが**そもそも持たない**のが
  // 一番安全であるという access-delivery.js の設計判断を、ここで構造的に保証する。
  beforeWrite: (row) => {
    if (row && row.accessDelivery && isTerminalOrderStatus(row.status)) {
      return { ...row, accessDelivery: null };
    }
    return row;
  },
});
