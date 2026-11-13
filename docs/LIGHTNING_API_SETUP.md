# Lightning Network 連携ガイド

> **⚠️ ネットワークに関する決定（2026-11-13 明記）**: 本プロジェクトでは **Bitcoin mainnet を有効化しません**。
> 決済は testnet／モックのまま配布します。下記の `LND_MACAROON_PATH` の既定値はコード側で
> mainnet のパスを指していますが、これは既定値が決定に合わせて変更されていないためで、
> 利用する場合は **必ず testnet の macaroon パスと `BITCOIN_NETWORK=testnet` を明示指定**してください。
> なお LND 未接続時はモックにフォールバックし、実際の送金は行われません。

Strawberry の Lightning 連携は2系統あります。混同しやすいため分けて記載します。

## A. 注文エスクローの請求/着金確認 — LND gRPC（既定）

注文支払いの hold invoice 発行・着金確認・キャンセルは **`lightning-service.js` が LND ノードへ gRPC で直接接続**して実行します（REST プロバイダ経由ではありません）。

```env
LND_HOST=127.0.0.1:10009
LND_CERT_PATH=            # 既定: ~/.lnd/tls.cert
LND_MACAROON_PATH=        # 既定: ~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon
LND_PROTO_PATH=           # lnrpc proto のパス（未設定時は mock LND にフォールバック）
```

関連エンドポイント（すべて `/api/v1` 以下、JWT 認証必須）:

- `POST /api/v1/payments/invoice` — 注文の hold invoice 発行
- `POST /api/v1/payments/pay` — invoice の支払い
- `GET  /api/v1/payments/invoice/:id` — 状態照会

## B. オンチェーン決済・利益分配の送金 — REST プロバイダ

`POST /api/v1/payments/btc`（`btc-onchain.js`）による BTC オンチェーン決済、および運営利益・貸し手への送金（`btc-payment.js` → `lightning-api.js`）は **REST API プロバイダ**経由で行います。

```env
LN_PROVIDER=opennode   # 'opennode' または 'lnbits'（コード既定は opennode）
LN_API_KEY=          # プロバイダ発行の API キー
LN_BASE_URL=         # 例: https://api.opennode.com
```

- **OpenNode**: `POST {LN_BASE_URL}/v2/withdrawals`（`Authorization: <key>`、sats 単位）
- **LNbits**: `POST {LN_BASE_URL}/api/v1/payments`（`X-Api-Key: <key>`、`out: true` + bolt11 invoice）

## 運営利益受取アドレス（profit addresses）

`data/profit-addresses.json` は **BTC アドレス文字列の JSON 配列**です（Lightning invoice は受理されません — `isValidBtcAddress` が mainnet/testnet/regtest の P2PKH・P2SH・Bech32/Bech32m のみ許可）。

```json
["bc1q...", "1...", "3..."]
```

管理は専用の管理 API 経由が推奨です（直接ファイル編集も可能ですが、バリデーションを通りません）:

- `GET    /api/profit-addresses` — 一覧
- `POST   /api/profit-addresses` — 追加 `{ "address": "bc1q..." }`
- `DELETE /api/profit-addresses` — 削除 `{ "address": "..." }`

この API は資金フローに直結するため **JWT 認証 + admin ロール + マスター3段階認証（`/master-auth/*` 完了済みセッション）** のすべてを要求します。送金先は登録済み有効アドレスからラウンドロビンで選択されます。

## セキュリティ・運用

- REST プロバイダ経路ではサーバーに秘密鍵を保持しません（資産は外部サービスが管理）。
- 利益アドレス分散で単一アドレス漏洩時の被害を限定できます。
- プロバイダ側の監査ログ・2FA・API キー権限最小化を併用してください。
