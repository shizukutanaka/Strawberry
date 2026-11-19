# Strawberry 自己ホストキット

Strawberry を**自分の環境で動かす**ための手順は、この文書に一本化しています。
入口は `docker/docker-compose.yml` の1つだけです。役割は3つあります。

```
借り手（ブラウザだけ）
  → Strawberry サーバ（運営者が自分の環境に立てる。このキットの本体）
      → 提供者エージェント（提供者の GPU マシンで動かす）
          → 提供者の GPU サービス（Ollama 等）
```

- **運営者**: サーバを立てる人。このキットの手順1を行います。
- **提供者**: GPU を貸す人。自分のマシンでエージェントを動かします（手順2）。
- **借り手**: GPU を借りる人。インストールは不要で、ブラウザだけです（手順3）。

Strawberry は GPU の貸し借り専用で、金銭のやり取り機能（支払い・精算など）は
存在しません。価格は GPU の掲載情報として表示されるだけです。

## 手順1: サーバを立てる（運営者）

必要なもの: Docker と Docker Compose（v2.24 以降）。

```sh
git clone https://github.com/shizukutanaka/Strawberry.git
cd Strawberry
```

`.env` を作成し、必須シークレットを3つ設定します。イメージ内は
`NODE_ENV=production` で動作し、シークレットが無いと起動時に理由を表示して
終了します（fail-fast。中途半端に起動したままにはなりません）。

```sh
cp .env.example .env
# .env を開き、少なくとも次の3つを推測不能な値に書き換える
#   JWT_SECRET      （32文字以上）
#   SESSION_SECRET  （16文字以上）
#   ENCRYPTION_KEY  （16文字以上）
# 生成例: openssl rand -hex 32
```

起動します（リポジトリルートから実行）。

```sh
docker compose -f docker/docker-compose.yml up --build -d
```

確認します。

```sh
curl http://localhost:3000/health
```

応答が返れば起動しています。ブラウザで `http://localhost:3000` を開き、
アカウントを作成してください。状態はホスト側の `data/`（JSON データ）と
`logs/` に残るため、コンテナを作り直しても消えません。

### Docker を使わない場合

Node.js 20 以上があれば、同じ `.env` を置いて直接起動できます。

```sh
npm ci
NODE_ENV=production npm start
```

`NODE_ENV=production` を付けない開発モードでも起動しますが、シークレットは
起動ごとに変わる一時的なものになり、再起動で全トークンが失効します。
安定運用には上記の本番モードを使ってください。

## 手順2: GPU を提供する（提供者）

提供者のマシンには Docker は不要です。必要なものは Node.js 20 以上と、
ローカルで動いている GPU サービス（例: Ollama）だけです。

1. 運営者のサーバの画面でアカウントを作成し、「GPU登録」から自分の GPU を掲載する
2. 「マイGPU」の「エージェント起動コマンドを発行」を押す（サーバ URL と
   エージェントトークンを埋めたコマンドが表示されます）
3. 自分のマシンで GPU サービスを起動する（例: Ollama `http://127.0.0.1:11434`）
4. 表示されたコマンドを Strawberry のフォルダで実行し、エージェントを起動する

```sh
STRAWBERRY_SERVER_URL=https://your-strawberry-server.example.com \
STRAWBERRY_AGENT_TOKEN=<発行したエージェントトークン> \
STRAWBERRY_UPSTREAM_URL=http://127.0.0.1:11434 \
node agent/provider-agent.js
```

接続は提供者のマシンから外向きに張るため、ポート開放は不要です。
エージェントの詳細（環境変数・安全性・再接続の挙動）は
[`agent/README.md`](../agent/README.md) を参照してください。

## 手順3: GPU を借りる（借り手）

ブラウザで運営者のサーバを開き、ログインして GPU を注文するだけです。
割り当てが始まると、接続先（endpoint）とセッショントークンが発行され、
注文詳細画面にも表示されます。その endpoint へトークン付きでリクエストを
送ると、提供者の GPU サービスへ中継されます。割り当てを解放すると
接続は閉じられます。

## 任意: 仮想GPU（テナント隔離コンテナ）を使う運営者向け

サーバと同じホスト上の GPU をテナント隔離コンテナで貸す場合は、
ワーカーイメージをビルドしておきます。これは compose のサービスではなく、
サーバ内部の仮想GPUマネージャが必要時に起動するコンテナのイメージです。
サーバホストに NVIDIA GPU と NVIDIA コンテナランタイムが必要です。

```sh
docker build -f docker/Dockerfile.gpu-worker -t strawberry/gpu-worker:latest .
```

Kubernetes で配置したい運営者向けには `kubernetes/` に同じ API イメージの
マニフェストがありますが、キットの標準の入口は上記の compose です。

## 運用

```sh
# 停止
docker compose -f docker/docker-compose.yml down

# 更新（データは data/ に残ります）
git pull
docker compose -f docker/docker-compose.yml up --build -d
```

- バックアップ対象は `data/` 一式です。
- `JWT_SECRET` 等のシークレットを変更すると、既存のトークンは全て失効します
  （利用者は再ログインが必要になります）。
- 設定値の完全な一覧は `.env.example`、運用リファレンスは
  [`docs/operations.md`](./operations.md) を参照してください。

## 制約（正直な限界）

- 提供者経由の中継はバッファリング方式で、ストリーミング応答は一括で
  返ります（トークンの逐次表示はできません）。上限は 15MB です。
- 実 GPU・実 Ollama での検証は未実施です（スタブ上流での一往復は
  `node scripts/smoke-provider-agent.js` で確認できます）。
- 実態と既知の制約の一次情報は [`ARCHITECTURE.md`](../ARCHITECTURE.md) です。
