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

## 2. ノード登録API例

### `/api/owner/register`（POST）
```json
{
  "owner_id": "user123",
  "gpu_vendor": "AMD",
  "gpu_model": "Radeon RX 6800",
  "driver_version": "23.5.2",
  "api_type": "ROCm",
  "wallet_address": "bc1q...",
  "os": "Windows 11"
}
```

### `/api/owner/gpu_status`（GET）
- ベンダー・モデル・API種別ごとに貸出状況・稼働状況・エラーを返す

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
