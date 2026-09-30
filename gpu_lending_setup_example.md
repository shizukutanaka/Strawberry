# Strawberry GPU貸出セットアップ例（クロスベンダー対応）

このドキュメントは、NVIDIA/AMD/IntelいずれのGPUでも個人が簡単に貸出ノードを構築できるセットアップ例・スクリプト・API仕様をまとめたものです。

---

## 1. セットアップ自動化スクリプト例

### Windows PowerShell（GPUベンダー自動判別＆セットアップ）
```powershell
# GPUベンダー自動判別
$gpuInfo = Get-WmiObject win32_VideoController | Select-Object Name
if ($gpuInfo.Name -match "NVIDIA") {
    Write-Host "NVIDIA GPU検出: CUDA/NVIDIAドライバセットアップ開始"
    # NVIDIA用セットアップ処理（nvidia-docker等）
} elseif ($gpuInfo.Name -match "AMD" -or $gpuInfo.Name -match "Radeon") {
    Write-Host "AMD GPU検出: ROCmセットアップ開始"
    # AMD用セットアップ処理（ROCm等）
} elseif ($gpuInfo.Name -match "Intel") {
    Write-Host "Intel GPU検出: oneAPIセットアップ開始"
    # Intel用セットアップ処理（oneAPI等）
} else {
    Write-Host "未対応GPUです"
}
```

### Linux Bash（lspciによる自動判別）
```bash
if lspci | grep -i nvidia; then
  echo "NVIDIA GPU検出: CUDA/NVIDIAドライバセットアップ開始"
  # NVIDIA用セットアップ処理
elif lspci | grep -i amd; then
  echo "AMD GPU検出: ROCmセットアップ開始"
  # AMD用セットアップ処理
elif lspci | grep -i intel; then
  echo "Intel GPU検出: oneAPIセットアップ開始"
  # Intel用セットアップ処理
else
  echo "未対応GPU"
fi
```

---

## 2. ノード登録API例（実装済みエンドポイント）

実際の API は `/api/v1` プレフィックス配下です。登録は JWT 認証 + `provider`/`admin` ロールが必要です。

### `POST /api/v1/gpus`（GPU 登録）

```json
{
  "name": "My RX 6800",
  "vendor": "AMD",
  "model": "Radeon RX 6800",
  "apiType": "ROCm",
  "driverVersion": "23.5.2",
  "os": "Windows 11",
  "arch": "x86_64",
  "memoryGB": 16,
  "clockMHz": 2100,
  "powerWatt": 250,
  "pricePerHour": 0.35
}
```

必須フィールド: `vendor`(NVIDIA/AMD/Intel)・`model`・`apiType`(CUDA/ROCm/oneAPI/OpenCL)・`driverVersion`・`os`・`arch`・`memoryGB`・`clockMHz`・`powerWatt`・`pricePerHour`。任意: `availability`・`features`・`capabilities`・`location`・`minRenterRating` 等（詳細は `src/utils/validator.js` の `schemas.gpu.register`）。

### `GET /api/v1/gpus`（一覧・検索）
`?vendor=NVIDIA&apiType=CUDA&minMemoryGB=8&maxPrice=0.5&country=JP&search=rtx` でフィルタ・検索可能（`features={"cudaSupport":true}` の JSON 指定も可）。

### `GET /api/v1/gpus/my`（自分の貸出GPU一覧・要 JWT）
プロバイダ自身の登録 GPU と稼働状況を返します。

### その他の実装済み API
- `PUT /api/v1/gpus/:id` — 登録内容の更新（オーナー/admin）
- `DELETE /api/v1/gpus/:id` — 登録削除（オーナー/admin）
- `POST /api/v1/gpus/bulk` — 複数台一括登録
- `POST /api/v1/gpus/:id/clone` — 既存登録の複製
- `GET /api/v1/gpus/:id/market-rate` — 同一モデル内の価格分布
- `GET /api/v1/gpus/:id/history` — 利用履歴（要 JWT）
- `POST /api/v1/gpus/:id/block` / `DELETE /api/v1/gpus/:id/block/:blockId` — メンテナンス枠（手動ブロック）管理

---

## 3. Web/CLI UI設計ポイント
- 「GPU貸出」ボタンで自動セットアップ案内
- 「NVIDIA/AMD/Intelすべて対応」明記
- セットアップ時に自動でベンダー・API判別
- 貸出状況・収益はダッシュボードで可視化

---

## 4. FAQ抜粋
- Q: どのGPUでも貸し出せますか？
  - A: NVIDIA/AMD/Intelの主要GPUに対応。セットアップスクリプトが自動判別します。
- Q: ドライバやAPIが未導入の場合は？
  - A: セットアップ時に自動でインストール案内・補助を行います。

---

## 5. 改善チェックリストへの追加例

- [ ] カテゴリ: GPUリソース管理・UX
- [ ] 改善案タイトル: クロスベンダーGPU自動貸出セットアップ&サポート
- [ ] 詳細説明: Web/CLI/セットアップスクリプトでNVIDIA/AMD/IntelのGPUを自動判別し、各社API・ドライバに応じた貸出・監視・収益管理を自動化。サポート状況をUI/CLIで明示し、FAQやサポートも強化。
- [ ] 優先度: 高
