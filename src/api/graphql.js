// GraphQL APIエンドポイント自動生成（Express+apollo-server-express）
const { ApolloServer, gql, AuthenticationError, ForbiddenError } = require('apollo-server-express');
const { getBTCtoJPYRate } = require('../utils/exchange-rate');
const OrderRepository = require('../db/json/OrderRepository');
const UserRepository = require('../db/json/UserRepository');
const GPURepository = require('../db/json/GpuRepository');
const jwt = require('jsonwebtoken');
const { resolveSecret } = require('./middleware/jwt-auth');
const { isRevoked } = require('./middleware/token-denylist');
// 価格計算は REST と同一の共通ユーティリティを使う（整数 sats へ丸め・単位統一）。
const { computeOrderPricing } = require('../utils/order-pricing');

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
      if (!user) throw new AuthenticationError('Authentication required');
      const all = OrderRepository.getAll();
      // admin は全件、一般ユーザーは自分の注文のみ
      return user.role === 'admin' ? all : all.filter(o => o.userId === user.id);
    },
    order: (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Authentication required');
      const order = OrderRepository.getById(id);
      if (!order) return null;
      if (user.role !== 'admin' && order.userId !== user.id && order.providerId !== user.id) {
        throw new ForbiddenError('Access denied');
      }
      return order;
    },
    users: (_, __, { user }) => {
      if (!user) throw new AuthenticationError('Authentication required');
      if (user.role !== 'admin') throw new ForbiddenError('Admin only');
      return UserRepository.getAll().map(({ password, apiKey, ...u }) => u);
    },
    user: (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Authentication required');
      if (user.role !== 'admin' && user.id !== id) throw new ForbiddenError('Access denied');
      const found = UserRepository.getById(id);
      if (!found) return null;
      const { password, apiKey, ...safe } = found;
      return safe;
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
    exchangeRate: async (_, { fresh }) => {
      const { rate, timestamp, isCache } = await getBTCtoJPYRate(!!fresh, true);
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

async function setupGraphQL(app) {
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    // Disable introspection in production to avoid leaking the full API schema
    // to unauthenticated callers (attackers, crawlers).
    introspection: process.env.NODE_ENV !== 'production',
    context: ({ req }) => {
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
        if (tokenUser.passwordChangedAt &&
            payload.iat <= Math.floor(Date.parse(tokenUser.passwordChangedAt) / 1000)) {
          return { user: null };
        }
        return { user: payload };
      } catch (_) {
        return { user: null };
      }
    },
    // 本番では詳細なエラースタックを非表示
    formatError: (err) => {
      if (process.env.NODE_ENV === 'production' && err.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        return { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
      }
      return err;
    }
  });
  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });
}

module.exports = { setupGraphQL };
