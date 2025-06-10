// OpenAPI仕様自動生成スクリプト（Joiスキーマ→OpenAPI）
const fs = require('fs');
const path = require('path');
const j2s = require('joi-to-swagger');
const { schemas } = require('../utils/validator');

const OPENAPI_PATH = path.join(__dirname, '../../openapi.json');

function generateOpenAPISpec() {
  // 基本情報
  const openapi = {
    openapi: '3.0.3',
    info: {
      title: 'Strawberry P2P GPU Marketplace API',
      version: '1.0.0',
      description: '自動生成API仕様書（Joiスキーマから）',
    },
    servers: [
      { url: 'http://localhost:3000/api/v1', description: 'Local Dev' }
    ],
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT Bearer 認証'
        }
      }
    },
  };

  // schemas構造に応じてOpenAPI componentsを自動生成
  for (const [group, groupSchemas] of Object.entries(schemas)) {
    for (const [name, joiSchema] of Object.entries(groupSchemas)) {
      const { swagger } = j2s(joiSchema);
      openapi.components.schemas[`${group}_${name}`] = swagger;
    }
  }

  // schemas構造から主要pathsを自動生成（CRUD, 検索, 認証, 支払い等）
  for (const [group, groupSchemas] of Object.entries(schemas)) {
    for (const [name, joiSchema] of Object.entries(groupSchemas)) {
      let path = `/` + group + (name !== 'register' && name !== 'create' && name !== 'search' ? `/${name}` : '');
      let method = 'post';
      let summary = `${group} ${name}`;
      if (name === 'get' || name === 'detail') {
        method = 'get';
        summary = `${group}詳細取得`;
      } else if (name === 'update') {
        method = 'put';
        summary = `${group}更新`;
      } else if (name === 'delete') {
        method = 'delete';
        summary = `${group}削除`;
      } else if (name === 'search' || name === 'list') {
        method = 'get';
        summary = `${group}検索/一覧`;
      } else if (name === 'register' || name === 'create') {
        method = 'post';
        summary = `${group}登録/作成`;
      }
      // pathsに追加
      if (!openapi.paths[path]) openapi.paths[path] = {};
      // RBAC要件例: /system/infoはadminのみ
      let xRequiredRole = undefined;
      if (path === '/system/info') xRequiredRole = 'admin';
      openapi.paths[path][method] = {
        summary,
        security: [{ BearerAuth: [] }],
        ...(xRequiredRole ? { 'x-required-role': xRequiredRole } : {}),
        requestBody: ['get','delete'].includes(method) ? undefined : {
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${group}_${name}` } } },
          required: true
        },
        responses: { 200: { description: 'OK' } }
      };


    }
  }

  fs.writeFileSync(OPENAPI_PATH, JSON.stringify(openapi, null, 2));
  console.log('OpenAPI仕様書を自動生成しました:', OPENAPI_PATH);
}

if (require.main === module) {
  generateOpenAPISpec();
}

module.exports = { generateOpenAPISpec };
