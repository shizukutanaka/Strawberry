// OpenAPI spec が実ルートから生成されることの検証。
// 旧実装は Joi スキーマ名からパスを推測し、存在しないエンドポイントや
// 公開 GET への誤った BearerAuth 要件を /openapi.json で公開していた。
const express = require('express');

const { listExpressRoutes, generateOpenAPISpec } = require('../../src/api/openapi-generator');

describe('openapi real-route generation', () => {
  function buildApp() {
    const app = express();
    const sub = express.Router();
    const authenticateJWT = (req, res, next) => next();
    const checkRole = () => (req, res, next) => next();
    sub.get('/:id/status', authenticateJWT, (req, res) => res.end());
    sub.post('/open', (req, res) => res.end());
    sub.delete('/:id', authenticateJWT, checkRole(['admin']), (req, res) => res.end());
    const inner = express.Router();
    inner.post('/deep', authenticateJWT, (req, res) => res.end());
    sub.use('/nested', inner);
    app.use('/api/v1/things', sub);
    app.get('/health', (req, res) => res.end());
    return app;
  }

  it('実在するルートのみが paths に現れる（幻影パスなし）', () => {
    const spec = generateOpenAPISpec({ app: buildApp() });
    const paths = Object.keys(spec.paths);
    expect(paths).toContain('/api/v1/things/{id}/status');
    expect(paths).toContain('/api/v1/things/open');
    expect(paths).toContain('/api/v1/things/{id}');
    expect(paths).toContain('/api/v1/things/nested/deep');
    expect(paths).toContain('/health');
    // スキーマ駆動の幻影パス（/gpu/register 等）は含まれない
    expect(paths.some(p => /^\/gpu/.test(p))).toBe(false);
  });

  it('認証ミドルウェアの有無が security に反映される', () => {
    const spec = generateOpenAPISpec({ app: buildApp() });
    expect(spec.paths['/api/v1/things/{id}/status'].get.security).toEqual([{ BearerAuth: [] }]);
    expect(spec.paths['/api/v1/things/open'].post.security).toEqual([]);
    expect(spec.paths['/health'].get.security).toEqual([]);
  });

  it('app 未指定の従来モード（CLI）も引き続き動作する', () => {
    const spec = generateOpenAPISpec();
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });
});
