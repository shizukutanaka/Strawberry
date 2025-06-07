// GraphQL APIエンドポイント自動生成（Express+apollo-server-express）
const express = require('express');
const { ApolloServer, gql } = require('apollo-server-express');
const { schemas } = require('../utils/validator');
const { getBTCtoJPYRate } = require('../utils/exchange-rate');
const OrderRepository = require('../db/json/OrderRepository');
const UserRepository = require('../db/json/UserRepository');
const GPURepository = require('../db/json/GpuRepository');

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
  }
  type Order {
    id: ID!
    userId: ID!
    gpuId: ID!
    pricePerHour: Float
    durationMinutes: Int
    totalPrice: Float
    totalPriceJPY: Float
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
    orders: () => OrderRepository.getAll(),
    order: (_, { id }) => OrderRepository.getById(id),
    users: () => UserRepository.getAll(),
    user: (_, { id }) => UserRepository.getById(id),
    gpus: () => GPURepository.getAll(),
    gpu: (_, { id }) => GPURepository.getById(id),
    btcToJpy: async () => await getBTCtoJPYRate(),
  },
  Order: {
    totalPrice: (order) => {
      const pricePerHour = order.pricePerHour || 0;
      const pricePer5Min = pricePerHour / 12;
      const totalPrice = pricePer5Min * ((order.durationMinutes || 0) / 5);
      return totalPrice;
    },
    totalPriceJPY: async (order) => {
      const pricePerHour = order.pricePerHour || 0;
      const pricePer5Min = pricePerHour / 12;
      const totalPrice = pricePer5Min * ((order.durationMinutes || 0) / 5);
      const rate = await getBTCtoJPYRate();
      return Math.round(totalPrice * rate);
    }
  }
};

async function setupGraphQL(app) {
  const server = new ApolloServer({ typeDefs, resolvers });
  await server.start();
  server.applyMiddleware({ app, path: '/graphql' });
}

module.exports = { setupGraphQL };
