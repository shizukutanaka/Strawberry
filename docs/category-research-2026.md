# Strawberry カテゴリ別 改善点リサーチ（arXiv × GitHub / 2026-06）

Strawberry（P2P GPU マーケットプレイス＋BTC Lightning 決済）を **10カテゴリ**に分け、
各カテゴリにつき **arXiv 論文＋GitHub リポジトリ等を約10件**集約し、コードに紐づく改善点を洗い出す。
`docs/improvement-research-2026.md`（全18領域の横断分析）の姉妹資料で、こちらは**カテゴリ×参照 10×10 のリンク集**。

## 進捗（このループで順次充足）
- [x] 1. 計算検証・Proof-of-Compute（Verifiable Compute / ZKML）
- [x] 2. 決済・エスクロー（Lightning / micropayments / streaming）
- [x] 3. GPU アテステーション・ハードウェア真正性（TEE / Confidential Computing）
- [x] 4. 価格・オークション・マッチング機構
- [x] 5. レピュテーション・ステーキング・Sybil 耐性
- [x] 6. P2P ネットワーク・耐攻撃（libp2p / gossipsub / DHT）
- [x] 7. スケジューリング・中断耐性・チェックポイント（spot / orchestration）
- [x] 8. 推論サービング効率（vLLM / batching / KV cache）
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

## 5. レピュテーション・ステーキング・Sybil 耐性

**Strawberry の現状**: 参加者登録（`src/db/json/UserRepository.js`）に **stake もレピュテーションも無い**。
不正プロバイダ抑止が効かず、Sybil で評価を水増し可能。`src/utils/sla-tracker.js`・`src/api/sla.js` の基盤はあるが信頼度評価に未接続。

### 参照（arXiv / GitHub / 一次情報）
1. arXiv:2603.23793 — AetherWeave: Sybil-Resistant Robust Peer Discovery with Stake — https://arxiv.org/pdf/2603.23793
2. arXiv:1207.2617 — A Review of Techniques to Mitigate Sybil Attacks — https://arxiv.org/pdf/1207.2617
3. arXiv:2507.02951 — Bittensor Protocol: The Bitcoin in Decentralized AI（stake 加重信頼/Yuma）— https://arxiv.org/pdf/2507.02951
4. arXiv:1812.10868 — Detecting Multiple Seller Collusive Shill Bidding — https://arxiv.org/abs/1812.10868
5. arXiv:2506.00282 — Shill Bidding Prevention in Decentralized Auctions Using Smart Contracts（動的ペナルティ）— https://arxiv.org/html/2506.00282v1
6. GitHub: opentensor/bittensor — Yuma 合意・stake 加重信頼・slashing の実装 — https://github.com/opentensor/bittensor
7. Bittensor 論文 — Incentivizing Intelligence（colluding validator は多数決で penalize）— https://ai-secure.github.io/DMLW2022/assets/papers/6.pdf
8. GitHub: akash-network/provider — refundable bid deposit（担保で冷やかし抑止）— https://github.com/akash-network/provider
9. GitHub: gensyn-ai — 検証＋ステーキング前提の分散学習（cross-ref カテゴリ1）— https://github.com/gensyn-ai
10. libp2p gossipsub peer scoring（ネットワーク層のレピュテーション, cross-ref カテゴリ6）— https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md

### 改善点
- (中期) プロバイダに**担保ステーク**を要求し、検証不一致（カテゴリ1）/SLA 違反で **slashing**（Bittensor／Akash の bid deposit 流）。
- (短期) 完了ジョブ・検証結果・SLA（`sla-tracker.js`/`sla.js`）から **stake 加重レピュテーション**を算出し、マッチング（カテゴリ4）の重み付けに使用。
- (中期) **Sybil 耐性**: stake 連動のピア発見（AetherWeave）＋ Ed25519 peerID と GPU attestation（カテゴリ3）の紐付けで身元コスト化。
- (中期) **紛争解決を製品化**: 証跡＝カテゴリ1の検証ログ＋attestation＋§18 アンカリング。

---

## 6. P2P ネットワーク・耐攻撃（libp2p / gossipsub / DHT）

**Strawberry の現状**: `p2p-network.js` は **libp2p が ESM 専用で require 不可のため無効**（`ARCHITECTURE.md`）。
gossip 配信の peer scoring・signed peer records 等のセキュリティ機構が未活用。

### 参照（arXiv / GitHub / 一次情報）
1. arXiv:2310.09193 — Tikuna: An Ethereum Blockchain Network Security Monitoring System — https://arxiv.org/pdf/2310.09193
2. arXiv:1207.2617 — A Review of Techniques to Mitigate Sybil Attacks — https://arxiv.org/pdf/1207.2617
3. GitHub: libp2p/specs — gossipsub v1.1（peer scoring / flood publish / opportunistic graft / outbound quota）— https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md
4. GitHub: libp2p/go-libp2p — Go 実装 — https://github.com/libp2p/go-libp2p
5. GitHub: libp2p/js-libp2p — JS 実装（Strawberry は Node なので主候補）— https://github.com/libp2p/js-libp2p
6. GitHub: libp2p/rust-libp2p — Rust 実装＋security advisory 運用（例: GHSA-gc42-3jg7-rxr2）— https://github.com/libp2p/rust-libp2p
7. GitHub: libp2p/py-libp2p — Python 実装（gossipsub）— https://github.com/libp2p/py-libp2p
8. Least Authority — Gossipsub v1.1 Protocol Design + Implementation Security Audit — https://leastauthority.com/static/publications/LeastAuthority-ProtocolLabs-Gossipsubv1.1-Audit-Report.pdf
9. Protocol Labs — Gossipsub v1.1 Evaluation Report — https://research.protocol.ai/publications/gossipsub-v1.1-evaluation-report/vyzovitis2020.pdf
10. libp2p docs — Security Considerations（DHT Eclipse 対策＝signed peer records を既定有効）— https://docs.libp2p.io/concepts/security/security-considerations/

### 改善点
- (中期) **libp2p ESM 対応**（動的 import ラッパ）で `p2p-network.js` を復活（`src/core/services.js` のガードと整合）。Node 向けは js-libp2p。
- (中期) **gossipsub v1.1 peer scoring** を有効化（Sybil/Eclipse 緩和）→ カテゴリ5 レピュテーションと統合。
- (短期) **signed peer records** を既定有効化（DHT Eclipse 対策）。
- (中期) **Tikuna 流の P2P 層攻撃監視**を `src/core/service-monitor.js`/`src/utils/anomaly-detector.js` に追加。依存（rust/go/js-libp2p）の security advisory を追跡。

---

## 7. スケジューリング・中断耐性・チェックポイント（spot / orchestration）

**Strawberry の現状**: `virtual-gpu-manager.js`＋`src/gpu/gpu-auto-recovery.js` に復旧基盤はあるが、
**preemption 前提の料金ティアもチェックポイント・プロトコルも無い**。注文は固定時間枠（`order/index.js`）のみ。

### 参照（arXiv / GitHub / 一次情報）
1. arXiv:2204.12013 — Bamboo: Making Preemptible Instances Resilient（冗長計算で耐性）— https://arxiv.org/pdf/2204.12013
2. arXiv:2605.17821 — TierCheck: Tiered Checkpointing for Fault Tolerance in LLM Training — https://arxiv.org/html/2605.17821v1
3. arXiv:2310.12670 — Fault-Tolerant Hybrid-Parallel Training with In-memory Checkpointing — https://arxiv.org/pdf/2310.12670
4. arXiv:1911.05160 — Modeling The Temporally Constrained Preemptions of Transient Cloud VMs — https://arxiv.org/pdf/1911.05160
5. GitHub: skypilot-org/skypilot — Managed Jobs（spot preemption/HW 障害から自動復旧、最大70%節約）— https://github.com/skypilot-org/skypilot
6. GitHub: kubernetes-sigs/kueue — K8s ジョブキュー（優先度/preemption ポリシー/Fair Sharing）— https://github.com/kubernetes-sigs/kueue
7. GitHub: volcano-sh/volcano — gang scheduler（PodGroup/preemption/rescheduling）— https://github.com/volcano-sh/volcano
8. GitHub: ray-project/ray — 分散スケジューリング/オーケストレーション — https://github.com/ray-project/ray
9. SkyPilot Docs — Managed Spot Jobs（checkpoint を定期保存し起動時にロード）— https://docs.skypilot.co/en/latest/examples/managed-jobs.html
10. Vast.ai — interruptible（spot）入札（cross-ref カテゴリ4）— https://vast.ai/article/starting-smart-why-spot-gpus-are-ideal-for-ai-startups

### 改善点
- (中期) **中断許容ティア**を価格表へ（カテゴリ4 のオークションと統合）。中断前 30 秒通知 → **三層チェックポイント退避**（TierCheck 流）→ 別プロバイダへ自動再スケジュール（`gpu-auto-recovery.js` を拡張）。
- (中期) **SkyPilot Managed Jobs 風のジョブ層**（起動時 checkpoint ロード）を採用 or 連携。
- (中期) k8s 経路（`virtual-gpu-manager`）では **Volcano/Kueue** で gang scheduling・preemption・rescheduling。
- (短期) SLA（`src/api/sla.js`）に**中断率・復旧時間**を記録し、カテゴリ5 レピュテーションへ反映。

---

## 8. 推論サービング効率（vLLM / batching / KV cache）

**Strawberry の現状**: **素の GPU 時間**を貸すだけ（`virtual-gpu-manager.js`）で推論最適化レイヤが無く、$/token 競争力が低い。
§13/カテゴリ4 のサーバーレス推論ティアを作るなら性能の肝。

### 参照（arXiv / GitHub / 一次情報）
1. arXiv:2510.14392 — FairBatching: Fairness-Aware Batch Formation for LLM Inference — https://arxiv.org/html/2510.14392v1
2. arXiv:2412.03594 — BatchLLM: Global Prefix Sharing + Throughput-oriented Token Batching — https://arxiv.org/html/2412.03594v1
3. arXiv:2405.04437 — vAttention: Dynamic Memory Management for Serving LLMs — https://arxiv.org/html/2405.04437v2
4. arXiv:2412.04504 — Multi-Bin Batching for Increasing LLM Inference Throughput — https://arxiv.org/pdf/2412.04504
5. arXiv:2511.17593 — Comparative Analysis of LLM Inference Serving: vLLM vs HuggingFace TGI — https://arxiv.org/html/2511.17593v1
6. GitHub: vllm-project/vllm — PagedAttention＋continuous batching（OpenAI 互換）— https://github.com/vllm-project/vllm
7. GitHub: sgl-project/sglang — RadixAttention（prefix 再利用、RAG/agent に強い）— https://github.com/sgl-project/sglang
8. GitHub: NVIDIA/TensorRT-LLM — kernel fusion／FP8 量子化／マルチGPU — https://github.com/NVIDIA/TensorRT-LLM
9. GitHub: huggingface/text-generation-inference — TGI 推論サーバ — https://github.com/huggingface/text-generation-inference
10. GitHub: ray-project/ray（Ray Serve）/ kserve/kserve — モデルサービング基盤 — https://github.com/kserve/kserve

### 改善点
- (中期) §13/カテゴリ4 の**サーバーレス推論ティアを vLLM（PagedAttention＋continuous batching）**で実装し、プロバイダのコンテナイメージに最適化サービングを同梱。
- (中期) 共有プレフィックスの多いワークロード（チャット/RAG/agent）は **SGLang（RadixAttention）**を選択肢に。
- (中期) **トークン単位課金**（カテゴリ2 ストリーミング・マイクロペイメント）と統合し、実消費メータリング。
- (短期) `src/utils/ai-benchmark.js` を推論スループット（tokens/s, TTFT）でも測り、カテゴリ12 のホスト信頼性スコアへ。

---

<!-- 以降 カテゴリ 9〜10 はループの後続イテレーションで追記 -->
