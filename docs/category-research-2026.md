# Strawberry カテゴリ別 改善点リサーチ（arXiv × GitHub / 2026-06）

Strawberry（P2P GPU マーケットプレイス＋BTC Lightning 決済）を **10カテゴリ**に分け、
各カテゴリにつき **arXiv 論文＋GitHub リポジトリ等を約10件**集約し、コードに紐づく改善点を洗い出す。
`docs/improvement-research-2026.md`（全18領域の横断分析）の姉妹資料で、こちらは**カテゴリ×参照 10×10 のリンク集**。

## 進捗（このループで順次充足）
- [x] 1. 計算検証・Proof-of-Compute（Verifiable Compute / ZKML）
- [x] 2. 決済・エスクロー（Lightning / micropayments / streaming）
- [x] 3. GPU アテステーション・ハードウェア真正性（TEE / Confidential Computing）
- [x] 4. 価格・オークション・マッチング機構
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

## 3. GPU アテステーション・ハードウェア真正性（TEE / Confidential Computing）

**Strawberry の現状**: GPU 種別/性能は `src/core/gpu-detector-extended.js` が `nvidia-smi`/`lspci` の
**自己申告を読むだけ**＝安価な GPU を高級機と詐称して高値で貸せる。真正性検証が無い。

### 参照（arXiv / GitHub / 一次情報）
1. arXiv:2409.03992 — Confidential Computing on NVIDIA H100 GPU: A Performance Benchmark Study — https://arxiv.org/html/2409.03992v1
2. arXiv:2501.05374 — （DePIN: 仮想化層が「実ハードが実仕事をした」検証鎖を壊す論点）— https://arxiv.org/abs/2501.05374
3. GitHub: NVIDIA/nvtrust — NVIDIA GPU 機密計算の補助OSS（Attestation SDK 一式）— https://github.com/NVIDIA/nvtrust
4. GitHub: NVIDIA/nvtrust（Local GPU Verifier）— 実行時計測を golden measurements と照合し HW/SW 状態を検証 — https://github.com/NVIDIA/nvtrust/blob/main/guest_tools/gpu_verifiers/local_gpu_verifier/README.md
5. GitHub: NVIDIA/nvtrust（Attestation SDK）— local/remote 証明（H100 以降の CC 対応）— https://github.com/NVIDIA/nvtrust/tree/main/guest_tools/attestation_sdk
6. GitHub: confidentsecurity/go-nvtrust — nvtrust の Go 実装 — https://github.com/confidentsecurity/go-nvtrust
7. GitHub: confidential-containers/confidential-containers — CoCo（GPU 機密コンテナ統合）— https://github.com/confidential-containers/confidential-containers
8. GitHub Issue: confidential-containers/guest-components #550 — NVIDIA GPU local/remote attestation 追加 — https://github.com/confidential-containers/guest-components/issues/550
9. NVIDIA Technical Blog — Confidential Computing on H100（リモート・アテステーション・レポート）— https://developer.nvidia.com/blog/confidential-computing-on-h100-gpus-for-secure-and-trustworthy-ai/
10. Intel Trust Authority — GPU Remote Attestation（composite: TDX + H100）— https://docs.trustauthority.intel.com/main/articles/articles/ita/concept-gpu-attestation.html

### 改善点
- (中期) 出品登録時に **nvtrust Local GPU Verifier / Attestation SDK** で GPU の attestation report を検証し、**真正性確認後にのみマッチング**（`gpu-detector-extended.js` の自己申告に依存しない）。
- (短期) 署名付きベンチ（`src/utils/ai-benchmark.js`）と申告スペックの**乖離スコア**化（attestation 非対応機の暫定策）。
- (中期) **Ed25519 peerID（README 記載）と GPU attestation を紐付け**、ハード単位の身元を確立（§5 レピュテーション/§6 P2P と統合）。
- (中期) 機密実行は **CoCo + Kata + GPU CC モード**（カテゴリ7 実行隔離と統合）。

---

## 4. 価格・オークション・マッチング機構

**Strawberry の現状**: `src/api/routes/order/index.js` は `pricePerHour / 12` のフラット課金のみ。
`src/core/dynamic-pricing-engine-fixed.js` / `market-pricing-engine.js` は**孤立（未配線）**で需給・特性・時間帯を反映しない。GPU 時間は腐敗性財なのに在庫最適化が無い。

### 参照（arXiv / GitHub / 一次情報）
1. arXiv:2510.05111 — Agora: Bridging the GPU Cloud Resource-Price Disconnect（特徴量ベース価格）— https://arxiv.org/abs/2510.05111
2. arXiv:1804.09961 — Auction Mechanisms in Cloud/Fog Computing Resource Allocation — https://arxiv.org/abs/1804.09961
3. arXiv:2209.07035 — Online Combinatorial Auctions with Supply Costs and Capacity Limits — https://arxiv.org/pdf/2209.07035
4. arXiv:2511.16357 — Automated Market Making for Goods with Perishable Utility（=GPU 時間）— https://arxiv.org/pdf/2511.16357
5. arXiv:2403.20151 — A Learning-based Incentive Mechanism for Mobile AIGC — https://arxiv.org/pdf/2403.20151
6. GitHub: akash-network/node — 逆オークション/オンチェーン決済（Apache-2.0）— https://github.com/akash-network/node
7. GitHub: akash-network/provider — プロバイダ daemon（自動入札・refundable bid deposit）— https://github.com/akash-network/provider
8. Akash 公式 — 逆オークションで価格決定（透明なオンチェーン入札/リース）— https://akash.network/
9. Vast.ai — interruptible（spot）を**入札制**で最大80%安 — https://vast.ai/article/starting-smart-why-spot-gpus-are-ideal-for-ai-startups
10. Hyperbolic — GPU Marketplace Landscape（価格競争の俯瞰）— https://www.hyperbolic.ai/blog/gpu-marketplace-landscape

### 改善点
- (短期) 孤立 pricing engine（`dynamic-pricing-engine-fixed.js`/`market-pricing-engine.js`）を**マッチングへ配線**し、**特徴量ベース価格**（VRAM/世代/帯域/実ベンチ, Agora 流）で算出。
- (中期) **逆オークション/ダブルオークション**（Akash node/provider 参考, arXiv:1804.09961）。**refundable bid deposit** で冷やかし抑止（§5 stake と連携）。
- (中期) **腐敗性財 AMM**（arXiv:2511.16357）で空き GPU 時間を動的値下げ・在庫消化。
- (中期) 入札・約定ログを §18 の監査アンカリングで改ざん耐性化、§17 のシル入札検知と対で導入。

<!-- 以降 カテゴリ 5〜10 はループの後続イテレーションで追記 -->
