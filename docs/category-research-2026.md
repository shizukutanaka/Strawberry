# Strawberry カテゴリ別 改善点リサーチ（arXiv × GitHub / 2026-06）

Strawberry（P2P GPU マーケットプレイス＋BTC Lightning 決済）を **10カテゴリ**に分け、
各カテゴリにつき **arXiv 論文＋GitHub リポジトリ等を約10件**集約し、コードに紐づく改善点を洗い出す。
`docs/improvement-research-2026.md`（全18領域の横断分析）の姉妹資料で、こちらは**カテゴリ×参照 10×10 のリンク集**。

## 進捗（このループで順次充足）
- [x] 1. 計算検証・Proof-of-Compute（Verifiable Compute / ZKML）
- [x] 2. 決済・エスクロー（Lightning / micropayments / streaming）
- [ ] 3. GPU アテステーション・ハードウェア真正性（TEE / Confidential Computing）
- [ ] 4. 価格・オークション・マッチング機構
- [ ] 5. レピュテーション・ステーキング・Sybil 耐性
- [ ] 6. P2P ネットワーク・耐攻撃（libp2p / gossipsub / DHT）
- [ ] 7. スケジューリング・中断耐性・チェックポイント（spot / orchestration）
- [ ] 8. 推論サービング効率（vLLM / batching / KV cache）
- [ ] 9. 分散学習・フェデレーテッド・機密性（DiLoCo / secure aggregation / DP）
- [ ] 10. 運用・可観測性・データ層・持続可能性（observability / DB / carbon / audit anchoring）

---

## 1. 計算検証・Proof-of-Compute（Verifiable Compute / ZKML）

**Strawberry の現状**: 借りた GPU が実際に計算したかを検証する仕組みが皆無
（`src/api/routes/order/index.js`, `virtual-gpu-manager.js`）。最優先課題。

### 参照（arXiv / GitHub）
1. arXiv:2501.05374 — Validation of GPU Computation in Decentralized, Trustless Networks（再計算/TEE/FHE の限界、profiling・ternary consensus）— https://arxiv.org/abs/2501.05374
2. arXiv:2408.07177 — V3rified: Revelation vs Non-Revelation Mechanisms for Decentralized Verifiable Computation — https://arxiv.org/pdf/2408.07177
3. arXiv:2403.09603 — Optimistic Verifiable Training by Controlling Hardware Nondeterminism — https://arxiv.org/html/2403.09603v3
4. arXiv:2208.03567 — Proof-of-Learning is Currently More Broken Than You Think（PoL は spoof 可能）— https://arxiv.org/pdf/2208.03567
5. arXiv:2502.18535 — A Survey of Zero-Knowledge Proof Based Verifiable Machine Learning — https://arxiv.org/abs/2502.18535
6. arXiv:2412.10537 — VerifiableFL: Verifiable Claims for Federated Learning using Exclaves — https://arxiv.org/pdf/2412.10537
7. GitHub: zkonduit/ezkl — ONNX → zk-SNARK でモデル推論を検証（ZKML エンジン）— https://github.com/zkonduit/ezkl
8. GitHub: risc0/risc0 — 汎用 zkVM（推論コードを RISC-V で証明実行）— https://github.com/risc0/risc0
9. GitHub: succinctlabs/sp1 — zkVM（マルチGPU proving、クラウド/ベアメタル）— https://github.com/succinctlabs/sp1
10. GitHub: worldcoin/awesome-zkml — ZKML 実装の集約（EZKL/RISC Zero/Modulus 等）— https://github.com/worldcoin/awesome-zkml
   （補: Gensyn — 検証付き分散学習 https://github.com/gensyn-ai ）

### 改善点
- (短期) **ランダム再実行監査**: 一定確率で同一ジョブを別プロバイダへ再投入し出力照合（2501.05374 の ternary consensus 簡易版）。不一致は §5 スラッシングへ。
- (短期) **GPU profiling 突合**: 実行中の利用率/温度/メモリ（`src/gpu/gpu-metrics.js`）と課金実態を突き合わせ、ゼロ負荷課金を検出。
- (中期) **楽観的検証**（2403.09603）: 通常は受理、チャレンジ時のみ再計算。固定シード・決定論カーネルで非決定性を制御（`virtual-gpu-manager` 実行環境に組込）。
- (重要) **PoL 単体に依存しない**（2208.03567）。TEE（カテゴリ3）＋ウォーターマーク＋楽観的検証の多層。
- (長期) **ZKML**（ezkl/risc0/sp1）で検証可能推論をプレミアム属性に。検証結果を §5 レピュテーションへ接続。

---

## 2. 決済・エスクロー（Lightning / micropayments / streaming）

**Strawberry の現状**: `src/api/utils/btc-payment.js` の `sendBTC` を `src/api/routes/payment.js` が
**二段で直接送金**するだけ。エスクロー無し（前払い未提供リスク／未払いリスク）。`src/api/utils/lightning-api.js`
は薄いラッパで hold invoice 等の条件付き決済が無い。

### 参照（arXiv / GitHub / 一次情報）
1. Lightning Hold (hodl) Invoice 解説（Voltage）— 受取側が preimage 保持で確定保留＝プログラム可能エスクロー — https://voltage.cloud/blog/understanding-hold-invoices-on-the-lightning-network
2. Hold Invoices（ION Lightning Wiki）— https://wiki.ion.radar.tech/tech/research/hodl-invoice
3. Hashed-Timelock Agreements（Interledger RFC）— HTLA による条件付き決済 — https://interledger.org/developers/rfcs/hashed-timelock-agreements/
4. GitHub: lightningnetwork/lnd — LND（gRPC で hold invoice/AddHoldInvoice 対応）— https://github.com/lightningnetwork/lnd
5. GitHub: ElementsProject/lightning — Core Lightning(CLN)、hold invoice プラグイン — https://github.com/ElementsProject/lightning
6. GitHub: BoltzExchange/boltz-backend — submarine swap（on/off-chain HTLC エスクロー）＋CLN hold invoice plugin — https://github.com/BoltzExchange/boltz-backend
7. GitHub: getAlby/js-sdk — Alby/NWC（Nostr Wallet Connect）決済 SDK — https://github.com/getAlby/js-sdk
8. GitHub: lnbits/lnbits — Lightning アカウンティング/拡張（マルチウォレット）— https://github.com/lnbits/lnbits
9. GitHub: btcpayserver/btcpayserver — セルフホスト決済（LN 連携の運用参考）— https://github.com/btcpayserver/btcpayserver
10. GitHub: lightning/bolts — Lightning 仕様（BOLT11/12 invoice/offers）— https://github.com/lightning/bolts
   （補: lightninglabs/loop — on/off-chain 流動性 https://github.com/lightninglabs/loop ）

### 改善点
- (中期) **hold invoice でエスクロー化**: 注文時に借り手が前払いをロック、稼働実績（カテゴリ1の profiling）/時間で段階 settle、未提供は preimage 非開示でタイムロック失効（LND/CLN、Boltz の CLN plugin 参考）。`lightning-api.js` を LND/CLN gRPC 実装へ置換。
- (短期) `btc-payment.js` の二段直接送金 → **条件付き解放のエスクロー**へ。既存 `payment_partial_settlement` 監査ログ（実装済）＋自動リトライキュー。
- (中期) **ストリーミング・マイクロペイメント**（秒/トークン課金）で実消費メータリング（カテゴリ8と統合）。
- (中期) **submarine swap**（Boltz）で貸し手の on-chain 出金を非カストディアルに。
- (中期) **BOLT12 offers** で再利用可能な受取（運営/貸し手のアドレス露出を低減、profit-addresses と統合）。

---

<!-- 以降 カテゴリ 3〜10 はループの後続イテレーションで追記 -->
