# Lightning Network外部API連携ガイド

StrawberryはOpenNode/LNbits/BTCPay Server等のLightning Network決済APIと連携できます。

## 1. サポートAPIプロバイダ
- **OpenNode**: https://opennode.com/
- **LNbits**: https://lnbits.com/
- **BTCPay Server**: https://btcpayserver.org/

## 2. 環境変数設定例
```
LN_PROVIDER=opennode   # または lnbits, btcpay
LN_API_KEY=xxxxx       # プロバイダ発行のAPIキー
LN_BASE_URL=https://api.opennode.com
```

## 3. 利益受取アドレスの登録
- `data/profit-addresses.json` にLightning InvoiceまたはBTCアドレスを配列で記載
- 例:
```
[
  "lnbc1...",   // LN Invoice
  "bc1q..."    // BTCアドレス
]
```

## 4. API仕様
- `/payment` ルートで利益分配・貸し手送金を自動実行
- 送金は外部API経由で実行され、txid等がレスポンスに含まれる

## 5. セキュリティ・運用
- サーバー側で秘密鍵を保持せず、外部サービスで資産管理
- 利益アドレス分散でハッキング耐性向上
- OpenNode等の監査ログ・2FA・API制限も利用可能

---

# Lightning API Integration Guide (English)

Strawberry supports Lightning Network payment APIs such as OpenNode, LNbits, and BTCPay Server.

## 1. Supported Providers
- **OpenNode**: https://opennode.com/
- **LNbits**: https://lnbits.com/
- **BTCPay Server**: https://btcpayserver.org/

## 2. Environment Variables Example
```
LN_PROVIDER=opennode   # or lnbits, btcpay
LN_API_KEY=xxxxx
LN_BASE_URL=https://api.opennode.com
```

## 3. Registering Profit Addresses
- Add Lightning Invoice or BTC addresses to `data/profit-addresses.json` as an array
- Example:
```
[
  "lnbc1...",   // LN Invoice
  "bc1q..."    // BTC address
]
```

## 4. API Usage
- Use the `/payment` route to trigger profit distribution and lender payout
- Payments are processed via external API and txid is returned in the response

## 5. Security & Operations
- No private keys stored on server, funds managed by external provider
- Profit address rotation increases hack resistance
- Use OpenNode audit logs, 2FA, and API restrictions for extra security
