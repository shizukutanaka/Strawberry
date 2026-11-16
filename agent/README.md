# Strawberry 提供者エージェント

GPU 提供者のマシンで動かす小さなプログラムです。Strawberry サーバへ
外向きに WebSocket 接続を張り、借り手のリクエストを、あなたのマシン上の
GPU サービス（Ollama 等）へ中継します。これが無いと、あなたの GPU は
サーバと同じマシン内からしか使えません。

```
借り手 → Strawberry サーバ（セッションゲートウェイ）
       → このエージェント → あなたの GPU サービス
```

## 必要なもの

- Node.js 20 以上（追加のインストールは不要。依存は Node 標準のみ）
- Strawberry のアカウント（プロバイダとしてログインし、アクセストークンを取得）
- ローカルで動いている GPU サービス（例: Ollama `http://127.0.0.1:11434`）

## 起動

```sh
STRAWBERRY_SERVER_URL=https://your-strawberry-server.example.com \
STRAWBERRY_AGENT_TOKEN=<あなたのアクセストークン> \
STRAWBERRY_UPSTREAM_URL=http://127.0.0.1:11434 \
node agent/provider-agent.js
```

| 環境変数 | 必須 | 説明 |
|---|---|---|
| `STRAWBERRY_SERVER_URL` | ✓ | Strawberry サーバの URL |
| `STRAWBERRY_AGENT_TOKEN` | ✓ | あなた（提供者）のアクセストークン |
| `STRAWBERRY_UPSTREAM_URL` | ✓ | 中継先のローカル GPU サービス。これ以外の場所へは中継しません |
| `STRAWBERRY_AGENT_NAME` | | ログ・識別用の任意の名前 |

## 動作と安全性

- 接続は常にあなたのマシンから外向きです。ポート開放は不要です。
- 切断されたら自動で再接続します（指数バックオフ）。その間のリクエストは
  サーバ側で 502 になり、再接続後に同じセッションへ再び届きます。
- 中継先は `STRAWBERRY_UPSTREAM_URL` の origin のみに固定されています。
  借り手がパスを細工しても、他のホストへ中継されることはありません。
- 借り手のリクエストはサーバ側ゲートウェイでセッショントークンが
  検証されてから届きます。トークンの無いリクエストはここへ届きません。
- 応答はバッファリング方式です（上限 15MB）。ストリーミング応答も
  一括で返ります。

停止は Ctrl-C（SIGINT）または SIGTERM です。
