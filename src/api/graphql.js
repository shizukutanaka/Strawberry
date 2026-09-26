// GraphQL APIエンドポイント自動生成（Express + @apollo/server v5）
// apollo-server-express v3 は upstream EOL で XS-Search CSRF（moderate、
// GHSA-9q82-xgwf-vj6h）に修正版がないため v5 へ移行。csrfPrevention で
// GET/単純 POST 経由の読み取り専用 CSRF を構造的に遮断する。
const { ApolloServer } = require('@apollo/server');
// v5 では express 統合が外部パッケージに分離（express4 用）
const { expressMiddleware } = require('@as-integrations/express4');
const { gql } = require('graphql-tag');
const { GraphQLError } = require('graphql');
const { getBTCtoJPYRate } = require('../utils/exchange-rate');
const OrderRepository = require('../db/json/OrderRepository');
const UserRepository = require('../db/json/UserRepository');
const GPURepository = require('../db/json/GpuRepository');
const jwt = require('jsonwebtoken');
const { resolveSecret } = require('./middleware/jwt-auth');
const { isRevoked } = require('./middleware/token-denylist');
const { sanitizeUser } = require('./utils/sanitize-user');
// 価格計算は REST と同一の共通ユーティリティを使う（整数 sats へ丸め・単位統一）。
const { computeOrderPricing } = require('../utils/order-pricing');

// v3 の AuthenticationError/ForbiddenError は v4 で廃止 — GraphQLError +
// extensions.code で等価なコードを返す（クライアント側の分岐互換）。
const unauthenticated = (msg = 'Authentication required') =>
  new GraphQLError(msg, { extensions: { code: 'UNAUTHENTICATED' } });
const forbidden = (msg = 'Access denied') =>
  new GraphQLError(msg, { extensions: { code: 'FORBIDDEN' } });

// GraphQLスキーマ定義（簡易例）
const typeDefs = gql`
  type Query {
    orders: [Order]
    order(id: ID!): Order
    users: [User]
    user(id: ID!): User
    gpus: [GPU]
    gpu(id: ID!): GPU
    btcToJpy: Float
    exchangeRate(fresh: Boolean): ExchangeRateInfo
  }
  type ExchangeRateInfo {
    rate: Float
    timestamp: Float
    isCache: Boolean
  }
  type Order {
    id: ID!
    userId: ID!
    gpuId: ID!
    pricePerHour: Float
    durationMinutes: Int
    pricePer5Min: Float
    totalPrice: Float
    totalPriceJPY: Float
    exchangeRateTimestamp: Float
    status: String
  }
  type User {
    id: ID!
    username: String
    email: String
  }
  type GPU {
    id: ID!
    name: String
    vendor: String
    memoryGB: Int
    pricePerHour: Float
  }
`;

const resolvers = {
  Query: {
    // 認証必須クエリ
    orders: (_, __, { user }) => {
      if (!user) throw unauthenticated();
      const all = OrderRepository.getAll();
      // admin は全件、一般ユーザーは自分の注文のみ
      return user.role === 'admin' ? all : all.filter(o => o.userId === user.id);
    },
    order: (_, { id }, { user }) => {
      if (!user) throw unauthenticated();
      const order = OrderRepository.getById(id);
      if (!order) return null;
      if (user.role !== 'admin' && order.userId !== user.id && order.providerId !== user.id) {
        throw forbidden();
      }
      return order;
    },
    users: (_, __, { user }) => {
      if (!user) throw unauthenticated();
      if (user.role !== 'admin') throw forbidden('Admin only');
      return UserRepository.getAll().map(sanitizeUser);
    },
    user: (_, { id }, { user }) => {
      if (!user) throw unauthenticated();
      if (user.role !== 'admin' && user.id !== id) throw forbidden();
      const found = UserRepository.getById(id);
      if (!found) return null;
      return sanitizeUser(found);
    },
    gpus: () => GPURepository.getAll().map(({ apiKey, ...g }) => g),
    gpu: (_, { id }) => {
      const g = GPURepository.getById(id);
      if (!g) return null;
      const { apiKey, ...safe } = g;
      return safe;
    },
    btcToJpy: async () => {
      const rate = await getBTCtoJPYRate();
      return typeof rate === 'number' ? rate : (rate && rate.rate) || 0;
    },
    exchangeRate: async (_, { fresh }, { user }) => {
      // fresh=true は外部 HTTPS を最大 4 本叩く。alias 増幅で上流レートを潰せるため
      // 管理者限定とし、それ以外はキャッシュ値を返す（誤入力でも DoS にしない）。
      const allowFresh = !!fresh && user && user.role === 'admin';
      const { rate, timestamp, isCache } = await getBTCtoJPYRate(allowFresh, true);
      return { rate, timestamp, isCache };
    },
  },
  Order: {
    pricePer5Min: (order) => computeOrderPricing(order).pricePer5Min,
    totalPrice: (order) => computeOrderPricing(order).totalPrice,
    totalPriceJPY: async (order) => {
      const rateInfo = await getBTCtoJPYRate(false, true);
      const { totalPriceJPY, exchangeRateTimestamp } = computeOrderPricing(order, rateInfo);
      // exchangeRateTimestampも返すため、resolverで値をorderに注入
      order._exchangeRateTimestamp = exchangeRateTimestamp;
      return totalPriceJPY;
    },
    exchangeRateTimestamp: (order) => {
      // totalPriceJPY解決時に注入されていればそれを返す
      if (order._exchangeRateTimestamp) return order._exchangeRateTimestamp;
      // そうでなければ最新取得
      return getBTCtoJPYRate(false, true).then(({ timestamp }) => timestamp);
    }
  }
};

// --- 多重・深いクエリ攻撃の遮断 ---
// 旧実装は深さ・別名上限なし。1 リクエストで `gpus` を 500 alias 並べて
// gpus.json を 500 回走査する CPU/IO DoS、および exchangeRate(fresh:true) を
// alias 連打して外部 HTTPS を増幅させる SSRF 増幅が可能だった。
const MAX_QUERY_DEPTH = 8;
const MAX_TOTAL_SELECTIONS = 200;
function depthAndSelectionLimitRule(context) {
  let totalSelections = 0;
  return {
    Field(node, _key, _parent, _path, ancestors) {
      totalSelections += 1;
      if (totalSelections > MAX_TOTAL_SELECTIONS) {
        context.reportError(new GraphQLError(
          `Query exceeds total selection limit (${MAX_TOTAL_SELECTIONS}); reduce aliases/fields and retry.`,
        ));
      }
      let depth = 0;
      for (const a of ancestors) {
        if (a && a.kind === 'Field') depth += 1;
      }
      if (depth > MAX_QUERY_DEPTH) {
        context.reportError(new GraphQLError(
          `Query depth ${depth} exceeds limit ${MAX_QUERY_DEPTH}.`,
        ));
      }
    },
  };
}

async function setupGraphQL(app) {
  // Apply rate limiting to the GraphQL endpoint.
  // The /graphql app is a separate Express sub-app mounted before the REST routes,
  // so the global apiLimiter in server.js does NOT cover it automatically.
  // Without this, unauthenticated callers can hammer alias-batched queries at full speed.
  const { apiLimiter } = require('./middleware/security');
  app.use(apiLimiter);

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    validationRules: [depthAndSelectionLimitRule],
    // 明示的なオプトインのみでイントロスペクションを有効化。
    // NODE_ENV !== 'production' という条件は NODE_ENV 未設定（undefined）の場合も
    // true となり、設定漏れの本番環境でスキーマが露出するリスクがあった。
    // GRAPHQL_INTROSPECTION=true を設定した環境のみで有効化することで
    // オプトアウト方式（デフォルト公開）をオプトイン方式（デフォルト非公開）に変更する。
    introspection: process.env.GRAPHQL_INTROSPECTION === 'true',
    // v4 組み込みの CSRF 防御: Content-Type が JSON でも multipart でもない
    // クエリ（＝ブラウザの通常フォーム/GET から送れるもの）を拒否し、
    // apollo-server-core v3 の XS-Search（読み取り専用 CSRF）を構造的に解消。
    csrfPrevention: true,
    // 本番では詳細なエラースタックを非表示。
    // v4 の formatError は (formattedError, originalError) を受け、
    // 返すべき整形済みエラーを返すシグネチャ。
    formatError: (formattedError) => {
      if (process.env.NODE_ENV === 'production' && formattedError.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        return { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
      }
      return formattedError;
    },
  });
  await server.start();
  // express.json() は親 app（server.js）で既に適用済み。サブアプリ側でも
  // Content-Type: application/json のボディを受け取れるよう念のため付ける
  // （expressMiddleware は JSON パース済みボディを要求する）。
  const express = require('express');
  app.use('/graphql', express.json(), expressMiddleware(server, {
    context: async ({ req }) => {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!token) return { user: null };
      try {
        const payload = jwt.verify(token, resolveSecret(), { algorithms: ['HS256'] });
        // REST(jwt-auth.js) と同一ポリシー: リフレッシュトークンをアクセスとして使わせない、
        // かつ logout で失効済み(jti)のトークンは拒否する。これを欠くと GraphQL 経由で
        // ログアウト済み/リフレッシュ用トークンが認証を通ってしまう。
        if (payload.type === 'refresh') return { user: null };
        if (payload.jti && isRevoked(payload.jti)) return { user: null };
        // passwordChangedAt check (same as REST middleware): reject tokens issued at or
        // before the password change so that GraphQL is covered by session invalidation.
        const tokenUser = UserRepository.getById(payload.id);
        if (!tokenUser || tokenUser.status === 'deactivated') return { user: null };
        const { isSessionInvalidated } = require('./utils/session-invalidation');
        if (isSessionInvalidated(tokenUser, payload.iat)) {
          return { user: null };
        }
        return { user: payload };
      } catch (_) {
        return { user: null };
      }
    },
  }));
}

module.exports = { setupGraphQL };
