# Lightning 連携ガイド

Strawberry の決済は **LND への直接 gRPC 接続** 1 本である（`lightning-service.js`）。
インボイス発行・入金確認・チャネル管理はすべてここを通る。

> **2026-09 の訂正**: このドキュメントは以前「OpenNode / LNbits / BTCPay Server と連携できる」
> と書いていた。それを実装していたのは `src/api/utils/lightning-api.js` で、その唯一の
> 呼び出し元は削除済みのオンチェーン BTC 決済経路（`payment/btc-onchain.js`）だけだった。
> 経路の削除に伴い実装ごと消えたため、記述を実態に合わせた。
> `LN_PROVIDER` / `LN_API_KEY` / `LN_BASE_URL` を設定しても**何も起きない**（読む側が無い）。

## 1. 環境変数

| 変数 | 既定 | 用途 |
|---|---|---|
| `LND_HOST` | `localhost:10009` | LND の gRPC エンドポイント |
| `LND_CERT_PATH` | `~/.lnd/tls.cert` | TLS 証明書 |
| `LND_MACAROON_PATH` | `~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon` | 認証マカロン |
| `LND_PROTO_PATH` | 同梱 `proto/lightning.proto` | gRPC 定義 |
| `BITCOIN_NETWORK` | `mainnet` | `mainnet` / `testnet` |
| `LIGHTNING_MOCK` | 未設定 | `1` でモックノード。**開発時のみ** |

`NODE_ENV=test` でもモックになる（テストは実 LND を持たないため）。
**本番でモックを有効にしてはならない。** 決済していないのに決済したと信じるサービスができる。
LND に繋がらない本番環境では決済 API が 503 を返すのが正しい挙動で、
`src/core/services.js` の `requireService()` がそれを保証している。

## 2. 資金の流れ（カストディアル）

```
借り手 ──(LND invoice)──▶ 運営ノード ──▶ 収益台帳に計上 ──▶ 出金申請 ──▶ 運営が送金 + txid 記録
                                        payout-ledger.js            completePayout()
```

- 借り手の支払いは**運営ノードに着金する**。運営が他人の金を預かる構造であり、これは隠していない。
- プロバイダの取り分・借り手への返金は `src/payments/payout-ledger.js` の仕訳になる。
  残高は保存せず仕訳の合計から導出する。
- 出金の確定は `POST /payments/admin/payouts/:id/complete` の一本で、2 つの使い方がある。
  - `{ txid }` … 運営が自分のノード/ウォレットから送り、証跡だけ記録する
  - `{ paymentRequest }` … その BOLT11 をサーバが LND 経由で払い、実 payment hash を記録する。
    送金前にインボイス額が申請額以下であることを確認し、送金と台帳の確定を同じロックの中で行う
- **これがコードベースで唯一、外部へ資金が出ていく経路である。** 出金申請の行に束縛されて
  いるので、金が動けば必ず台帳に残る。以前は `POST /payment` と `POST /payments/pay` という
  生の BOLT11 パススルーが 2 本あり、admin 限定ではあったが**送金しても台帳の payout 行を
  書かなかった**——送っても残高が減らないので、プロバイダは同じ額をもう一度申請できた。
  2026-09 に削除した。
- この性質は `tests/payments/no-unledgered-money.test.js` が機械的に見張る。
  検査は「送金しそうなメソッド名の一覧」を手で持たず、**ソースから導出する**
  （最初の版は手で並べたので、生きていた上記 2 本を見逃した）。

## 3. 受取アドレスの登録

`data/profit-addresses.json`（運営の受取先）は `/api/profit-addresses` から管理する。
形式検証は `src/api/utils/profit-addresses.js` の `isValidBtcAddress()`。

プロバイダ・借り手の送金先は各ユーザーの `payoutAddress`（`PUT /users/me`）で、
出金申請は**必ずサーバ側が保持するこの値**を使う。リクエストボディの送金先は受け付けない
（受け付けると、トークンを盗んだ攻撃者が送金先だけ差し替えて資金を抜ける）。

## 4. 決済 API

| エンドポイント | 用途 |
|---|---|
| `POST /api/v1/payments/order/:orderId` | 注文の支払い（インボイス発行 / 手動決済の申請） |
| `GET /api/v1/payments/:id/status` | 支払い状態の確認 |
| `GET /api/v1/payments/admin/reconciliation` | 帳簿の突き合わせ（4 つの不変条件） |

入金の確定は `src/core/invoice-poller.js` が LND へ問い合わせて行う。

注文に紐づかない汎用インボイス発行（旧 `POST /api/v1/payments/invoice`、admin 限定）は
2026-09 に削除した。以前の版はこの経路の入金が `unattributedPaidSats` に現れると書いて
いたが、実際にはこのルートは `PaymentRepository` に行を書かず、支払われても**どの記録
にも残らない**入金を作っていた。台帳が見ている決済は注文経由の 1 本だけである。

---

# Lightning Integration Guide (English)

Payments go through **a direct gRPC connection to LND** (`lightning-service.js`). There is no
OpenNode / LNbits / BTCPay HTTP integration — the module that provided one
(`src/api/utils/lightning-api.js`) was removed in 2026-09 together with its only caller, the
on-chain BTC payment route. `LN_PROVIDER` / `LN_API_KEY` / `LN_BASE_URL` are no longer read.

## Environment

`LND_HOST`, `LND_CERT_PATH`, `LND_MACAROON_PATH`, `LND_PROTO_PATH`, `BITCOIN_NETWORK`.
`LIGHTNING_MOCK=1` enables a mock node — development only. Never in production: a mocked node
believes it settled payments it never made. Without a reachable LND the payment API returns 503,
which is the correct behaviour.

## Custodial flow

Renter pays an LND invoice held by the operator. Provider earnings and renter refunds are
recorded as ledger entries (`src/payments/payout-ledger.js`); balances are derived from entries,
never stored. A payout is settled through `POST /payments/admin/payouts/:id/complete`, either by
recording a `txid` the operator sent out-of-band or by handing it a `paymentRequest` the server
pays over LND. That handler is the **only** outbound payment site in the codebase, and it cannot
run without a requested payout row — so money that moves always leaves a ledger entry. Enforced
by `tests/payments/no-unledgered-money.test.js`, which derives the send-method call sites from
source rather than keeping a hand-written list.
