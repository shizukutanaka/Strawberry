// public/js/docs.js — same-origin OpenAPI viewer.
// Strict CSP (script-src 'self', no CDN) blocked the previous swagger-ui-dist
// CDN + inline-script based /swagger.html entirely (silent failure — a blank
// page with CSP violations in the console, easy to miss). This is a small,
// self-contained, no-dependency replacement that fetches the same
// /openapi.json this server already generates and renders it plainly.
// Standalone page (not part of the SPA's hash router / auth state) — kept
// deliberately simple; the spec itself is a generic sample of Joi schemas
// rather than the full live REST surface, a pre-existing generator
// limitation out of scope for this page.

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function resolveSchema(schema, components) {
  if (!schema) return null;
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    return components.schemas ? components.schemas[name] : null;
  }
  return schema;
}

function methodBadge(method) {
  return el('span', { class: `docs-method docs-method-${method}` }, method.toUpperCase());
}

function renderEndpoint(path, method, op, components) {
  const body = [];

  if (Array.isArray(op.parameters) && op.parameters.length) {
    body.push(el('h4', {}, 'パラメータ'));
    body.push(el('div', { class: 'docs-schema' }, JSON.stringify(op.parameters, null, 2)));
  }
  if (op.requestBody) {
    const content = op.requestBody.content && op.requestBody.content['application/json'];
    const schema = content ? resolveSchema(content.schema, components) : null;
    body.push(el('h4', {}, 'リクエストボディ' + (op.requestBody.required ? '（必須）' : '')));
    body.push(el('div', { class: 'docs-schema' }, JSON.stringify(schema || content?.schema || {}, null, 2)));
  }
  if (op.responses) {
    body.push(el('h4', {}, 'レスポンス'));
    body.push(el('div', { class: 'docs-schema' },
      Object.entries(op.responses).map(([code, r]) => `${code}: ${r.description || ''}`).join('\n')));
  }
  if (op.security) {
    body.push(el('h4', {}, '認証'));
    body.push(el('div', { class: 'docs-schema' }, '認証トークン（Bearer JWT）が必要です'));
  }

  return el('details', { class: 'docs-endpoint' },
    el('summary', {}, methodBadge(method), el('span', {}, path), el('span', { class: 'docs-summary-text' }, op.summary || '')),
    el('div', { class: 'docs-body' }, ...body),
  );
}

async function main() {
  const app = document.getElementById('docs-app');
  try {
    const res = await fetch('/openapi.json');
    if (!res.ok) throw new Error(`/openapi.json returned ${res.status}`);
    const spec = await res.json();
    app.replaceChildren();

    app.appendChild(el('h1', {}, spec.info?.title || 'API仕様書'));
    if (spec.info?.description) app.appendChild(el('p', { class: 'muted' }, spec.info.description));
    app.appendChild(el('p', { class: 'muted' }, `OpenAPI ${spec.openapi || ''} / version ${spec.info?.version || ''}`));

    const paths = Object.keys(spec.paths || {}).sort();
    if (!paths.length) {
      app.appendChild(el('p', { class: 'muted' }, 'エンドポイントが見つかりませんでした。'));
      return;
    }
    for (const path of paths) {
      const methods = Object.keys(spec.paths[path]);
      for (const method of methods) {
        app.appendChild(renderEndpoint(path, method, spec.paths[path][method], spec.components || {}));
      }
    }
  } catch (err) {
    app.replaceChildren(el('div', { class: 'banner banner-warning' }, `API仕様書の取得に失敗しました: ${err.message}`));
  }
}

main();
