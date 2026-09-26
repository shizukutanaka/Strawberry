// OpenAPI仕様自動生成スクリプト（Joiスキーマ→OpenAPI）
const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../db/json/atomicWrite');
const j2s = require('joi-to-swagger');
const Joi = require('joi');
const { schemas } = require('../utils/validator');

// schemas のトップレベル要素は2形態ある:
//  (A) グループ ＝ { name: JoiSchema, ... }（例: gpu, order, user）
//  (B) 単体スキーマ ＝ それ自体が Joi スキーマ（例: lightningNode, lightningChannel）
// 旧ジェネレータは (B) を (A) として走査し、Joi 内部プロパティを j2s に渡してクラッシュしていた。
// 各グループを正規化し、{ name -> JoiSchema } の形に揃える（非 Joi はスキップ）。
function normalizeGroup(group, value) {
  if (value && Joi.isSchema(value)) {
    return { [group]: value }; // (B) 単体スキーマは自身を代表名とする
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [name, s] of Object.entries(value)) {
      if (s && Joi.isSchema(s)) out[name] = s; // (A) Joi スキーマのみ採用
    }
    return out;
  }
  return {};
}

const OPENAPI_PATH = path.join(__dirname, '../../openapi.json');

// persist=true は CLI（require.main === module の起動）でのみ true にする。
// 旧実装はサーバープロセスから呼ばれても atomicWriteJSON で disk へ書き込んでおり、
// 未認証 /openapi.json リクエストの cold cache でディスク IO が発生していた。
// Express 4 のルータスタックを走査し、実在する (method, path, auth) を列挙する。
// 旧実装は Joi スキーマ名からパスを推測しており、存在しない幻影パスや
// 公開 GET に誤って BearerAuth を要求する spec を /openapi.json で公開していた。
function _mountPrefix(layer) {
  const src = layer.regexp && layer.regexp.source;
  if (!src) return '';
  // Express 4 のマウント正規表現: '^\\/api\\/v1\\/?(?=\\/|$)' → '/api/v1'
  const m = src.match(/^\^((?:\\\/|[^\\?(])+)/);
  if (!m) return '';
  const cleaned = m[1].replace(/\\(.)/g, '$1');
  return cleaned === '/' ? '' : cleaned;
}

// Express の ':param' を OpenAPI の '{param}' に変換
function _toOpenAPIPath(p) {
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function _joinPaths(prefix, p) {
  const joined = (prefix + p).replace(/\/{2,}/g, '/');
  return joined === '' ? '/' : joined;
}

// ルートハンドラ列から認証・ロール要件を推定（関数名ベースのベストエフォート）
function _routeGuards(routeLayers) {
  let requiresAuth = false;
  let requiredRole = null;
  for (const l of routeLayers) {
    const name = (l && l.name) || '';
    if (/^(authenticateJWT|jwtAuth|adminOnly|checkRole|optionalAuth)$/.test(name)) requiresAuth = true;
    if (name === 'adminOnly') requiredRole = 'admin';
    if (name === 'checkRole') {
      requiresAuth = true;
      const match = String(l.handle).match(/checkRole\(\s*\[?\s*'([a-zA-Z]+)'/);
      if (match) requiredRole = match[1];
    }
  }
  return { requiresAuth, requiredRole };
}

function _walkLayers(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const { requiresAuth, requiredRole } = _routeGuards(layer.route.stack || []);
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const rp of paths) {
        for (const method of Object.keys(layer.route.methods || {})) {
          if (method === '_all' || method === 'head') continue;
          out.push({
            method,
            path: _toOpenAPIPath(_joinPaths(prefix, String(rp))),
            requiresAuth,
            requiredRole,
          });
        }
      }
    } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
      _walkLayers(layer.handle.stack, _joinPaths(prefix, _mountPrefix(layer)), out);
    }
    // 'bound dispatch' 等のミドルウェアレイヤはルートではないのでスキップ
  }
}

function listExpressRoutes(app) {
  const out = [];
  const router = app && (app._router || app.router);
  if (!router || !Array.isArray(router.stack)) return out;
  _walkLayers(router.stack, '', out);
  // openapi.json 自身や静的アセット用ミドルウェアは route を持たず除外済み
  return out;
}

function generateOpenAPISpec({ persist = false, app = null } = {}) {
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
  for (const [group, groupValue] of Object.entries(schemas)) {
    for (const [name, joiSchema] of Object.entries(normalizeGroup(group, groupValue))) {
      const { swagger } = j2s(joiSchema);
      openapi.components.schemas[`${group}_${name}`] = swagger;
    }
  }

  // schemas構造から主要pathsを自動生成（CRUD, 検索, 認証, 支払い等）
  // app が渡された場合は実ルート走査による正確な paths に置き換えるため、
  // このスキーマ駆動の推測生成は app 未指定（CLI 等）のフォールバックとしてのみ走る。
  if (!app) {
  for (const [group, groupValue] of Object.entries(schemas)) {
    for (const [name, joiSchema] of Object.entries(normalizeGroup(group, groupValue))) {
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

  // 管理系エンドポイントを明示的に追記（スキーマ駆動では生成されない実在の admin ルート）。
  // 実装は routes/index.js の `/system/info`（jwtAuth + rbac('admin')）に対応。
  openapi.paths['/system/info'] = {
    get: {
      summary: 'システム情報取得（管理者のみ）',
      security: [{ BearerAuth: [] }],
      'x-required-role': 'admin',
      responses: { 200: { description: 'OK' }, 403: { description: 'Forbidden' } },
    },
  };
  } else {
    // 実ルートから paths を生成（実装と spec のドリフト防止）
    for (const r of listExpressRoutes(app)) {
      const p = r.path;
      if (!openapi.paths[p]) openapi.paths[p] = {};
      openapi.paths[p][r.method] = {
        summary: `${r.method.toUpperCase()} ${p}`,
        security: r.requiresAuth ? [{ BearerAuth: [] }] : [],
        ...(r.requiredRole ? { 'x-required-role': r.requiredRole } : {}),
        responses: { 200: { description: 'OK' } },
      };
    }
  }

  if (persist) {
    atomicWriteJSON(OPENAPI_PATH, openapi);
    console.log('OpenAPI仕様書を自動生成しました:', OPENAPI_PATH);
  }
  return openapi;
}

if (require.main === module) {
  generateOpenAPISpec({ persist: true });
}

module.exports = { generateOpenAPISpec, listExpressRoutes };
