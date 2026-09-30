# Strawberry GPU貸出 CLI自動化ガイド（クロスベンダー対応）

このガイドは、誰でも簡単にNVIDIA/AMD/Intel GPUを貸し出せるようにするためのCLI導線・運用手順をまとめたものです。

---

## 1. セットアップ手順（例: Windows/Linux/Mac）

### 1. Node.jsと依存パッケージのインストール
- Node.js公式サイトからインストール
- リポジトリルートで `npm install`（axios は dependencies に含まれます）

### 2. 自動登録スクリプトの実行
```sh
node gpu_lending_setup_auto_register.js
```

- 実行するとGPUベンダー・モデル・API種別を自動検出し、Strawberryサーバへ登録
- **実行前にスクリプト内の2箇所を編集してください:**
  - `API_URL` → `http://<サーバ>:3000/api/v1/gpus`（実 API は `/api/v1` プレフィックス配下）
  - `TOKEN` → `POST /api/v1/users/login` で取得した JWT（`provider` または `admin` ロール必須）
- 登録には必須フィールドがあります: `vendor`(NVIDIA/AMD/Intel)・`model`・`apiType`(CUDA/ROCm/oneAPI/OpenCL)・`driverVersion`・`os`・`arch`(x86_64/arm64/aarch64/x86/arm)・`memoryGB`・`clockMHz`・`powerWatt`・`pricePerHour`
  - 注意: `os.arch()` の返り値（`x64` など）は API が受理する `arch` 値と異なるため、x86_64 等へマッピングが必要です
  - `memoryGB`/`clockMHz`/`powerWatt`/`pricePerHour` はスクリプト内の仮値を実機値へ修正してください

---

## 2. CLI貸出ワークフロー例

1. `node gpu_lending_setup_auto_register.js` を実行
2. 成功メッセージ `[SUCCESS] GPU登録:` が出れば貸出登録完了
3. StrawberryダッシュボードやAPIで貸出状況・収益を確認

---

## 3. よくある質問（FAQ）

**Q. どのGPUでも貸し出せますか？**  
A. NVIDIA/AMD/Intelの主要GPUに対応。自動検出・登録されます。

**Q. ドライバやAPIが未導入の場合は？**  
A. セットアップ時に自動で検出・案内。必要に応じてインストールガイドを表示。

**Q. 貸出状況や収益はどこで見られますか？**  
A. Webダッシュボードまたは `GET /api/v1/gpus`（一覧）で確認できます。

---

## 4. 応用・拡張例
- スクリプトをバッチ/シェル化して自動起動
- Web UIやインストーラと連携してノーコード化
- Slack/LINE通知連携や多言語化も可能

---

## 5. 注意事項
- 本番運用時はAPIトークン・エンドポイントの管理に注意
- 詳細なスペックや稼働状況はダッシュボードで必ず確認

---

これで個人でもCLI一発でクロスベンダーGPU貸出が可能です。
運用自動化やUI連携もご希望があればご相談ください。
