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
