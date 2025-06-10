# docs/ 運用・目次自動生成テンプレート

## 1. ドキュメント構成・見出し統一
- 各ドキュメント（.md）はH1, H2, H3見出しを統一
- 章立て・セクション分けを明確に

## 2. 目次（Table of Contents）自動生成
- 先頭に `<!-- toc -->` `<!-- tocstop -->` を記載
- `npx markdown-toc -i ファイル名.md` で目次自動挿入

## 3. 各種ドキュメントへのリンク整理
- README.mdからdocs/各ファイルへの相対リンクを明記
- 主要ドキュメント例:
  - [LIGHTNING_API_SETUP.md](./LIGHTNING_API_SETUP.md)
  - [SECURITY_AUDIT.md](./SECURITY_AUDIT.md)

## 4. 運用・更新手順
- ドキュメント追加・修正時は必ず目次を自動生成し、見出し・構成を統一
- 運用FAQや手順も随時追記

## 5. FAQ・ナレッジ共有
- よくある質問や運用ノウハウもdocs/faq.md等で共有

---

このテンプレートに沿ってdocs/配下のドキュメント品質・ナレッジ共有を継続的に向上させましょう。
