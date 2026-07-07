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
