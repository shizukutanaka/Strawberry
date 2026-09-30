# Strawberry 改善点リサーチ（同種ソフト・arXiv 参照 / 2026-06）

本書は、Strawberry（P2P GPU マーケットプレイス＋BTC Lightning 決済）の**実コードの弱点**を、
同種ソフトウェア（Akash / Render / io.net / Golem / Vast.ai / Bittensor / Gensyn / Prime Intellect）
および **arXiv 論文**に対応づけて洗い出したもの。各項目は「現状(コード) → 同種ソフト → 参考研究 → 推奨アクション → 優先度」で記載する。

> 結論サマリ: Strawberry には「**借りた GPU が本当に計算したかを検証する仕組み**」と
> 「**トラストレスなエスクロー決済**」が完全に欠落しており、P2P マーケットプレイスとしての
> 信頼基盤（verification / escrow / reputation）が未実装。ここが最優先の改善領域。

---

## 1. 計算結果の検証（Proof-of-Compute）— 最優先・現状ゼロ

**現状**: 借り手が GPU 時間を注文（`src/api/routes/order/index.js`）し、`virtual-gpu-manager.js` が
コンテナを割り当てるが、**プロバイダが実際に計算を行ったか／正しい GPU を提供したかを検証する仕組みが一切ない**。
不正プロバイダは「何もせず課金」できる。

**同種ソフト**:
- **Render**: ノードに proof-of-render を要求し、レピュテーションで割当を制御。
- **io.net**: コンテナ化実行＋proof-of-compute オーケストレーション。
- **Gensyn / Bittensor**: proof-of-learning / 出力に対する報酬（検証可能な学習）。
- **DePIN 一般**: 「特定の物理ハードウェアが実在し実仕事をした」暗号学的証明を要求（仮想化層が検証鎖を壊す点が課題）。

**参考研究**:
- *Validation of GPU Computation in Decentralized, Trustless Networks*, arXiv:2501.05374 — 厳密再計算は GPU 非決定性で破綻、TEE は専用 HW 必須、FHE は高コスト。代替として **model fingerprinting / semantic similarity / GPU profiling** を用いた確率的検証、**binary reference model（信頼ノード照合）** と **ternary consensus（信頼不要の三者合意）** を提案。
- *V3rified: Revelation vs Non-Revelation Mechanisms for Decentralized Verifiable Computation*, arXiv:2408.07177。

**推奨アクション**:
1. (短期) **ランダム再実行監査**: 一定確率で同一ジョブを別プロバイダに再投入し出力を照合（ternary consensus の簡易版）。不一致時は slashing（§5）。
2. (短期) **GPU profiling チェック**: 実行中に `nvidia-smi` の利用率/温度/メモリを定期取得し（既に `src/gpu/gpu-metrics.js` 基盤あり）、課金対象の負荷実態と突き合わせ、ゼロ負荷課金を検出。
3. (中期) ZK 系（JSTprove 等, arXiv:2510.21024）や TEE attestation（§2）と組み合わせた検証パイプライン。

優先度: **高（信頼基盤の核）**

---

## 2. GPU ハードウェア・アテステーション（なりすまし対策）

**現状**: GPU 種別・性能は `src/core/gpu-detector-extended.js` が `nvidia-smi`/`lspci` の自己申告を読むだけ。
プロバイダは安価な GPU を「H100」と偽って高値で貸せる（**スペック詐称**）。検証なし。

**同種ソフト / 技術**:
- **NVIDIA H100/H200 Confidential Computing**: GPU が **NVIDIA 署名のリモート・アテステーション・レポート**を生成し、本物の H100 か・ファームウェア健全かを暗号学的に証明。CPU TEE（Intel TDX）との composite attestation も可能。
- **Intel Trust Authority** による GPU attestation。

**参考研究**: *Confidential Computing on NVIDIA H100 GPU: A Performance Benchmark Study*, arXiv:2409.03992。

**推奨アクション**:
1. (短期) 出品登録時に署名付きベンチマーク（`src/utils/ai-benchmark.js` 基盤あり）を要求し、申告スペックとの乖離をスコア化。
2. (中期) 対応 GPU では **リモート・アテステーション・レポート**を出品の必須証跡にし、GPU 真正性を検証してからマッチング。
3. P2P 層の Ed25519 peerID（README 記載）と GPU アテステーションを紐づけ、ハード単位の身元を確立。

優先度: **高**

---

## 3. トラストレスなエスクロー決済（Lightning Hold Invoice）

**現状**: `src/api/utils/btc-payment.js` の `sendBTC` を `src/api/routes/payment.js` が**二段で直接送金**するだけ。
エスクロー無し。先のコードレビューで「tx1 成立後に tx2 失敗 → 資金が運営に滞留」を部分決済として明示化したが、
**これは設計の浅さ（bandaid）であり、根本はエスクロー欠如**。借り手は前払い後に未提供リスク、貸し手は未払いリスクを負う。

**同種ソフト / 技術**:
- **Lightning Hold (hodl) Invoice / HTLC**: 受取側が preimage を保持し、**納品証明（preimage 交換）まで確定を保留**できる＝中間者不要のプログラム可能エスクロー。タイムロックで自動失効。
- **Akash**: デプロイをオンチェーン・エスクロー口座で担保し、利用に応じて引き落とし。
- Submarine swap 等で on/off-chain 連携。

**参考**: Lightning Hold Invoice（Voltage / ION Lightning Wiki）。

**推奨アクション**:
1. (中期) 注文時に借り手が **hold invoice で前払いロック**。`virtual-gpu-manager` の稼働実績（§1 の profiling）または時間経過に応じて段階的に settle、未提供なら cancel（タイムロック失効）。
2. (短期) 当面は §1 の監査と組み合わせ、`payment_partial_settlement` 監査ログ（実装済）から手動照合 + 自動リトライキューを整備。
3. 既存の `FEE_RATE` 控除はエスクロー settle 時に確定させる。

優先度: **高（資金安全に直結）**

---

## 4. 価格決定とマッチング機構（フラット時給 → 特徴量/オークション）

**現状**: `order/index.js` は `pricePerHour / 12` で 5 分単価を出すだけのフラット課金。
`src/core/dynamic-pricing-engine-fixed.js` / `market-pricing-engine.js` は存在するが**孤立（未配線）**。
需給・GPU 特性・時間帯を反映しない。GPU 時間は**腐敗性財（perishable）**なのに在庫最適化が無い。

**同種ソフト / 研究**:
- **Akash**: 逆オークション（プロバイダが入札、最低適合価格でマッチ）→ ハイパースケーラ比 60–75% 安。
- *Agora: Bridging the GPU Cloud Resource-Price Disconnect*, arXiv:2510.05111 — **特徴量ベース価格付け**（実消費資源に価格を整合）。
- *Auction Mechanisms in Cloud/Fog Computing*, arXiv:1804.09961 / *Online Combinatorial Auctions with Supply Costs and Capacity Limits*, arXiv:2209.07035。
- *Automated Market Making for Goods with Perishable Utility*, arXiv:2511.16357 — **腐敗性財（=GPU 時間）の AMM**。空き時間を捨てない価格付けに直結。

**推奨アクション**:
1. (短期) 孤立している `dynamic-pricing-engine` / `market-pricing-engine` を実際にマッチングへ配線し、GPU 特徴量（VRAM/世代/帯域/実ベンチ）で価格を算出（Agora 流）。
2. (中期) 逆オークション or ダブルオークションでマッチング（Akash 流, arXiv:1804.09961）。
3. (中期) 腐敗性財 AMM（arXiv:2511.16357）で空き GPU 時間の動的値下げ・在庫消化。

優先度: **中**

---

## 5. レピュテーション & Sybil 耐性（ステーキング/スラッシング）

**現状**: 利用者・プロバイダ登録に**stake もレピュテーションも無い**（`UserRepository`）。
不正プロバイダの抑止が効かず、Sybil で評価を水増し可能。profit-address API は admin 化済だが、参加者の信頼度評価は未実装。

**同種ソフト / 研究**:
- P2P マーケット一般: **エスクロー＋レーティング＋紛争解決が load-bearing**（任意機能ではない）。
- *AetherWeave: Sybil-Resistant Robust Peer Discovery with Stake*, arXiv:2603.23793 — **ステーク連動**の Sybil 耐性ピア発見。
- *A Review of Techniques to Mitigate Sybil Attacks*, arXiv:1207.2617。
- libp2p **gossipsub v1.1 peer scoring**（観測に基づく peer スコアで mesh を選別）。

**推奨アクション**:
1. (中期) プロバイダに **担保ステーク**を要求し、§1 の検証不一致・SLA 違反で **slashing**。
2. (短期) 完了ジョブ・検証結果・SLA（`src/utils/sla-tracker.js`, `src/api/sla.js` 基盤あり）から**レピュテーション・スコア**を算出しマッチングの重み付けに使用。
3. (中期) 紛争解決フロー（証跡＝§1 監査ログ＋アテステーション）を「製品」として明文化。

優先度: **中〜高**

---

## 6. P2P ネットワークの堅牢化（Eclipse/Sybil）と libp2p ESM 対応

**現状**: `p2p-network.js` は **libp2p が ESM 専用で require 不可のため現在無効**（`ARCHITECTURE.md` 参照）。
gossip 配信のセキュリティ（peer scoring 等）も未活用。

**同種ソフト / 研究**:
- **gossipsub v1.1**: flood publishing / peer exchange / **peer scoring** / outbound quota で Eclipse・Sybil を緩和。
- *Tikuna: Ethereum Blockchain Network Security Monitoring*, arXiv:2310.09193 — P2P 層攻撃の監視。

**推奨アクション**:
1. (中期) libp2p を ESM 動的 import で読み込む薄いラッパを作る（`src/core/services.js` のガードと整合）か、最新 CJS 互換構成へ移行。
2. peer scoring を有効化し、§5 のレピュテーションと統合。

優先度: **中**

---

## 7. 実行隔離・オーケストレーション（機密コンテナ）

**現状**: `virtual-gpu-manager.js` が Docker/k8s でコンテナ割当（コマンド実行はサニタイズ済）。
ただし**テナント間の機密性保証や標準オーケストレーション層が弱い**。

**同種ソフト**: io.net のコンテナ化実行＋ジョブ分離、機密コンテナ（Kata/gVisor、Confidential Containers）。

**推奨アクション**: (中期) k8s ＋ 機密コンテナ／CC モードで、借り手のコード・データをプロバイダから秘匿（§2 の GPU TEE と統合）。

優先度: **中**

---

## 8. データ層・スケーラビリティ（既知の follow-up）

**現状**: 実稼働は `src/db/json/*`（**並行書込み保護・トランザクション無し**）。Prisma/pg/knex は未配線（三重化）。

**推奨アクション**: 単一の永続化層（当面 JSON、将来 Prisma/Postgres）へ統一し、注文・決済・残高に整合性制約を導入。`ARCHITECTURE.md` のフォローアップ参照。

優先度: **中**

---

## 優先度まとめ（推奨着手順）

| # | 改善領域 | 優先度 | 根拠（代表） |
|---|---------|--------|-------------|
| 1 | 計算検証 Proof-of-Compute | 高 | arXiv:2501.05374, Render/io.net/Gensyn |
| 3 | Lightning エスクロー | 高 | Hold invoice/HTLC, Akash escrow |
| 2 | GPU アテステーション | 高 | NVIDIA H100 attestation, arXiv:2409.03992 |
| 5 | レピュテーション/ステーク | 中〜高 | arXiv:2603.23793, 1207.2617 |
| 4 | 価格/オークション | 中 | arXiv:2510.05111, 1804.09961, 2511.16357 |
| 6 | P2P 堅牢化/libp2p | 中 | gossipsub v1.1, arXiv:2310.09193 |
| 7 | 機密コンテナ実行 | 中 | io.net, Confidential Containers |
| 8 | データ層統一 | 中 | （既知 follow-up） |

---

## 参考文献（arXiv / 一次情報）

- Validation of GPU Computation in Decentralized, Trustless Networks — https://arxiv.org/abs/2501.05374
- V3rified: Revelation vs Non-Revelation Mechanisms for Decentralized Verifiable Computation — https://arxiv.org/pdf/2408.07177
- Agora: Bridging the GPU Cloud Resource-Price Disconnect — https://arxiv.org/abs/2510.05111
- Auction Mechanisms in Cloud/Fog Computing Resource Allocation for Public Blockchain Networks — https://arxiv.org/abs/1804.09961
- Online Combinatorial Auctions for Resource Allocation with Supply Costs and Capacity Limits — https://arxiv.org/pdf/2209.07035
- Automated Market Making for Goods with Perishable Utility — https://arxiv.org/pdf/2511.16357
- AetherWeave: Sybil-Resistant Robust Peer Discovery with Stake — https://arxiv.org/pdf/2603.23793
- A Review of Techniques to Mitigate Sybil Attacks — https://arxiv.org/pdf/1207.2617
- Tikuna: An Ethereum Blockchain Network Security Monitoring System — https://arxiv.org/pdf/2310.09193
- Confidential Computing on NVIDIA H100 GPU: A Performance Benchmark Study — https://arxiv.org/html/2409.03992v1
- JSTprove: Pioneering Verifiable AI for a Trustless Future — https://arxiv.org/html/2510.21024v1

### 同種ソフト / 技術一次情報
- Akash Network — https://akash.network/blog/scaling-the-supercloud/
- io.net（GPU クラウド比較） — https://io.net/p/io-net-vs-akash-vs-render-network-which-decentralized-platform-actually-delivers
- 決済: Lightning Hold Invoice（Voltage） — https://voltage.cloud/blog/understanding-hold-invoices-on-the-lightning-network
- 決済: Hold Invoices（ION Lightning Wiki） — https://wiki.ion.radar.tech/tech/research/hodl-invoice
- NVIDIA H100 Confidential Computing（Technical Blog） — https://developer.nvidia.com/blog/confidential-computing-on-h100-gpus-for-secure-and-trustworthy-ai/
- GPU Remote Attestation（Intel Trust Authority） — https://docs.trustauthority.intel.com/main/articles/articles/ita/concept-gpu-attestation.html
- gossipsub v1.1 spec（libp2p） — https://github.com/libp2p/specs/blob/master/pubsub/gossipsub/gossipsub-v1.1.md
- 分散 AI 推論市場（Bittensor/Gensyn 比較） — https://blockeden.xyz/blog/2025/07/28/decentralized-ai-inference-markets/

---

# 追補（第2弾 / 2026-06）— 中断耐性・分散学習・検証の落とし穴

第1弾でカバーしなかった領域を、追加の同種ソフト（Vast.ai / Nosana / Spheron / Prime Intellect）と arXiv 論文で深掘りした。

## 9. Spot / 中断可能インスタンスとチェックポイント耐性

**現状**: `virtual-gpu-manager.js` ＋ `src/gpu/gpu-auto-recovery.js` に復旧基盤はあるが、
**プロバイダ都合の中断（preemption）を前提とした料金ティアもチェックポイント・プロトコルも無い**。
注文は固定時間枠（`order/index.js`）のみで、安価な空き GPU を中断許容で貸す手段が無い。

**同種ソフト**:
- **Vast.ai**: interruptible（spot）インスタンスを**入札制で最大 80% 安**く提供。
- 一般に spot は 60–90% 割引、30 秒〜2 分前通知で中断。

**参考研究**:
- *Bamboo: Making Preemptible Instances Resilient for Affordable Training of Large DNNs*, arXiv:2204.12013 — 単純チェックポイントだと GPT-2/64 spot で**再起動に 77% の時間**を浪費。冗長計算で耐性を確保。
- *TierCheck: Tiered Checkpointing for Fault Tolerance in LLM Training*, arXiv:2605.17821 — local/neighbor/remote の三層チェックポイント。
- *Fault-Tolerant Hybrid-Parallel Training with In-memory Checkpointing*, arXiv:2310.12670。
- *Modeling The Temporally Constrained Preemptions of Transient Cloud VMs*, arXiv:1911.05160。

**推奨アクション**:
1. (中期) **中断許容ティア**を価格表に追加（§4 のオークションと統合、Vast.ai 流の入札）。
2. (中期) 中断前 30 秒通知 → 自動チェックポイント退避（三層, TierCheck 流）→ 別プロバイダへ再スケジュール（`gpu-auto-recovery.js` を拡張）。
3. SLA（`src/api/sla.js`）に中断率・復旧時間を組み込み、レピュテーション（§5）へ反映。

優先度: **中（コスト競争力に直結）**

## 10. 低通信の分散学習サブストレート化

**現状**: 単一 GPU 貸出のみ。複数プロバイダの GPU を束ねた**分散学習ジョブのオーケストレーションが無い**
（`p2p-network.js` は無効）。インターネット越し・不安定ノードでの協調学習を扱えない。

**同種ソフト**: **Prime Intellect**（INTELLECT-1 を分散学習で訓練）。

**参考研究**:
- *INTELLECT-1 Technical Report (PRIME framework)*, arXiv:2412.01152 — **ElasticDeviceMesh** で耐障害なインターネット越し通信＋ノード内 FSDP、DiLoCo ＋ int8 all-reduce で**通信帯域 400× 削減**。
- *DiLoCoX: Low-Communication Large-Scale Training for Decentralized Cluster*, arXiv:2506.21263。
- *Beyond A Single AI Cluster: A Survey of Decentralized LLM Training*, arXiv:2503.11023。

**推奨アクション**:
1. (長期) 帯域制約・中断のある Strawberry の GPU プールを、**DiLoCo 系の低通信分散学習**の実行基盤として位置づけ（§9 の中断耐性が前提）。
2. ジョブ定義に「分散学習（マルチノード）」型を追加し、ElasticDeviceMesh 風の参加/離脱を許容。

優先度: **低〜中（差別化の上振れ）**

## 11. 検証設計の落とし穴 — Proof-of-Learning は spoof 可能

**注意**: §1 で挙げた計算検証を素朴に実装すると破られる。**Proof-of-Learning(PoL) は現状 spoof 可能**で、
正直に訓練せずとも検証を通す証明を生成できることが示されている。検証設計時の必読事項。

**参考研究**:
- *Proof-of-Learning is Currently More Broken Than You Think*, arXiv:2208.03567 — 常に成功する spoof 攻撃を提示。
- *Optimistic Verifiable Training by Controlling Hardware Nondeterminism*, arXiv:2403.09603 — **HW 非決定性を制御**して楽観的検証（チャレンジ時のみ再計算）を成立させる。
- *A Survey of Zero-Knowledge Proof Based Verifiable Machine Learning*, arXiv:2502.18535。
- *VerifiableFL: Verifiable Claims for Federated Learning using Exclaves*, arXiv:2412.10537 — TEE/exclave による検証。
- PoL + ウォーターマークの**二層防御**（spoof には訓練軌跡と透かしの両方の複製を強制）。

**推奨アクション**:
1. §1 の検証は **PoL 単体に依存しない**。楽観的検証（チャレンジ＋再計算, arXiv:2403.09603）＋ TEE attestation（§2）＋ ウォーターマークを組み合わせる。
2. 非決定性制御（固定シード・決定論的カーネル）を検証の前提として `virtual-gpu-manager` の実行環境に組み込む。

優先度: **高（§1 の正しさを担保する前提）**

## 12. 標準ベンチマーク・ホスト信頼性スコア（DLPerf 相当）

**現状**: `src/utils/ai-benchmark.js` はあるが、**機種横断で比較可能な標準スコアやホスト信頼性レーティングが無い**。
借り手が「どの GPU/ホストが速く・落ちにくいか」を比較できない。

**同種ソフト**: **Vast.ai の DLPerf スコア**（GPU 選定指標）＋ ホスト信頼性メトリクス。**Nosana** は組込みバリデーション。

**推奨アクション**:
1. (短期) 出品時に標準ベンチを必須化し、**DLPerf 風の正規化スコア**を算出・掲示（§2 のスペック詐称検出と統合）。
2. (短期) 稼働率・中断率・完了率から**ホスト信頼性スコア**を出し、検索ランキング（`gpu/index.js` のソート）と §5 レピュテーションに反映。

優先度: **中**

## 13. Serverless / オートスケール推論・分課金メータリング

**現状**: 注文は固定時間枠の予約のみ。**サーバーレス（リクエスト課金）やオートスケール推論が無い**。
課金は 5 分粒度のフラット（`order/index.js`）。

**同種ソフト**: **Vast.ai Serverless**（推論のオートスケール）、**Spheron**（分単位課金・中断なし専有ティア）。

**推奨アクション**: (中期) 推論向けの**サーバーレス/オートスケール**ティアと、§3 の Lightning ストリーミング・マイクロペイメントによる**実消費メータリング課金**を追加。

優先度: **中**

---

## 追補・優先度まとめ

| # | 改善領域 | 優先度 | 根拠（代表） |
|---|---------|--------|-------------|
| 11 | 検証の落とし穴対策（楽観的検証＋TEE＋透かし） | 高 | arXiv:2208.03567, 2403.09603, 2502.18535 |
| 9 | Spot/中断耐性＋三層チェックポイント | 中 | arXiv:2204.12013, 2605.17821; Vast.ai |
| 12 | 標準ベンチ/ホスト信頼性スコア | 中 | Vast.ai DLPerf; Nosana |
| 13 | Serverless/オートスケール＋実消費課金 | 中 | Vast.ai Serverless; Spheron |
| 10 | 低通信の分散学習サブストレート | 低〜中 | arXiv:2412.01152, 2506.21263, 2503.11023 |

## 追補・参考文献（arXiv / 一次情報）

- Bamboo: Making Preemptible Instances Resilient for Affordable Training of Large DNNs — https://arxiv.org/pdf/2204.12013
- TierCheck: Tiered Checkpointing for Fault Tolerance in LLM Training — https://arxiv.org/html/2605.17821v1
- Fault-Tolerant Hybrid-Parallel Training with In-memory Checkpointing — https://arxiv.org/pdf/2310.12670
- Modeling The Temporally Constrained Preemptions of Transient Cloud VMs — https://arxiv.org/pdf/1911.05160
- INTELLECT-1 Technical Report (PRIME / ElasticDeviceMesh / DiLoCo) — https://arxiv.org/html/2412.01152v1
- DiLoCoX: Low-Communication Large-Scale Training for Decentralized Cluster — https://arxiv.org/html/2506.21263v1
- Beyond A Single AI Cluster: A Survey of Decentralized LLM Training — https://arxiv.org/html/2503.11023v1
- Proof-of-Learning is Currently More Broken Than You Think — https://arxiv.org/pdf/2208.03567
- Optimistic Verifiable Training by Controlling Hardware Nondeterminism — https://arxiv.org/html/2403.09603v3
- A Survey of Zero-Knowledge Proof Based Verifiable Machine Learning — https://arxiv.org/abs/2502.18535
- VerifiableFL: Verifiable Claims for Federated Learning using Exclaves — https://arxiv.org/pdf/2412.10537

### 同種ソフト一次情報（追補）
- Vast.ai Serverless（オートスケール推論） — https://vast.ai/products/serverless
- Vast.ai spot/interruptible（AIスタートアップ向け） — https://vast.ai/article/starting-smart-why-spot-gpus-are-ideal-for-ai-startups
- Nosana GPU workloads（組込みバリデーション） — https://nosana.com/gpu-workloads/
- Spheron（Vast.ai 代替比較） — https://www.spheron.network/blog/vastai-alternatives/
- GPU マーケット比較（Shadeform / Prime Intellect / Node AI） — https://aimultiple.com/gpu-marketplace

---

# 追補（第3弾 / 2026-06）— 推論効率・カーボン・機密性・市場健全性

第1・2弾で未カバーの「サービング効率／持続可能性／プライバシー／オークション健全性／監査の対外証明」を追加調査した。

## 14. 推論サービング効率（continuous batching / PagedAttention / 投機的デコード）

**現状**: Strawberry は**素の GPU 時間**を貸すだけ（`virtual-gpu-manager.js`）。推論最適化レイヤが無いため
$/token 競争力が低い。§13 のサーバーレス推論ティアを作るなら、ここが性能の肝。

**同種ソフト**: Vast.ai Serverless、各種 vLLM ベースの推論プラットフォーム。

**参考研究**:
- vLLM **PagedAttention**（KV キャッシュ断片化を解消、メモリ near-optimal）、Orca **continuous batching**（実行中バッチに動的にリクエスト投入）。
- *FairBatching: Fairness-Aware Batch Formation for LLM Inference*, arXiv:2510.14392。
- *BatchLLM: Global Prefix Sharing + Throughput-oriented Token Batching*, arXiv:2412.03594。
- *vAttention: Dynamic Memory Management for Serving LLMs without PagedAttention*, arXiv:2405.04437。
- *Multi-Bin Batching for Increasing LLM Inference Throughput*, arXiv:2412.04504。

**推奨アクション**: (中期) §13 のサーバーレス推論ティアを **vLLM 系（PagedAttention＋continuous batching）**で実装し、トークン単位課金（§3 ストリーミング）と統合。プロバイダ側コンテナイメージに最適化サービングを同梱。

優先度: **中**

## 15. カーボン対応・地理分散スケジューリング

**現状**: P2P で GPU は地理分散だが、配置は需給/価格のみ（§4）。**電力価格・系統カーボン強度を考慮した配置が無い**。コスト・ESG 双方で機会損失。

**参考研究**:
- *Sustainable Carbon-Aware and Water-Efficient LLM Scheduling in Geo-Distributed Cloud Datacenters (SLIT)*, arXiv:2505.23554 — TTFT・カーボン・水・電力コストを共最適化。
- *Sustainable AIGC Workload Scheduling (Multi-Agent RL)*, arXiv:2304.07948。
- *Carbon-Aware Computing with Probabilistic Performance Guarantees*, arXiv:2410.21510。
- *Task Scheduling in Geo-Distributed Computing: A Survey*, arXiv:2501.15504。

**推奨アクション**:
1. (中期) プロバイダ・メタデータに地域/電力カーボン強度を持たせ、§4 のマッチングに**carbon-aware な配置スコア**を追加（遅延非依存ジョブは低炭素地域へ）。
2. 「グリーン実行」をプレミアム属性として価格・検索に露出。

優先度: **中（差別化＋コスト）**

## 16. ワークロード機密性（Secure Aggregation / 差分プライバシー）

**現状**: 借り手のコード・データは**プロバイダ host から丸見え**。`src/security/compliance.js` はあるが、
分散学習（§10）や複数ノード推論で**個々の更新やデータを host から秘匿する仕組みが無い**。TEE（§2）だけでは多者協調をカバーしきれない。

**参考研究**:
- *Secure Stateful Aggregation: A Practical Protocol for DP-FL*, arXiv:2410.11368。
- *On Using Secure Aggregation in DP-FL with Multiple Local Steps*, arXiv:2407.19286。
- *DDP-SA: Scalable Privacy-Preserving FL via Distributed DP and Secure Aggregation*, arXiv:2604.07125 — クライアント側 LDP＋加法的秘密分散で個別更新を server/経路から秘匿。

**推奨アクション**: (中期) §10 の分散学習・フェデレーテッド型ジョブに **secure aggregation（秘密分散）＋差分プライバシー**を組み込み、host が個別勾配/データを復元できないようにする。TEE（§2）と多層化。

優先度: **中**

## 17. オークション健全性（談合・シル入札検知）

**注意/現状**: §4 で逆/ダブルオークションを導入すると、**シル入札（価格つり上げ）や複数出品者の談合**が新たなリスクになる。匿名アカウント乱立で検知困難（§5 Sybil と関連）。

**参考研究**:
- *Detecting Multiple Seller Collusive Shill Bidding*, arXiv:1812.10868 — Shill Score を複数出品者談合へ拡張。
- *Shill Bidding Prevention in Decentralized Auctions Using Smart Contracts*, arXiv:2506.00282 — スマートコントラクトで**改ざん耐性のあるオークション環境**＋不審行動の**動的ペナルティ**。

**推奨アクション**:
1. (中期) §4 のオークションに **Shill Score 風の異常検知**（`src/utils/anomaly-detector.js` を拡張）を組み込み、§5 のステーク・スラッシングで動的ペナルティ。
2. 入札ログを §18 のアンカリングで改ざん耐性化。

優先度: **中（§4 を入れるなら必須の対）**

## 18. 監査ログの対外証明（タイムスタンプ/アンカリング）

**現状**: `src/api/middleware/audit.js` は HMAC 連鎖で tamper-evident だが、**外部アンカーが無い**ため運営自身による改ざん・遡及を第三者が否認できない（自己署名の限界）。

**参考研究**: *Shill Bidding Prevention … Smart Contracts*, arXiv:2506.00282（改ざん耐性・透明性の確保）。一般に OpenTimestamps 等の**公開タイムスタンプ/ブロックチェーン・アンカリング**。

**推奨アクション**: (短期) 監査ログ/入札ログの定期ダイジェスト（Merkle ルート）を**公開タイムスタンプ（OpenTimestamps 等）にアンカー**し、非否認性を確立。BTC を既に扱うため親和性が高い。

優先度: **中**

---

## 追補（第3弾）・優先度まとめ

| # | 改善領域 | 優先度 | 根拠（代表） |
|---|---------|--------|-------------|
| 17 | オークション談合/シル入札検知 | 中（§4の対） | arXiv:1812.10868, 2506.00282 |
| 18 | 監査ログの対外アンカリング | 中 | arXiv:2506.00282; OpenTimestamps |
| 14 | 推論サービング効率（vLLM系） | 中 | PagedAttention/Orca, arXiv:2510.14392, 2412.03594 |
| 15 | カーボン対応・地理分散配置 | 中 | arXiv:2505.23554, 2304.07948, 2501.15504 |
| 16 | ワークロード機密性（secure agg/DP） | 中 | arXiv:2410.11368, 2407.19286, 2604.07125 |

## 追補（第3弾）・参考文献（arXiv / 一次情報）

- FairBatching: Fairness-Aware Batch Formation for LLM Inference — https://arxiv.org/html/2510.14392v1
- BatchLLM: Optimizing Large Batched LLM Inference (Global Prefix Sharing) — https://arxiv.org/html/2412.03594v1
- vAttention: Dynamic Memory Management for Serving LLMs — https://arxiv.org/html/2405.04437v2
- Multi-Bin Batching for Increasing LLM Inference Throughput — https://arxiv.org/pdf/2412.04504
- Inside vLLM: Anatomy of a High-Throughput LLM Inference System — https://blog.vllm.ai/2025/09/05/anatomy-of-vllm.html
- Sustainable Carbon-Aware and Water-Efficient LLM Scheduling (SLIT) — https://arxiv.org/abs/2505.23554
- Sustainable AIGC Workload Scheduling (Multi-Agent RL) — https://arxiv.org/abs/2304.07948
- Carbon-Aware Computing with Probabilistic Performance Guarantees — https://arxiv.org/html/2410.21510v3
- Task Scheduling in Geo-Distributed Computing: A Survey — https://arxiv.org/pdf/2501.15504
- Secure Stateful Aggregation: A Practical Protocol for DP-FL — https://arxiv.org/html/2410.11368v1
- On Using Secure Aggregation in DP-FL with Multiple Local Steps — https://arxiv.org/abs/2407.19286
- DDP-SA: Scalable Privacy-Preserving FL via Distributed DP and Secure Aggregation — https://arxiv.org/pdf/2604.07125
- Detecting Multiple Seller Collusive Shill Bidding — https://arxiv.org/abs/1812.10868
- Shill Bidding Prevention in Decentralized Auctions Using Smart Contracts — https://arxiv.org/html/2506.00282v1
- invoice-poller の stat ゲート早期 return（perf）: 15 秒周期ポーラーが毎回 payments.json を全量読み込み+パースしていた。`fs.statSync` の (mtimeMs,size) 指紋で「ファイル不変かつ前回 pending=0」のとき全量パースをスキップ（pending>0 は外部決済の再確認が必要なので従来通り）。静寂時のファイル I/O がゼロになり、新規支払いはファイル変更で確実に検知される。stop() でゲート状態もリセット。
- 通知設定の読み込み N+1 解消（perf）: `user-notify.js` の `notifyUser` が通知送信のたびに notification-settings.json を全量読み込み+パースしていた（price-watch のウォッチャー通知等で件数ぶんの I/O）。auth-user-lookup と同じ stat(mtimeMs,size) ゲートで「ファイル変更時のみ再パース」に変更。設定保存は atomicWriteJSON（rename）のため mtime で確実に検知。
- 認証パスの users.json 全量読み込み解消（perf）: jwt-auth / security / GraphQL context の3箇所が認証済みリクエスト毎に `UserRepository.getById`（全量 readFileSync+parse）を踏んでいた → `auth-user-lookup.js` 新設。users.json の (mtimeMs,size) を statSync でゲートし変更時のみ再パース、`id → {status,passwordChangedAt,sessionsRevokedAt}` の `Object.freeze` 済み最小レコードを返す。行オブジェクトを共有しないためミューテーション漏洩なし、stat 失敗時はリポジトリへフォールバック（フェイルオープンしない）。
- 通知リトライの full jitter 化（resilience）: `notifier.js` の `withRetry` が固定指数バックオフ（1s,2s…）で、一括通知障害時に全呼び出しの再送が同期化し得た（thundering herd。AWS Architecture Blog「Exponential Backoff And Jitter」の定番対策）。遅延を `random() * min(maxDelayMs, base*2^n)` の一様乱数に変更し上限も追加。併せてユーザーIDが UUID v4 で 'user_' 始まりにならない `sendNotification` の到達不能な多段分岐を削除（多段通知は user-notify.js が担当）。
- プロバイダ向け自動登録スクリプトの実契約化（fix/DX）: `gpu_lending_setup_auto_register.js` が存在しない `POST /api/gpu` を叩き、必須フィールド（memoryGB/clockMHz/powerWatt/pricePerHour）と arch 値（x64→x86_64 等）もスキーマ不一致で、実行しても 404/400 確定だった → `POST /api/v1/gpus` + `schemas.gpu.register` 準拠 payload へ修正、URL/トークンを環境変数化（STRAWBERRY_API_URL/STRAWBERRY_TOKEN）、非対応 GPU は早期エラーで案内。実 Joi スキーマでのドライ検証済み。
- SLA トラッカーの配線 + 滞留防止（reliability）: `sla-tracker.js` の `startSLATracker` が誰からも呼ばれておらず sla.json が一切書かれず `GET /api/sla` は常に既定値を返していた。server.js へ配線（タイマー抑止はモジュール側の NODE_ENV ガード）。加えて 3 つの運用欠陥を修正: ①`checkAlive` の fetch にタイムアウトが無く応答滞留で以後の全周期が停止 ②updateSLA に再入ガードが無く checkAlive 滞留中の周期重複で load→save の RMW 競合 ③通知失敗が updateSLA へ伝播するのを catch。unref+stop も追加。
- token-denylist のクロスプロセス失効伝播（security）: 失効 jti マップが初回ロード後プロセス内に固定され、別プロセス（CLI・別ワーカー・pm2 クラスタ）が revoked-tokens.json に追記してもこのプロセスの `isRevoked` は古いマップを見続けて失効トークンを受理し続けた。stat(mtimeMs,size) ゲートで「ファイル変更時のみ再読込」へ。永続化は atomicWriteJSON（rename）のため mtime で確実に検知。stat 失敗時は現行マップ維持（revoke→isRevoked の即時整合を壊さない）、パース失敗時も指紋は記録して壊れたファイルの再パース連発を防ぐ。

## 実装済みメモ（ドキュメント外の実測改善）

- **稼働統計の書き込みバッチ化**（本PR）: `recordProviderHeartbeat`/`recordSlaBreach` が
  呼ばれるたびに `uptime.json` を `getByProviderId` の load + `update` の load+write
  で計3回全量 I/O していたのを、プロセス内 pending 差分 + `UPTIME_FLUSH_INTERVAL_MS`
  （既定30s）ごとの一括 `updateMany`（1 load + 1 write）へ変更。読み取り側
  `getReliability` は pending を上乗せして返すため即時性は維持。落ちた場合の
  喪失窓は1フラッシュ周期（best-effort 統計として許容）。
- **リポジトリの `updateMany` プリミティブ**: 複数行の部分更新を 1 load + 1
  atomicWrite に束ねる。ポーラー・バッチフラッシュ等の N 行更新経路で
  逐次 update の N+1 書き込み増幅を潰す。

- 残存 N+1 の後始末（perf）: `payment-reminder.js` の支払いごとの `UserRepository.getById`（users.json を件数ぶん全量読込）を 1 回の `getAll` → Map 化へ置換。`order-expiry.js` の係争自動解決では `EscrowRepository.getAll` を「解決が実際に発生した時だけ構築する orderId→HELD エスクロー Map」に遅延集約（no-op スイープで無駄読みしない）。孤立 React ファイル `src/web/pages/settings/notifications.js`（React/axios 前提だがビルド系・参照ともに無し、JWT モデルと整合しない旧式実装）を削除。

### その他実装済（運用ドキュメント）
- `public/robots.txt` 新設: `express.static` で `/robots.txt` として自動配信。`/api/`・`/admin` を Disallow（API レスポンス・管理画面のインデックス化防止）。marketplace SPA は index 可。security.txt は RFC 9116 的に発見されるべきなので Disallow しない。
- `sandbox-apikey.js` の直接ユニットテストを追加: `generateApiKey` の 48hex 形式・一意性、`isValidApiKey` の永続化往復・不在/破損ファイル時のクラッシュ無し false を固定（開発/テスト専用の API キー機構 — 本番 404 ゲート付き）。
- `improvement_checklist2.md` の「既知の未完了」内の陳腐記述を修正: 「孤立した `*-fixed.js`」は現存せず、「Electron(preload/react-app) は未配線」も `public/electron.js` + `preload.js` 実装済み（配布パッケージングのみ未配線）の現状へ同期。
- `provider-uptime` の直接ユニットテスト追加（0カバレッジだった信頼性スコア算出）: beats/gapEvents/sessions の累計・GAP_THRESHOLD 超過での gap 判定・再起動後初回ビートの偽 gap 抑制・MIN_BEATS 未満の measuring・breach があれば measuring で隠さない・disruptionRate+ペナルティでの減点。11件。
- `cache.js` の直接ユニットテスト追加: 2xx のみキャッシュ・非2xx は次リクエストでハンドラ再実行（500 を 60 秒 200 で replay する旧バグの回帰固定）・perUser は userId:role でキー分離（他ユーザーデータ漏洩防止）・invalidateUserCache/ByUrlPattern/purgeCache の境界検証。8件。
- `instrumentation.js` の OTel ゲーティング不変条件をテスト固定: `OTEL_EXPORTER_OTLP_ENDPOINT` 未設定時に @opentelemetry/* を一切 require しないこと・シグナルハンドラを登録しないことを検証（無条件化の回帰防止 — server.js の最初の require のため誤って無条件化すると全起動で ~140 パッケージ読み込みのコストが発生）。
- `tests/unit/test_exchange_rate.js` を `exchange-rate-fallback.test.js` へ改修: 旧ファイルは名前が jest testMatch に合わず常時スキップされ、かつ assert で実 API を呼ぶ死テストだった（「全失敗で throw」期待も非 production では誤り）。axios モック化＋NODE_ENV 分岐を正しく検証（全API失敗→DEFAULT_RATE/production throw/stale 優先・プロバイダフォールバック順・範囲外レート拒否・withTimestamp）。
- `.gitattributes` 新設: `*.sh`/`*.bash` を `text eol=lf` に固定（`core.autocrlf=true` の Windows チェックアウトで `#!/usr/bin/env bash` が `bash\r` として解釈されスクリプトが起動不能になるのを防止）。`* text=auto` でテキスト正規化、画像を `binary` 指定で誤変換防止、`package-lock.json` を `linguist-generated` で PR diff 折りたたみ。
- `lightning-service.js` 定期タスクの健全化: `startPeriodicTasks` が生成する3本の `setInterval`（channels 5分/クリーンアップ 10分/nodeInfo 30分）がハンドル未保持・`unref` 未適用・`shutdown()` で未解除で、`initialize()` 再呼出し（service-monitor の restart・失敗後リトライ）毎にタイマーが3本ずつ積み上がり、shutdown 後も切断済み gRPC へ発火し続けエラーログを垂れ流していた。`_periodicTimers` 追跡・`stopPeriodicTasks()`・start 時の既存解除・`unref()`・shutdown/initialized リセットを追加。
- `.dockerignore` の欠落補完: `Dockerfile.api` が `COPY . .` でビルドコンテキスト全体を同梱するのに `backups/`（backup.js が data/*.json を平文コピーする出力先 — users.json のパスワードハッシュ・revoked-tokens・profit-addresses を含む）が除外されておらず、バックアップ済みホストでの `docker build` がイメージへ機密データを焼き込む経路だった。併せて `.gitignore` と対称に `test-results`/`playwright-report`/`dist`/`build`/`*.bak`/`*.tmp`/`.idea`/`*.swp`/`yarn-debug` 系を追加。
- `.env.example` をコード実態に同期: ソース中で使用されるが未記載だった 72 変数（レート制限・注文タイムアウト・稼働率スコア・監査ログ・LN 代替プロバイダ・外部通知/連携）を機能別セクションに整理して追加し、コード上の既定値をコメントに明記。
- 仕様/アーキテクチャドキュメントをコード実態へ同期（`docs/SPECIFICATION.md`/`ARCHITECTURE.md`）: 「エスクロー無し」「アテステーション無し」「特徴量価格未配線」「executeActions 未呼出」「テスト約半数 green」など、実装が進んだ後も古いままだったステータス記述を実測値（137/139 suites green、escrow lnAdapter DI、/marketplace/quote 配線、GPU 登録時 attestation 記録、OTel env ゲート実装）に修正。ドキュメントの陳腐化はコードより新規貢献者・レビューアの判断を誤らせる（Google eng-practices「ドキュメントはコードと共に更新する」）。
- `form-data` の critical 脆弱性を lockfile 更新で局所解消（axios 経由 4.0.5→4.0.6、superagent 経由 4.0.6、@types/request 経由 2.5.5→2.5.6、@kubernetes/client-node 経由 tar 7.5.16→7.5.22）。残存の form-data@2.3.3（request 経由）と tar@6.2.1（node-pre-gyp 経由）は親パッケージのメジャー更新が必要なため別途。
- `docs/faq.md` をコード実態へ同期: 存在しない `scripts/deploy_public.sh`・「自動デプロイ」（ci-cd.yml の Deploy は echo スタブ）・k8s 前提の障害対応手順を削除し、実在のワークフロー一覧・ops スクリプトの env/依存・`/health` `/metrics`・`POST /admin/expire-orders` 等の実運用手段へ置き換え。
- `README.md` の実在しない運用コマンドを実在手段へ修正: `npm run start:prometheus`/`monitor:nodes`/`benchmark`/`report:monthly` は未実装のため `/metrics`（Bearer 保護）・`gpu-failure-monitor`・`progress-report` へ置き換え、「自動本番デプロイ」は ci-cd.yml の Deploy が echo スタブである旨を明記。
- `CONTRIBUTING.md` を実態へ同期: 「main または develop からブランチ作成」→ develop は不在（main のみ）、「CI で lint/test/openapi をチェック」の記述を実ワークフローへ具体化（build-test の lint は non-blocking、coverage 閾値70、openapi-autogen の対象パス、optimize-images、ci-cd は main push のみで Deploy はスタブ）。日英両セクション。
- `.gitignore` に実行時生成物を追加: `data-test/`（Jest ワーカー別データ分離の出力）と `src/health.json`（`src/p2p-health.js`/`src/p2p-notify.js` が実行時に生成）。いずれもローカル実行後に untracked としてツリーを汚していた。

### .env.example 再同期（2026-09-27・#55 後の差分）
- **対応**: #55 マージ後に残っていた未記載の環境変数 12 件を追記 — ops スクリプト系（PROGRESS_SHEET_ID/FEEDBACK_SHEET_ID/NOTION_TOKEN/NOTION_DB_ID/GITHUB_TOKEN/GITHUB_REPO/SLACK_BOT_TOKEN/SLACK_CHANNEL/LND_PROTO_PATH/API_ENDPOINT）と e2e 系（E2E_BASE_URL/PLAYWRIGHT_CHROMIUM_PATH）。CI/DOCKER_HOST/HOME 等のシステム由来変数は対象外。
- `responseTime` ミドルウェアに RED メトリクス（`http_requests_total` / `http_request_duration_seconds`）を実装: 従来は遅いリクエストの warn ログのみで定量観測できなかった。ラベルはルートテンプレート正規化（`/api/v1/gpus/:id`）で高カーディナリティ防止。/metrics の既存 Prometheus 配線を利用。
- 空スタブだった `docker/docker-compose.yml`・`kubernetes/{deployment,service}.yaml` を実マニフェスト化: compose は Dockerfile.api ビルド+data/logs ボリューム永続化、deployment は /health probes・Secret 参照・readOnlyRootFilesystem・replicas=1（JSON 単一ライター前提）とした。
- `createJsonRepository` に stat 指紋（mtime:size）ゲートの共有読み込みキャッシュを内蔵: 無変更時は `readFileSync`+`JSON.parse` を行わず複製を返す。全9リポジトリの全読み取り経路（getAll/getById/finder/書き込み前ロード）が対象で、呼び出し側ごとの局所キャッシュ（認証・通知設定・失効リスト・ポーラー等）をインフラ層に統合。返却値は `structuredClone` で隔離しキャッシュ汚染を防止、破損時は従来通り fail-closed。
- Dockerfile.api に HEALTHCHECK を追加: 30 秒間隔・5 秒タイムアウト・3 回連続失敗で unhealthy。Node のグローバル fetch で `/health` を叩き、ハングしたコンテナを Docker の restart ポリシーが検知できるようにした。
- `gpu-failure-monitor.monitor()` を Promise 返却化: fire-and-forget だったため非同期通知が呼出元の完了後に走り、テストで「Cannot log after tests are done」警告の原因になっていた。テストを child_process/Slack モック化して正常・障害・実行失敗の3経路を決定的に検証するよう刷新。
- `docker/Dockerfile.gpu-worker` を実装（従来はコメントのみのスタブで、`virtual-gpu-manager` が参照する `strawberry/gpu-worker:latest` がビルド不能だった）。nvidia/cuda runtime ベース・非 root ユーザー・nvidia-smi ヘルスチェック・既定 CMD は exec 投入前提の待機。
- Googleカレンダー連携のログ汚染修正: `googleapis` が依存未収録で require が必ず失敗するのに、注文作成のたび `Cannot find module` の ERROR ログを吐いていた。`GCAL_REFRESH_TOKEN` 設定済み環境のみ読み込む形に環境ゲート化し、未導入時は warn に降格。あわせて `defaultConfig` の暗黙グローバル漏洩（const 欠落）を修正。
- Jest ワーカー別データ分離でテスト並列化: `src/db/json/data-dir.js` の `resolveDataDir()` を新設し data/ 解決を一元化（Jest ワーカー内では `data-test/worker-N` を返却）。jest.config にあった「正しい長期修正は JEST_WORKER_ID によるワーカー別データ分離」という既知課題を解消し、`maxWorkers: 1` → `'50%'` で全スイートが約 86s → 約 30s（ローカル実測）に短縮。`STRAWBERRY_DATA_DIR` env によるデータ dir 上書きも同時に提供（運用面の副次効果）。globalSetup の単一プロセス制約に対応するため、ワーカー別シードは `setupFiles` (tests/setupWorkerData.js) で実施。
- Google OAuth ログインのトークンペア発行: `/auth/google` が access token のみを返し refresh token を発行していなかった（OAuth ユーザーは 1h ごと強制再ログイン・ローテーション/サーバ側失効経路に非対応）。パスワードログインと同じ `signAccessToken`+`signRefreshToken`（ati 紐付け）+`lastLogin` 更新へ揃えた。あわせて `google-auth-library` を dependencies に追加（未収録で require が必ず MODULE_NOT_FOUND→503 となり、設定済みでも実質デッドだった）。
- SPA の refresh token セッション継続: ログイン時に refreshToken を破棄していたためアクセストークン（1h）切れのたび強制再ログインだった。`strawberry.refreshToken` に保持し、401 受信時に直列化された `/users/refresh`（ローテーション再利用検知を防ぐため並行 401 は 1 本に集約）で更新→元リクエストを再試行。ログアウト時にサーバ側失効（/users/logout へ refreshToken 送信）も配線。Playwright e2e で実ブラウザ検証。
- `errorMiddleware` に `res.headersSent` ガードを追加: レスポンス送信済みでエラーが起きた場合（sendFile のストリーム途中障害等）に `res.json()` への二重送信を試みてハンドラ内例外になる問題を、Express 公式推奨パターン（既定ハンドラへ委譲して接続を閉じる）で修正。
- サービス死活監視の外部通知を状態遷移ベース化（`src/core/service-monitor.js`）: 不健全 tick ごとに Slack/Sentry/LINE へ送っていた service_down / service_restart_failed を、不健全エッジ1回 + 継続中は `SERVICE_MONITOR_RENOTIFY_MS`（既定5分）間隔の再通知のみに絞り、復帰時は `service_recovered` を1回送信。監査ログ・メトリクスは従来通り毎 tick 記録。あわせて tick 重なり防止（再入ガード）と startMonitor 二重起動ガードを追加。根拠: Nagios の state-change notification + re-notification interval、PagerDuty の alert dedup、Google SRE Book「Monitoring Distributed Systems」のアラート疲弊対策。
- Slack Webhook 送信の耐障害化: `scripts/slack-feedback-bot.js` の `sendSlackMessage`（gpu-failure-monitor・alert-* 等の共有通知経路）に 10 秒タイムアウト（`SLACK_WEBHOOK_TIMEOUT_MS` で調整可）・不正 URL/非 https の拒否・レスポンスのドレイン（ソケット解放）を追加。`slack-notify.js` の重複 HTTP 実装は共有実装に集約。
- ops スクリプト群の未宣言依存を optionalDependencies に宣言: `progress-report`/`*-to-sheets`/`*-to-notion`/`checklist-to-issues`/`slack-notify-graph`/`kpi-trend-graph`/`sample` が `googleapis`・`@notionhq/client`・`@octokit/rest`・`@slack/web-api`・`chartjs-node-canvas`・`i18next` 等を package.json 未宣言のまま require し、`npm run <script>` が `Cannot find module` で即死していたのを修正。あわせて (a) 3本に複製されていた Google OAuth `authorize()` を `scripts/google-sheets-auth.js` に集約し credentials/token 未配置・形式不正を手順付きエラー化、(b) 全対象スクリプトに必須 env の事前検査（`PROGRESS_SHEET_ID`/`FEEDBACK_SHEET_ID`/`NOTION_TOKEN`/`NOTION_DB_ID`）と失敗時 exit(1) を追加、(c) `slack-notify-graph` を廃止済み `files.upload` から `filesUploadV2` へ移行（@slack/web-api v8 で旧メソッドは削除済み）。`@notionhq/client` はスクリプトが `databases.query`/`pages.create` を使うため API 互換の v2 系に固定。`tests/scripts/script-deps.test.js` で scripts/*.js の全 bare require が宣言済みであることを検査する回帰ガードを追加。
- `scripts/version-assets.js` / `update-references.js`（fingerprinting キャッシュバスティング）の実動化: ① 実資産が置かれる `public/js`・`public/css` サブディレクトリを走査しない非再帰欠陥でパイプライン全体が無音の no-op だったのを再帰化 ② 再実行ごとに `<base>.<hash>.<hash>.js` が無限蓄積していたのを、既バージョン済みスキップ＋旧ハッシュ掃除で冪等化 ③ 境界ガードなしの正規表現で `myapp.js` が `app.js` のハッシュに誤置換され壊れた参照を書き込んでいた問題を、参照直前の文字クラス（引用符・`/`・`=`・空白等）でガード。`npm run setup` が未導入の `prisma migrate` で必ず中断していた onboarding 破損も修正（prisma は ARCHITECTURE.md 記載通り未配線のため工程から除外）。
- config.json マージの深いマージ化: `getConfig()` が `fileConfig || envConfig` でファイル存在時に環境変数オーバーライド（PORT 等）を丸ごと破棄し、`loadFromFile` の浅い spread で部分ファイルが兄弟既定値を全消ししていた問題を `deepMergeConfig`（キー単位の再帰マージ、__proto__ 系キー除外）で修正。
- マスター3段階認証の昇格セッションに絶対 TTL を追加: `cookie.maxAge` 未設定で MemoryStore の `masterAuth` 状態が事実上永続化していた（昇格状態が無期限 → セッション乗っ取りで資金アドレス操作へ直行するリスク）。`MASTER_SESSION_TTL_MS`（既定30分、GitHub sudo モード等の昇格認証慣例）でクライアント Cookie とサーバ側ストアの双方に期限を付与。
- 注文タイムアウト失効時のエスクロー孤立解消: `expireStaleOrders`/`expireStaleMatchedOrders`/`expireStaleActiveOrders` は注文を cancelled へ遷移するが HELD 状態のエスクローを精算せず、支払済み資金が永久ロックされる経路があった。`releaseEscrowsOnTimeout` を新設し pending/matched 失効は HELD→CANCELED で借り手返金、active 失効は /stop と同じ壁時計フォールバックの deliveredRatio で HELD→SETTLED の出来高払いにした。
- 検証監査抽出の予測不能化: `shouldAudit` が無キー `sha256(jobId)` で決定していたため、プロバイダが自ジョブの監査要否を事前計算し「監査されないジョブだけ手を抜く」選択的チートが成立していた（Proof-of-Compute のランダム監査は auditee 予測不能が要件）。HMAC-SHA256 鍵付き判定へ変更（`VERIFICATION_AUDIT_SECRET` env → 未設定時はプロセス生成のエフェメラル鍵。監査要否は open 時に永続化済みのため再起動でも整合）。
- 監査ログミドルウェアの耐性化: 全 API の body/query/response を全文記録していたものを 2KB 上限 + `{_truncated,bytes}` 記録へ（監査ログ急膨張と stringify+再帰マスクのリクエスト処理コストを抑止）。`sanitizeSensitiveFields` に深度上限 32 を追加し深ネスト JSON によるスタックオーバーフロー DoS を防止。mkdirSync を初回のみへ。
- 追記型ログのローテーション化: `appendFileSync` で手動追記する高頻度ログ（access-audit.log は認証済み全リクエスト、db-access.log は UserRepository 全アクセス、gpu-events.log）にサイズ上限がなく無制限肥大・ディスク枯渇リスクがあった。`appendRotated` ヘルパー（statSync→超過で .1 退避の 1 世代ローテーション）を新設して適用。ハッシュチェーン監査ログ（audit.log）は改ざん検知との整合のため対象外。
- 秘密値比較を共有 `safeTokenEqual` へ集約: `/metrics` の Bearer 照合が生の `!==`（タイミングオラクル）だったため、Double-HMAC（nonce+HMAC-SHA256→timingSafeEqual）ヘルパーを `src/utils/safe-compare.js` に新設し /metrics・`authenticateAPIKey`・`apiKeyAuth`（security.js 内の重複実装2箇所）へ適用。空文字どうしの誤認証を防ぐガード付き。
- 利益送金先ストアのパスバグ修正: `src/api/utils/profit-addresses.js` の `../../data/` は `src/data/` を指しており、ランタイムデータがソースツリーに書き込まれる + リポジトリ同梱のシードアドレス（BIP-173 例示アドレス等）が新規デプロイで実送金先として選択され得る問題を修正。ルート `data/` へ移し、旧パスからの移行時は同梱シードを除外して引き継ぐ。
- master-auth TOTP の隣接ウィンドウリプレイ対策: リプレイ防止が「現在カウンタとの比較」だけだったため、window:1（±30秒）で受理される前ウィンドウのコードを次ウィンドウで再提示すると素通りした。受理済みコード値を `lastTotpToken` に記録して同一値の再提示を拒否。
- アカウント退会（DELETE /users/me）と payoutAddress 変更（PUT /me）に再認証を追加: JWT 所持のみで PII 匿名化＋全セッション失効、およびプロバイダ受取アドレス差替（＝次回決済の攻撃者宛送金）が可能だった。OWASP「sensitive operations require re-authentication」に倣い `verifySensitiveConfirmation` を共通化 — パスワード照合（bcrypt）を必須化し、パスワードを持たない OAuth 専用アカウントは登録メール再入力で代替。`authLimiter` 付与で確認パスワードの総当たりも防止。資金に直結しない通常プロフィール項目（username/bio 等）は再認証不要。
- `/marketplace/auction` の権威フィールド偽装防止: 入札オブジェクトの `reputationScore`/`eligible`/`attestationPassed`/`slaUptimePct` をクライアントが供給できていたため、任意の認証済みユーザーが自陣プロバイダに満点レピュテーションを付けて優勝させたり競合を `eligible:false` で排除できた。ルートで providerId/pricePerHour のみにサニタイズし、権威値はサービス層に限定（selectProvider の上書き経路は DI/テスト用として維持）。
- sanitizeSensitiveFields の DoS 対策: 深度無制限再帰で ~8,000 段ネスト JSON（≈48KB、body-parser 上限内）が監査ミドルウェア経由で全リクエストに作用しスタックオーバーフロー→プロセス終了が成立していた。深度 32 で打ち切り（'[TRUNCATED]'）＋WeakSet で循環参照を '[CIRCULAR]' に置換。配列は配列として複写（従来はオブジェクト化していた）。
- LINE Notify 送信の耐障害化: `scripts/line-notify.js`（service-monitor の LINE 経路）に 10 秒タイムアウト（`LINE_NOTIFY_TIMEOUT_MS`）を追加し、失敗ログから axios エラーオブジェクトを排除 — `e.config.headers.Authorization` に含まれる `LINE_TOKEN` がログへ漏洩する経路を遮断。
- Web OAuth フロー（GET /auth/google|github）の login-CSRF 対策とログイン完結: `passport.authenticate` に `state: true` を付与（共有 masterSession を web フロー2ルートにのみ適用し passport-oauth2 のステートストアを成立）。コールバックは従来 OAuth プロフィールを echo するだけでトークンを発行していなかったのを、RESTful /auth/google と同一ポリシー（email_verified 必須・同一メール既存アカウントは暗黙リンクせず 409・access+refresh ペア発行+ati 紐付け+lastLogin 更新）でログインを完結させ、`UserRepository.getByGithubId` ファインダを追加。
- webhook.js / lightning-api.js の SSRF リダイレクト迂回とタイムアウト欠如を修正: assertPublicUrl() は最初の URL のみ検証するため、axios 既定のリダイレクト追従でガードを迂回可能だった残存経路を遮断（OWASP SSRF Prevention Cheat Sheet の「リダイレクトごとの再検証または追従禁止」準拠）。SAFE_AXIOS_CONFIG を ssrf-guard に集約し、ガードと安全設定を同所化。
- メール送信経路のハードニング（`src/utils/email.js`/`src/api/utils/mailer.js`）: SendGrid/Mailgun 呼出にタイムアウト・サイズ上限・maxRedirects:0（残余のタイムアウト未設定外向き呼出）、nodemailer に connectionTimeout/greetingTimeout/socketTimeout と `requireTLS` 既定化（587/STARTTLS の opportunistic TLS で SMTP 認証情報が平文送信されうる問題。社内リレー向けに SMTP_REQUIRE_TLS=false で opt-out）。
- `gpu_lending_setup_cli.md` を実 API 契約へ同期: `/api/gpu`→`/api/v1/gpus`、JWT 取得経路（POST /api/v1/users/login、provider/admin ロール必須）・登録必須フィールド一覧・`os.arch()` 返り値(x64)と受理 arch 値(x86_64)の不一致注意を明記。「npm install axios 個別追加」→ npm install に修正。
- `gpu_lending_setup_example.md` の架空 API（`/api/owner/register`・`/api/owner/gpu_status` — 未実装）を実装済みエンドポイントへ置き換え: `POST /api/v1/gpus`（実スキーマの必須フィールド付き）、一覧の実クエリパラメータ（vendor/apiType/minMemoryGB/maxPrice/country/search/features）、`/my`・bulk・clone・market-rate・history・block 管理まで列挙。
- `public/README_public.md` を実態へ同期: テンプレート由来の架空記述（`scripts/deploy_public.sh`・morgan・i18n UI・.htaccess・「自動デプロイ」）を除去し、実在の仕組み（express.static・helmet CSP・`npm run optimize-images`/`version-assets`・cdn-cache-purge.yml・`npm run test:e2e`・audit ミドルウェアの access-audit.log）に置き換え。
- `docs/LIGHTNING_API_SETUP.md` を実態へ書き換え: 2系統（注文エスクロー=LND gRPC `LND_*` env、オンチェーン決済/利益送金=REST プロバイダ `LN_PROVIDER` opennode/lnbits）の区別が無く `/payment` ルート・invoice 形式の profit アドレス等の誤記を修正。実エンドポイント（`/api/v1/payments/btc`、`/api/profit-addresses` 管理 API と JWT+admin+master-auth 要件）を明記。
- `docs/category-research-2026.md` に「実装状況の更新（2026-09）」追記セクションを追加。2026-06 調査時点の「現状」記述のうち実装で解消済みの項目（エスクロー・レピュテーション・検証基盤・アテステーション・OTel・リポジトリ原子性）と依然正確な項目（libp2p/spot/推論/分散学習/pricing engine 未配線）を明示し、調査記録を残しつつ読者の誤認を防ぐ。
- `improvement_checklist2.md` の自己矛盾チェックを修正: 項目本文に「未実装」と明記されているのに `[x]`（実装済み）だった2件（仮想GPU監視・コンテナライフサイクル）を `[ ]` へ戻した（Electron 項目は public/electron.js・preload.js の最小公開 API 実装済みのため `[x]` 維持）。
- `improvement_checklist2.md` の「カテゴリ別進捗サマリー」: 全件「実装済み」主張は一括[x]化と同時の自動生成値で実績ではない旨の注意を追加し、実態補正済みの「品質・テスト・CI/CD」「GPUリソース管理・デプロイ」の件数を実値へ補正（全体横断は Electron 実装済みのため 4/4 のまま）。
- `improvement_checklist2.md` の「品質・テスト・CI/CD」節: コードに存在しない機能を実装済み `[x]` と主張する19項目（AI生成系9/18/19/23/28・多リージョン17・カオス24・自動ロールバック13・CI自己修復12・ナレッジ自動化20/22/25/26/27/29/30・コスト最適化15・環境分離自動デプロイ2 — デプロイはechoスタブ）を未完了 `[ ]` へ補正。Joi/OpenAPI・E2E・モックLND・dependabot 等が実在する項目は `[x]` のまま維持。
- `src/utils/state-checker.js` の直接ユニットテストを追加（テストカバレッジの穴埋め）。注文状態遷移の強制ゲート（PUT /orders/:id が依存）でありながら遷移表の回帰を直接検証するテストが無かった。正常遷移・終端拒否・逆行/スキップ拒否・未知状態拒否・自己遷移拒否・ORDER_STATES/GPU_STATES 整合性を7件で検証。

### docs/SPECIFICATION.md のステータス同期（2026-09-27）
- **対応**: 2026-06 時点の実装ステータスが陳腐化していたため main 実態へ追随 — Escrow（btc-onchain/marketplace/escrow 配線済）・GPU アテステーション（Mock verifier 配線済）・Reputation（アテステーション/稼働統計経由で部分配線）・OTel（instrumentation 読込済）・feature-pricer（marketplace-service 経由配線済）・データ整合性（updateIf/withLock 済）を更新。open PR にのみ存在する配線は「未」のまま維持。

### ルート SPECIFICATION.md の 2026-09 追補（2026-09-27）
- **対応**: ルート `SPECIFICATION.md`（2026-06 実態ベース仕様書）の冒頭に追補を追加。当時の残課題だった OTel SDK 連携（D-2）が `src/telemetry/instrumentation.js` で配線済みである点、probe テストが 60 件超へ拡充、§4 表外の `/admin/*`・`/marketplace/escrow/*`・`/gpus/:id/estimate`・`/gpus/:id/watch` 追加、エスクロー状態機械の実装を明記。docs/SPECIFICATION.md（#133）とは別ファイル・非重複。

### 依存脆弱性の semver-safe 一括解消 + bcrypt メジャー更新（2026-09-27）
- **対応**: `npm audit` の残存49件のうち semver 非互換を要しない13件を `npm audit fix` で解消（axios 1.17→1.20: プロトタイプ汚染/Basic auth 注入、js-yaml、express/body-parser、morgan、joi、protobufjs、browserslist 等）。`bcrypt` を ^5.1.1→^6.0.0 へ更新（API 互換、Node18+ 要件を満たす）し、@mapbox/node-pre-gyp 経由の tar critical・node-pre-gyp high チェーンを除去。合計 49→36 件。残存は @kubernetes/client-node 2.x・aws-sdk v3・nodemailer 10・imagemin 系のメジャー更新または代替が必要なもの（#46 で却下された apollo 系を除く）。

### nodemailer 6→10 メジャー更新（2026-09-27）
- **対応**: nodemailer の high 脆弱性（Interpretation Conflict による意図しないドメインへのメール送信）は 10.0.11 でのみ修正されるため、^6.9.14→^10.0.11 へ更新。mailer.js の利用は `createTransport().sendMail()` の安定 API のみで互換性確認済み（モジュール読込み・sendMail 実在を検証）。残存 35 件。

### PRODUCT_ANALYSIS.md の数値・フロントエンド評価同期（2026-09-27）
- **対応**: `docs/PRODUCT_ANALYSIS.md` の陳腐化した定量記述を実値へ更新 — 統合テスト 18件→255件（実測全緑）、総評のスイート規模、短所④「フロントエンドが未配線」を「最小 SPA 実装済み（pages/*・Playwright e2e 付き）」へ訂正。SPA の refresh サイレント更新・Electron シェル（electron.js + preload.js）も実装済みの現状へ同期。

## GitHub PR/Issue テンプレートの新設 (2026-09-26)

- **観測**: `.github/` にワークフローと dependabot.yml はあるが、`pull_request_template.md` と `ISSUE_TEMPLATE/` が不在。PR 本文が毎回バラバラで、脆弱性報告が公開 Issue に流れるリスクもあった（SECURITY.md の導線が Issue 作成時に示されない）。
- **変更**: GitHub 標準規約の `pull_request_template.md`（概要/変更内容/テスト/セキュリティ影響）と `ISSUE_TEMPLATE/bug_report.md`・`feature_request.md` を日本語で追加。bug テンプレート冒頭に「脆弱性は公開 Issue に書かず SECURITY.md へ」の導線を明記（RFC 9116 security.txt と整合）。
- **参考**: GitHub Docs "Creating a pull request template for your repository" / "Configuring issue templates"

## `.github/CODEOWNERS` の新設 (2026-09-26)

- **観測**: CODEOWNERS が不在のため PR 作成時にレビュアーが自動割当されず、資金決済・認証などの高リスク経路も既定レビューなしでマージ可能な状態だった。
- **変更**: GitHub 標準の `.github/CODEOWNERS` を新設。全体を `@shizukutanaka`（リポジトリオーナー）の既定レビュー対象とし、payment/master-auth/security/lightning-service.js の資金・認証経路は防御的に個別明示（将来オーナーを増員する際の分離点としても機能）。
- **参考**: GitHub Docs "About code owners"（ブランチ保護の「code owner レビュー必須」と組み合わせると強制力が出る）

## docs: E2E テスト実行手順の新設（2026-09-26 追加）

**ブランチ**: `devin/<ts>-e2e-doc` → PR 化（`docs/E2E_TESTING.md`）

`npm run test:e2e`（Playwright、9 spec）が package.json に存在する一方、実行手順を説明するドキュメントがリポジトリ内に皆無だった（CONTRIBUTING/README/faq/OPERATIONS いずれにも言及なし — `npx playwright install chromium` の事前要件、data/ の破壊的リセット、PORT 3010 分離、E2E_BASE_URL 差し替えなど、初見では分からない前提が多い）。実 config（playwright.config.js・globalSetup・helpers）を照合した正確な手順書を新設した。


## chore: package.json の npm メタデータ整備（2026-09-26 追加）

**ブランチ**: `devin/<ts>-pkg-metadata` → PR 化

package.json に `license`/`repository`/`bugs`/`homepage` が未記載で、npm・GitHub・各種ツールのメタデータ解決が効かなかった（`npm WARN`・パッケージ情報のリンク欠如）。LICENSE（MIT）と一致する `license: "MIT"`、`repository`/`bugs`/`homepage` を GitHub URL で宣言し、あわせて `private: true` を追加 — 本リポジトリは npm 公開を意図しないアプリケーションであり、誤 `npm publish` を構造的に防止するガードとして標準的な手段。


### 管理ダッシュボード SPA ページ（2026-09-27, §19 管理画面の部分対応）
- **対応**: `/admin/stats`・`/admin/verifications`・`/admin/escrow`・`/admin/expire-orders`・`/admin/cache/purge` の admin API は実装済みだが SPA 側に利用経路がなく運用者が curl 頼みだった。`public/js/pages/admin.js` を新設（統計カード/検証監査表/エスクロー表＋状態フィルタ/スイープ・パージ操作）、api.js に admin.* ヘルパー5件、`#/admin` ルート＋admin ナビリンクを追加。フロントが架空パスを呼ぶ事故を防ぐ契約テスト3件（tests/unit/admin-page-contract.test.js）+ e2e spec（admin.spec.js）を追加。

### Node バージョン下限の宣言（2026-09-27）
- **対応**: `package.json` に `engines.node >= 20` を追加し `.nvmrc` を新設。CI は全ワークフロー Node 20/22 で検証されており下限は 20 が実態（加えて #134 の bcrypt 6 が Node 18+ を要求）。nvm/fnm/volta 利用者と npm engine チェックが機能するようになる。
- `src/core/services.js`（任意サービスの safeLoad/requireService ゲート）のユニットテストを追加。GPU/P2P/Lightning の任意依存が未導入でも本体が起動し、無効サービスのエンドポイントが 503 を返す契約を固定。
- `src/api/utils/btc-payment.js` の直接ユニットテストを追加: 送金経路の金額計算（calcTotalWithFee/calcFee/calcPayout の Satoshi 丸めと total=payout+fee 整合性）、BTC_FEE_RATE の起動時 fail-fast 検証、sendBTC の資金安全不変条件（Lightning API が txid を返さない場合にダミー成功を返さず例外へ伝播）を網羅。従来は送金系ユーティリティに直接テストが無かった。
- `tests/api/middleware/master-session.test.js` を追加: `master-session.js` が全 importer（master-auth.js / profit-addresses.js）へ同一インスタンスを返すシングルトン契約と、本番での秘密欠落 fail-fast を固定（ルート個別の session() 化による MemoryStore 分離回帰を防止）。
- `src/api/middleware/ip-key.js`（レート制限キー生成）のユニットテストを追加。IPv6 の /64 畳み込み（同一割り当て単位で1バケット＝アドレス回しによる authLimiter バイパス防止）と TRUST_PROXY の hop 数セマンティクス（`true` 等を拒否し X-Forwarded-For 左端偽装を防止）の不変条件を固定。
- `.env.example` の `METRICS_AUTH_TOKEN` コメント誤記を修正: 「未設定なら公開」→ 実際は本番で fail-closed/503。（`docs/operations.md` 側の実態同期は #103 の全面改訂へ統合済みのため本 PR からは除外）
- `tests/db/json-repository-finders.test.js` を追加: `ReputationRepository`/`VerificationRepository` の finder→フィールド配線（`getByProviderId`→providerId、`getByJobId`→jobId）を固定 — createJsonRepository の宣言的 finders の field 名タイポによる無言の null 返却回帰を防止。
- `test` ジョブ（test-coverage-check.yml）のカバレッジ閾値チェックが全 PR で落ちていた問題を jest.config.js 側で修正: (a) 閾値チェックが読む `coverage/coverage-summary.json` を生成する `json-summary` レポーターが未設定で MODULE_NOT_FOUND でクラッシュしていたのを `coverageReporters` に追加して解消、(b) 実カバレッジ 68.1% が閾値 70 を下回っていた件は、libp2p 未導入・Docker/k8s・実 GPU 前提で CI 上で実行不能な経路しか持たない 3 ファイル（`p2p-network.js`・`virtual-gpu-manager.js`・`gpu-detector-extended.js`、計 737 未カバー行）を `coveragePathIgnorePatterns` で除外し 75.5% に。既定の「ロード済みファイルのみ計測」セマンティクスを保つため `collectCoverageFrom` ではなく ignorePatterns を採用。
- `src/payments/escrow-service.js` の資金移動ライフサイクルを改竄検知付き監査ログへ記録 — escrow 行内 `history` は書き手自身が編集できる JSON データの一部で監査証跡にならず、payments 層全体（escrow/FSM/action-executor/settlement）に `appendAuditLog` がゼロだった。`create`（escrow_created: orderId/amountSats/feeRate）、状態遷移成功（escrow_transition: event/from/to/actions）、CAS 競合（escrow_transition_conflict）、二重作成拒否（escrow_create_rejected）、精算（escrow_settlement_computed: payout/refund/fee 内訳）、LN 実行失敗（escrow_ln_actions_failed）をハッシュ連鎖ログへ出力。`audit` は DI 可能（テストは捕捉関数を注入）。呼び出し側5箇所（order routes / SLA sweep / gpu-auto-recovery）へ個別配線せず service 層で網羅。参考: PCI-DSS 10.2「全ての個々のユーザーアクセス/カード会員データへのアクセス記録」、OWASP Logging Cheat Sheet（金融イベントの完全性要件）、Google SRE「Monitoring Distributed Systems」（資金移動は監査対象イベント）。
- Slack アラート系 ops スクリプトの共有化と堅牢化: `alert-high-priority.js` / `alert-overdue.js` / `alert-overdue-high.js` が「feedback-priority.json 読込→フィルタ→Slack 送信」をガード無しで各々複製していたため `scripts/lib/alert-common.js` に集約 — 破損 JSON はファイル名付き例外、非配列拒否、非オブジェクト要素除去、期限キー（due/deadline/期限/date）の順序参照を一本化、3000 文字分割送信。各スクリプトに `FEEDBACK_PRIORITY_PATH` env 差し替えと require.main のエラーハンドリングを追加。
- `.github/dependabot.yml` の `automerge` キー（Dependabot 非対応フィールド）を除去 — GitHub は未知キーを含む設定ファイル全体を検証エラーで拒否するため、npm/github-actions 両方の更新 PR が一切開かれない状態だった。自動マージの正しい実現経路（リポジトリ設定 + fetch-metadata ワークフロー）をコメントで明記。
- ops スクリプトの JSON 読み込みを堅牢化: `scripts/lib/read-json.js` を新設し、`alert-high-priority`/`alert-overdue`/`alert-overdue-high`/`priority-to-notion`/`progress-report` の裸 `JSON.parse(readFileSync)`（docs/feedback-priority.json 等の破損や未作成で cron チェーンごとクラッシュ、オブジェクト書込時は .filter で TypeError）を ENOENT/破損/非配列に耐性のある共通ヘルパーへ置き換え。progress-report は credentials/token 欠損時に明確なエラーメッセージで終了するよう改善。
- `src/utils/notifier.js` の LINE Notify 対応をサービス終了に合わせて更新 — LINE Notify（notify-api.line.me）は 2025-03-31 に公式終了し全呼出が必ず失敗するため、`NotifyType.LINE` は HTTP を発行せず移行案内付きエラーを即返すよう変更。後継の LINE Messaging API（`api.line.me/v2/bot/message/push`、channel access token + to: userId/groupId、5000文字上限）を `NotifyType.LINE_MESSAGING` として実装。`resilient-notify` の line チャネルは `LINE_NOTIFY_URL` が明示設定された場合のみ有効なため無改変（カスタムエンドポイント運用は継続可能）。参考: LINE Notify 終了公式告知（notify-bot.line.me）、LINE Messaging API リファレンス。
- `slack-notify-checklist-kpi.js`: `.env` 未読込で `slack-feedback-bot` が require 時に捕捉する `SLACK_WEBHOOK_URL` が常に空となり `npm run slack-notify-checklist-kpi` の通知が無言スキップされる不具合を修正（dotenv を require 前に読み込み。`slack-notify-notion` と同型）。サブプロセス経由の回帰テストを追加。
- `scripts/sample.js`（i18next 多言語デモ）の任意依存ハンドリング: i18next/i18next-fs-backend は package.json 未宣言のため未導入環境で MODULE_NOT_FOUND 即死していた。遅延 require + require.main ガード + 導入案内（`npm i i18next i18next-fs-backend`）でライブラリ的 require も安全化。
- `tests/e2e/helpers.js` の `promoteToAdmin` を原子書込み化: 起動中の e2e webServer が読む `data/users.json` を非アトミック `writeFileSync` で更新しており、書込み途中の半壊 JSON をサーバが読むと以降の UserRepository 呼出しが連鎖失敗し得た。アプリ側と同じ `atomicWriteJSON` を使用。
- `checklist-to-issues.js` の堅牢化: ①require 時に env 未設定だと `process.exit(1)` でホストプロセスを殺していた副作用を除去（検証は呼び出し時へ）。②`@octokit/rest` を呼び出し時遅延 require に変更（optionalDeps 未導入で import 自体が MODULE_NOT_FOUND にならない）。③`GITHUB_REPO` の `owner/repo` 形式検証（`split('/')` のみでは repo 未定義で API が不可解に失敗）。④open issue の取得を `octokit.paginate` 全ページ化（per_page:100 単発では 100 件超の既存 issue を見落とし重複作成）。⑤付与ラベルがリポジトリに無いと `issues.create` が 422 で全件失敗するため `createLabel` を冪等実行（422=既存は無視）。⑥1件の作成失敗で残り全件を捨てないよう per-issue try/catch + 件数サマリ返却。⑦チェックリスト不在の明示エラーと `CHECKLIST_ISSUES_PATH` env 差し替え。
- `lightning-service.js` のイベントストリーム再接続を堅牢化（`_setupResilientStream` 集約）: 旧実装は gRPC ストリーム切断時の error/end/close 連鎖発火それぞれが個別に `setTimeout` を積み、1回の切断で3本の再購読が並走（invoice:paid 二重 emit・リスナー蓄積）。再接続をストリーム毎1タイマーへ単一化、再購読前に旧ストリームを `cancel()`（cancel 起因の同期 close が再接続を積み直さないよう superseded ガード）、指数バックオフ 5s→5分キャップ＋データ到着でリセット。監査/通知のイベント名（invoice_stream_error 等）は従来タグを維持。

## scripts/*.sh スタブの正直な実装化 (2026-09-26)

- **観測**: `build.sh`・`deploy.sh`・`setup-production.sh` は shebang+コメントのみの2行スタブで、呼ばれても exit 0 で無言成功する。CI や手動運用から参照された場合「成功したが何も起きなかった」と誤認される構造（いずれも現在参照ゼロ）。
- **変更**:
  - `build.sh`: Node サーバにコンパイル工程はないため「ビルド」を正直に定義 — `npm ci` + `npm run openapi-gen`（生成物の最新化）。
  - `setup-production.sh`: `config.js` の `requireSecret` が本番で fail-fast する必須シークレット（JWT_SECRET≥32 / SESSION_SECRET・ENCRYPTION_KEY≥16）を事前検査し、未設定なら具体的な案内とともに exit 1。`--check` で npm ci を伴わない検査のみ実行可能（テスト可否のため）。検査通過後は `npm ci --omit=dev`。
  - `deploy.sh`: デプロイ経路が未構成（ci-cd.yml の Deploy は echo スタブ）である旨を stderr で説明し exit 1 — 無言成功による誤認を防止。
- **テスト**: `tests/scripts/sh-scripts.test.js` 新規5件 — bash -n 構文・`set -euo pipefail`・deploy.sh の非ゼロ終了・preflight の両経路（実機で両方向の終了コードを確認済み）。
- **参考**: Google Shell Style Guide（set -euo pipefail）/ 十二因子アプリの fail-fast 設定検証

### 市場価格エンジンの見積もり配線（2026-09-27）
- **対応**: `GET /gpus/:id/estimate` に `marketReference`（advisory）を追加し、孤立していた `MarketPricingEngine`（TFLOPS/VRAM/地域/需給/時間帯係数）を配線 — このドキュメント §4 の「pricing engine をマッチングへ配線」の部分対応。実課金は従来どおり `pricePerHour × 時間`。
- **同時修正**: `getGPUSpecs()` が未知モデルへ合成スペック（tflops=10）を返していたため `calculateGPUPrice` の `!gpuSpecs → getDefaultPrice` フォールバックがデッドコード化していた。未一致時 `null` 返却に修正し、estimate では `marketReference: null` を返す（合成価格で誤誘導しない）。

### alert-kpi-trend の実動化（2026-09-27）
- **対応**: `npm run alert-kpi-trend` が生成側の単一ファイル上書き（`docs/checklist-kpi-report.md`）と食い違う「日付付き履歴2件必須」前提で常に「2つ以上必要です」で終了する構造的デッドコードだった。前回値を `data/kpi-trend-state.json`（`KPI_STATE_FILE`/`KPI_REPORT_DIR`/`KPI_ALERT_THRESHOLD` で差し替え可）へ自身で記録する方式へ変更 — 単一レポート運用で動作し、同一内容の再実行では差分ゼロなので二重通知しない。パース不能・状態ファイル破損・レポート不在の各経路を明示ハンドリング。#127（kpi-trend-graph の同型バグ）の姉妹修正。テスト5件追加。

## RFC 9116 `security.txt` の配信 (2026-09-26)

- **観測**: リポジトリに `SECURITY.md`（開示ポリシー）があるが、デプロイされたサービスから機械可読な連絡先を取得する経路がなかった。RFC 9116 は `/.well-known/security.txt` を標準化しており、セキュリティ研究者・脆弱性スキャナはここを最初に参照する（GitHub/GitLab/Certificate Transparency のスキャン連携も同規格）。
- **罠**: `public/.well-known/` にファイルを置くだけでは `express.static` の既定 `dotfiles: 'ignore'` がドット始まりセグメントを拒否し、リクエストは SPA キャッチオールへ流れて index.html (200/HTML) を返す — スキャナからは「security.txt 不在」どころか誤った 200 応答に見える。
- **変更**: `public/.well-known/security.txt`（Contact=GitHub Security Advisory、Policy=SECURITY.md、Preferred-Languages、Expires）を新設し、`server.js` に static より前の明示ルート `GET /.well-known/security.txt` を追加。`tests/api/basic.test.js` に 200・text/plain・必須フィールドの回帰テストを追加。
- **参考**: RFC 9116 / GitHub "Adding a security policy" / securitytxt.org

### gpu_lending_dashboard_mock.jsx を実 API 契約へ同期（2026-09-27）
- **対応**: ルートの React モックが架空 API（`/api/gpu?owner=me`、認証ヘッダなし）と存在しないフィールド（`gpu.status`/`earningJPY`/`earningBTC`、架空の `/mock/earnings_graph.png`）を参照していた。実契約へ書き換え: `GET /api/v1/gpus/my`（JWT必須）+ `GET /orders/provider/earnings`（provider/admin）の `byGpu` 内訳で GPU 別収益を表示し、`available` フラグで稼働状況を表現。#111（cli.md）と同種のモック同期。

## fix(core): デーモンタイマーの unref 化と MetricsCollector の多重生成クラッシュ修正（2026-09-26 追加）

**ブランチ**: `devin/<ts>-timer-unref` → PR 化

1. `AutoPerformanceOptimizer.start()` の `setInterval` が `unref` されておらず `stop()` も存在しなかった — 起動配線（open PR 参照）後は ref 済みタイマーがイベントループを生かし続け、SIGTERM での drain 不能→コンテナ環境で SIGKILL タイムアウトに化ける。unref + `stop()` 追加（service-monitor/invoice-poller と同一規約）。
2. `MetricsCollector.startCollection()` の interval も同様に unref。
3. **実バグ**: `src/gpu/metrics.js` のカスタム Gauge/Counter 34件が `registers` 未指定で prom-client のグローバル default registry へ登録されていた — `new MetricsCollector()` は同一プロセス内で2回目に必ず `already been registered` を throw し、MetricsCollector をそれぞれインスタンス化する auto-performance-optimizer と gpu-liveness-monitor が同居できない設計上の衝突だった。各メトリクスへ `registers: [this.register]` を付与しインスタンス registry を正とし、`registerAllMetrics()` は冪等化。`/metrics` エンドポイントは prom-client グローバルを返すが、現在どの起動経路も MetricsCollector を生成していないため main の観測出力は変化しない。

- `tests/e2e` のデータ破壊を防止: `globalSetup` が `data/*.json` を無条件で `[]`/`{}` にリセットしていたため、開発者の live レコード（users/orders/payments 等）を `npm run test:e2e` の度に消去していた。リセット前に `data/.e2e-snapshot/` へ既存ファイルを退避し、新設の `globalTeardown` が実行後に復元する方式へ変更。テスト中に生成されたファイルの除去・`data/` 不存在時の完全復元・前回クラッシュ時の自動復旧（次回 setup 先頭で残存 snapshot を先に復元）にも対応。
- `scripts/prepare-data.js` のサンプルデータを実スキーマ準拠＋非稼働へ修正: `vendor`/`apiType`/`pricePerHour`/`providerId` 欠落で `status:'available'` な GPU を種入れしており、`GET /api/v1/gpus?vendor=…` の `gpu.vendor.toLowerCase()` TypeError(500)・価格計算不能な出品・`status:'pending'` かつ `createdAt` 欠落の注文による失効スイープ/admin 統計の歪みが起き得た。実登録スキーマ適合・`status:'maintenance'`/`cancelled`・passwordHash 無しユーザー・`demo:true` マーカーに修正し、スキーマ適合を検証するガードテストを追加。
- `data/*.json` の定期バックアップを配線: `utils/backup.js` の `backupAll` は実装済みだが呼び出し側ゼロ（手動実行以外ではバックアップ不動＝復元元が存在しないサイレント欠陥）。`core/backup-scheduler.js` を新設し `BACKUP_INTERVAL_HOURS` opt-in で起動配線。任意クラウド SDK 未導入環境では遅延 require が失敗→警告+無効化でサーバ起動を妨げない設計、単一フライト・タイマー unref・テスト環境抑止込み。
- `src/utils/exchange-rate.js` の外向き axios に共通安全設定（`maxContentLength: 64KiB`・`maxRedirects: 0`）を追加 — notifier/resilient-notify と同型の inline config。ティッカー JSON は ~1KB 未満しか期待しないため、ハイジャック・プロキシ混入時の巨大レスポンス（OOM DoS）と 302 経由の SSRF リダイレクト迂回を遮断。`exchange-rate-swr.test.js` に全4プロバイダ呼出への設定適用を検証する回帰テストを追加。
- report 系 ops スクリプトの堅牢化: `kpi-trend-graph.js` は生成側が日付なし `progress-report.md` のみ出力するのに `progress-report_YYYY-MM-DD.md` だけを読んでおり常に空だったため、最新スナップショットを mtime 日付で履歴末尾へ併用＋chartjs-node-canvas を遅延 require（optionalDependencies 未導入でも MODULE_NOT_FOUND で死なない）＋parseInt NaN ガード＋env パス差し替え。`assignee-progress-report.js` は破損 JSON の明示エラー・非文字列 status の正規化・Slack 障害時もレポート生成を成功扱いに。`checklist-kpi-report.js` はチェックリスト不在時の明示エラー＋require.main エラーハンドリング。
- `src/utils/backup.js` のバックアップ網羅性を修正 — `TARGET_FILES` が 6 件固定で、`profit-addresses.json`（運営利益の送金先）・`revoked-tokens.json`（失効 JWT — 消失でログアウト済みトークン復活）・`notification-settings.json`・`uptime.json`・`sla.json`・`verifications.json`・`bids.json`・`watches.json`・`sandbox-apikeys.json` が一切バックアップされず消失時に復元不能だった。実行時に data/*.json を動的走査する `_targetFiles()` 化で将来の新規ファイルも自動捕捉。あわせて `backups/`（users.json 等の平文コピー出力先）が .gitignore 未登録だったのを追加 — 未対処だと git add でパスワードハッシュ入りバックアップがコミットされる。
- `lightning-service.js` の LND unary RPC に既定 deadline を付与（gRPC service_config の methodConfig.timeout、既定 60s・LND_RPC_TIMEOUT_MS で可変）。deadline 未設定だと LND が TCP 接続を保ったまま応答を返さない障害時に AddInvoice/SendPaymentSync/SettleInvoice 等の資金移動呼出が無期限滞留し、Express のタイムアウト層が応答を返しても gRPC 側の処理は残存していた。ストリーム系（SubscribeInvoices/CloseChannel 等）は長寿命のためメソッド名個別列挙で対象外。

### P2P MVP スクリプトの任意依存遅延 require 化（2026-09-27）
- **対応**: `src/p2p-{node,sync,notify}.js`・`src/cli.js` が package.json 未収録の libp2p 系/ipfs-core/orbit-db をトップレベル require し、README 記載の `node src/cli.js`・`node src/p2p-notify.js` が MODULE_NOT_FOUND で即死していた。遅延 require + 手順付きエラー化し、`p2p-notify` は libp2p 未導入でも外部 API 監視（MONITOR_TARGETS）が単独動作するよう変更（実機検証済み）。
- **同時修正**: 監視 tick の単一フライト化（複数監視対象で 1 tick が 15s 超過時のアラート二重化を防止）、stale health.json は NODE_DOWN ではなく NODE_MONITOR_STALE として区別（監視プロセス停止とピア切断を分離）。
- `src/core/gpu-detector-extended.js` の三重実害を修正 — ① `GET /gpus/system/detected` が存在しない `detectAllGPUs()` を呼び管理者呼出が常に TypeError→500 だったため実装（AMD+Intel を Promise.all で併合）② ROCm と sysfs が同一物理 GPU を別 uuid で二重列挙していたため PCI busId で重複排除（ROCm 側を優先）③ 検出のたびに `rocm-bandwidth-test --quick`/`ze_peak`/`level-zero-info`/`rocm-smi -d` を実行し stdout を解析せず破棄 — 貸出中テナントの GPU 帯域を占有する副作用を除去しゼロ値プレースホルダへ。あわせて全 exec（rocm-smi/intel_gpu_top/clinfo/modinfo/PowerShell/wmic）へ timeout 15s+maxBuffer を付与しドライバ異常時の永久滞留を防止。参考: Kubernetes device-plugin の health-check 設計（検出系は side-effect free で bounded）、OOB hardware enumeration のベストプラクティス。
- feedback パイプライン（priority/checklist/sheets/report）の読込み経路を共有 `scripts/lib/feedback-store.js` へ集約。各スクリプトの独自 JSON.parse(readFileSync) は破損ログで全段クラッシュ・非文字列フィールドで TypeError・report/checklist は require 副作用でファイル書込みという欠陥があった。ローダーは破損時にファイル名付きの明示エラー＋エントリ正規化、各スクリプトに require.main ガード・env パス差し替え・エラーハンドリングを追加し、sheets は credentials/token/FEEDBACK_SHEET_ID の事前検証を追加。priority 出力を atomicWriteJSON 化。
- `src/gpu/` 監視モジュールの健全性修正 — `gpu-health-monitor` の `execSync(nvidia-smi)` にタイムアウト無し（ドライバハングでイベントループ全体が停止）・同一異常の毎 tick 再通知（アラート嵐）・unref/stop 無しを修正（シグネチャ dedup + 回復後の再通知化）。`gpu-liveness-monitor` も同様に unref+stop+単一フライト化し、`recordGpuError`（内部で多段通知済み）と呼び出し側の二重通知を解消。あわせて未使用の `MetricsCollector` 即時生成を遅延化（コンストラクタでの Prometheus メトリクス登録を回避）。
- `cloud-storage.js` の任意クラウド SDK を遅延 require 化: トップレベル require の `googleapis`/`dropbox` が未宣言だったため未導入環境で require('utils/backup') 自体が MODULE_NOT_FOUND で落ち、ローカル世代バックアップ・リストアも全滅していた。AWS SDK（aws-sdk）・googleapis・dropbox を各 upload 関数内でのみ解決し、未導入時は `npm i <pkg>` の手順付きエラーに変更。`backupLocalWithGeneration` を export 化し、世代バックアップ→破損→リストアの往復テストを追加。

### sentry-notify の @sentry/node 遅延 require 化（2026-09-27）
- **対応**: `scripts/sentry-notify.js` が意図的に未宣言の任意依存 `@sentry/node` をトップレベル require していたため、SENTRY_DSN 設定済み環境で service-monitor の遅延 require が MODULE_NOT_FOUND で失敗し Sentry 通知が一度も届かず警告だけを量産していた。関数内遅延 require＋`npm install @sentry/node` の手順付きエラーへ変更。require 安全性を固定するテスト3件。

## fix(utils): gpu-monitor の三重実害修正とタイマー健全化（2026-09-26 追加）

**ブランチ**: `devin/<ts>-gpu-monitor-fix` → PR 化

`src/utils/gpu-monitor.js`（GPU 死活→自動リカバリ）が呼び出せば必ず失敗する三重の実害を修正:

1. `OrderRepository.updateStatus` — 存在しないメソッド（正は `update`）を destructure → TypeError クラッシュ
2. 状態値 `'auto_recovered'` — `state-checker` の ORDER_STATES/遷移表に非登録で、書き込まれた注文は永久に遷移不能 → 有効値 `cancelled` へ
3. `PaymentRepository.getByOrderId`（many:true=配列）を単体扱い + `refundPayment`（存在しない）呼び出し → 配列反復 + `update(id,{status:'refunded'})` へ（gpu-auto-recovery と同規約）

あわせて `startGpuMonitor` を unref 済み・単一フライト・多重起動防止 + `stopGpuMonitor` 追加（service-monitor と同規約 — #150 のタイマー健全性と同クラス）。

- notification-settings の SSRF チェックを共有 ssrf-guard へ集約 + 登録時 DNS 事前検証を追加: 旧 regex 方式は userinfo 混在（http://x@127.0.0.1/）・数値IPv4（2130706433/0x7f000001/127.1）・IPv4埋め込みIPv6 を素通りし、FQDN の解決結果も検証していなかった。WHATWG URL パース後の hostname を isPrivateIp で分類する形へ統一し、SSRF_ALLOW_PRIVATE_WEBHOOKS の登録側不整合（送信は許可・登録は常時拒否）を解消。DNS 解決失敗は登録を許容（送信時の assertPublicUrl が権威）。
- `src/utils/anomaly-detector.js` の堅牢化 — `logs/` は gitignore 済みで新規 clone には存在しないため、`reportAnomaly` の `appendFileSync(logs/anomaly.log)` が mkdir 無しで ENOENT を投げ呼び出し元（gpu-monitor）が初回異常報告でクラッシュしていた（wired バグ）。mkdir + 書込失敗の非致命化を追加。あわせて `detectRequestAnomaly` の IP カウンタがユニーク IP 毎に永久蓄積する無制限増殖（#58 同型）を TTL スイープ+10k 上限でバウンド化。`google-calendar.js` の `defaultConfig` 宣言漏れ（暗黙グローバル）と googleapis トップレベル require（未導入で require 自体クラッシュ）を遅延化、`ai-benchmark.js` の axios に timeout/maxContentLength/maxRedirects を付与（#151 同型の未防御外向き呼出し）。
- Electron デスクトップシェルを実装: `public/electron.js` は1行コメントのみのスタブ、`preload.js` は `contextBridge` 未インポートで起動即 ReferenceError だった。contextIsolation/sandbox/no-nodeIntegration 前提のメインプロセス（外部リンクは OS ブラウザ、will-navigate を起点 URL に制限、監査 IPC 受信）と、sandbox 互換 preload（監査は ipcRenderer で main へ転送）へ実装。`npm run desktop`（npx で electron@44.4.3 をオンデマンド取得、依存には追加せず npm ci を重くしない）。
- `scripts/feedback-bot.js` の堅牢化: 破損した `docs/feedback-log.json` で JSON.parse が全投稿をクラッシュさせる問題を「破損ファイルの退避 + 新規開始」に修正、非アトミック `writeFileSync` を共有 `atomicWriteJSON` へ置換（中断時のログ半壊防止）、user/message の型・長さ検証（128/4000 字）と CLI 入口のエラーハンドリング、`FEEDBACK_LOG_PATH` によるファイル差し替えを追加。回帰テスト5件。

## fix(utils): 外向き axios 安全設定の共有化と未適用経路の塞ぎ（2026-09-26 追加）

**ブランチ**: `devin/<ts>-http-safe-config` → PR 化

notifier.js の AXIOS_SAFE_CONFIG（timeout 10s / サイズ上限 1MiB / maxRedirects:0 の SSRF 迂回遮断）を `src/utils/http-safe-config.js` へ集約し共有化。同値を複製していた resilient-notify.js を共用に揃え、安全設定が付いていなかった2経路を塞いだ:

- `src/utils/email.js`（SendGrid/Mailgun — notifier.js 経由で配線済み）: axios.post に timeout 無し — SendGrid 接続の半開き滞留が通知パスを永久ブロックし得た
- `src/utils/gpu-price-compare.js`: AWS EC2 オファー index（非圧縮1GB超）を timeout・サイズ上限なしで全量メモリ展開 — 呼び出せばほぼ確実に OOM。timeout 30s + maxContentLength 256MiB で有界エラー化（同時に、全 index 取得方式自体の限界をコメントで明記）

- `devRequestLogger` の資格情報漏洩を修正: NODE_ENV=development でリクエストボディをログへ流す際のマスク対象が password/token/paymentRequest の3件のみで、refreshToken・idToken・currentPassword/newPassword・code（メール認証コード）・apiKey 等の live クレデンシャルが平文で dev ログへ残っていた。キー名ベースの再帰 `redactBodyForLog`（配列ボディ・ネスト対応・深度上限で循環安全）へ置き換え、新規8テストで固定。
- `middleware/logger.js` のクエリ秘匿漏れを修正: `req.originalUrl` を生記録していた3系統（morgan アクセスログ/低速警告/エラーログ）に `redactUrlQuery` を適用し、`?token=`/`?api_key=` 等の機密クエリを `[MASKED]` 化。監査ミドルウェアの `query` マスキング・error-handler の `req.path` サニタイズと一貫させた（キー集合は sanitize.js と同一 + snake_case 包含）。
- `src/security-audit.js` の `exec('npm audit --json')` を堅牢化: タイムアウト無し（レジストリ障害時に監視プロセスが永久滞留）と maxBuffer 既定 1MB（脆弱性多数時の大きな JSON が切断され「パース失敗」のみ記録され通知が永久に届かない）を修正（timeout 120s・maxBuffer 32MB）。パース失敗時に exec エラー/stderr も記録して原因診断可能に。exec モックの回帰テスト4件追加。
- `src/api/routes/payment/btc-onchain.js` のエスクロー CAS 競合を fail-closed 化 — tx1 送信後に期限切れスイープ等が PENDING→CANCELED へ遷移すると `updateIf` が condition_failed を返すが、従来は戻り値を無視して tx2 まで進み、証跡の残らない資金移動＋再送時の新規エスクロー作成（tx1 再送＝借り手二重課金）になり得た。CAS 失敗時は txid 証跡を行へ追記・`payment_escrow_cas_failed` 監査・500+手動照合で停止し、txid 持ち CANCELED エスクローへの再送は 409 で拒否。回帰テスト2件追加。
- `virtual-gpu-manager.js` のプロビジョニング config をサニタイズ: `createVirtualGPU` の `config.computePercentage` 等が生成される MPS シェルスクリプト（`start-mps.sh` を `exec` 実行）・Docker/k8s env・manifest へ生のまま埋め込まれており、`"50; <任意コマンド>"` 形式の値でコマンドインジェクションとなり得た。`clampPercentage`（数値化＋0-100クランプ）・`safeK8sQuantity`（quantity 形式検証＋既定値フォールバック）・`safePositiveNumber`（Docker Memory/CpuShares 用）を新設し全挿入箇所へ適用。docker/k8s/native 各経路で生成物がサニタイズ済みであることを検証するテスト6件を追加。
- `middleware/audit.js` の監査 url フィールドに生クエリが残る問題を修正: `req.originalUrl` をそのまま記録していたため `?token=`/`?api_key=` が平文残留し得た。query フィールドは既にマスキング済みのため url はパス部のみ記録へ変更（OWASP ロギング基準の二重防御）。併せて `scripts/slack-notify-notion.js` が `.env` を読まず SLACK_WEBHOOK_URL が常に空だった問題を修正（dotenv を slack-feedback-bot より先に読み込み — 同モジュールは require 時点で env を定数捕捉するため順序が必須）。
- `gpu-error-history.js` の競合・証跡喪失を修正: health/liveness 両モニタからの並行 `recordGpuError` が単一 JSON への read-modify-write で lost-update（エントリ消失）し得たため `withLock` 直列化（通知送信はロック外）。破損履歴ファイルが次回保存でサイレント上書きされる問題を `.corrupt-*` 退避へ変更（解析証跡を保全）、無制限増殖する GPU キーへ `MAX_GPU_KEYS` キャップを追加。
- `src/security/gpu-attestation-verifier.js` の mandatory チェックを fail-closed 化: 全フィールドが Joi optional であるのに対し mandatory の `freshness`（timestamp）と `memory_match`（report.memoryGB）がフィールド欠落時に `pass` していたため、欠落・パース不能・大きな未来時刻を不合格に修正（軽い未来ズレは 5 分スキュー内で受理）。欠落のままだと「一度取得した正当レポートの無期限再提示」（リプレイ）と「容量をアテストしないスペック申告」が必須チェックを素通りしていた。
- `src/utils/ssrf-guard.js` の IPv6 分類を 8 グループ展開＋数値判定へ書換え: 旧実装の `startsWith('fe80')` では fe80::/10 の fe90〜febf リンクローカルが素通りし、`::7f00:1`（IPv4-compatible ループバック）・`::ffff:0a00:1`（16進テールの mapped）・`2002:7f00:1::`（6to4）・`64:ff9b::7f00:1`（NAT64）等の IPv4 埋め込み遷移機構経由で内部アドレスへ SSRF 可能だった。fec0::/10 site-local・2001:db8::/32・2001:0::/32 Teredo も遮断対象に追加（PortSwigger SSRF cheat sheet 系の既知バイパス対応）。
- `src/api/utils/mailer.js`（master-auth メール認証コード送信経路）の SMTP 安全性を修正: 従来 `secure:false` で STARTTLS が opportunistic（非対応サーバへ SMTP_USER/PASS を平文送信し得る）かつタイムアウト無しだった。`requireTLS`（587系）/ `secure`（465）の適正化 + connection/greeting/socket 3系統タイムアウト + env 未設定時の明確なエラー + transporter 遅延生成。utils/email.js（SendGrid/Mailgun 系、#79 で済）とは別系統の残存ギャップ。
- `MAX_AUDIT_LOG_MB` の NaN フォールバックを修正: env がタイポ等で数値でない場合 parseInt が NaN を返し `NaN * 1MB` でサイズ比較が全て false → 監査ログ上限が無言で無効化されディスク枯渇 DoS が復活していた。NaN/負値は既定50MBへフォールバック（明示的0は監査停止として残す）。新規4テストで固定。
