// tests/security/probe71-error-handler-info-disclosure.test.js
// Regression for an information-disclosure vulnerability in convertToAPIError().
//
// convertToAPIError() uses best-effort keyword matching on err.message to
// reclassify unknown Node.js errors from 500 to 4xx (404/401/403/409).
// The bug: toJSON(maskInternal) only masks when statusCode >= 500, so a
// reclassified 4xx error passed the raw internal message — including file
// paths, DB schema names, etc. — to clients in production.
//
// Example attack surface:
//   ENOENT: no such file or directory, open '/etc/strawberry/keys/master.pem'
//   → contains "does not exist" → reclassified to 404
//   → maskInternal && 404 >= 500  = false
//   → raw path leaked to client in production
//
// Fix: when keyword-reclassifying to 4xx, replace the raw err.message with a
// safe generic string. The original message is already logged by errorMiddleware
// before toJSON() is called, so nothing is lost for debugging.

const { convertToAPIError, APIError, ErrorTypes } = require('../../src/utils/error-handler');

// Simulate production: maskInternal=true
function toJSONProd(err) {
  return convertToAPIError(err).toJSON(true);
}

describe('convertToAPIError: keyword-reclassified 4xx must not expose raw internal messages', () => {
  it('"does not exist" in message → 404 with generic message, not the raw path', () => {
    // App-level error that contains a sensitive path and uses "does not exist"
    const err = new Error("Config file does not exist: '/etc/strawberry/keys/master.pem'");
    err.code = 'ENOENT';
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(404);
    expect(json.error.message).not.toMatch(/master\.pem/);
    expect(json.error.message).not.toMatch(/\/etc\//);
    expect(json.error.message).toBe('Resource not found');
  });

  it('"not found" in message → 404 with generic message', () => {
    const err = new Error('User not found in internal DB at row 42');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(404);
    expect(json.error.message).toBe('Resource not found');
    expect(json.error.message).not.toMatch(/row 42/);
  });

  it('"authentication" in message → 401 with generic message', () => {
    const err = new Error('JWT authentication failed for token: eyJhbGc...');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(401);
    expect(json.error.message).toBe('Authentication required');
    expect(json.error.message).not.toMatch(/eyJ/);
  });

  it('"unauthorized" in message → 401 with generic message', () => {
    const err = new Error('unauthorized: internal service account abc123 lacks permissions');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(401);
    expect(json.error.message).toBe('Authentication required');
    expect(json.error.message).not.toMatch(/abc123/);
  });

  it('"permission" in message → 403 with generic message', () => {
    const err = new Error('EACCES: permission denied, open \'/var/run/docker.sock\'');
    err.code = 'EACCES';
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(403);
    expect(json.error.message).toBe('Access denied');
    expect(json.error.message).not.toMatch(/docker\.sock/);
  });

  it('"forbidden" in message → 403 with generic message', () => {
    const err = new Error('forbidden: attempt to access restricted schema internal_audit');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(403);
    expect(json.error.message).toBe('Access denied');
    expect(json.error.message).not.toMatch(/internal_audit/);
  });

  it('"conflict" in message → 409 with generic message', () => {
    const err = new Error('conflict: unique constraint violation on table users column email_hash=abc');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(409);
    expect(json.error.message).toBe('Resource conflict');
    expect(json.error.message).not.toMatch(/email_hash/);
  });

  it('"duplicate" in message → 409 with generic message', () => {
    const err = new Error('duplicate key value violates unique constraint "users_pkey"');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(409);
    expect(json.error.message).toBe('Resource conflict');
    expect(json.error.message).not.toMatch(/users_pkey/);
  });

  it('unclassified error → 500, still masked by maskInternal in production', () => {
    const err = new Error('Something truly internal: db connection to 10.0.0.5 failed');
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(500);
    // 500 is masked by toJSON's existing maskInternal logic
    expect(json.error.message).toBe('Internal server error');
  });

  it('explicit APIError messages are NOT replaced (intentional user-safe message)', () => {
    const err = new APIError(ErrorTypes.NOT_FOUND, 'GPU not found', 404);
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(404);
    expect(json.error.message).toBe('GPU not found');
  });

  it('library error with explicit statusCode 404 passes message unchanged (http-errors contract)', () => {
    // http-errors / axios-style errors carry user-safe messages with their statusCode
    const err = new Error('Not Found');
    err.statusCode = 404;
    const json = toJSONProd(err);
    expect(json.error.statusCode).toBe(404);
    expect(json.error.message).toBe('Not Found');
  });
});

describe('convertToAPIError: type and statusCode still set correctly after fix', () => {
  it('"not found" in message → NOT_FOUND type', () => {
    const err = new Error("User not found in cache at key /internal/cache/user-42");
    const apiErr = convertToAPIError(err);
    expect(apiErr.type).toBe(ErrorTypes.NOT_FOUND);
    expect(apiErr.statusCode).toBe(404);
  });

  it('"permission denied" → FORBIDDEN type', () => {
    const err = new Error('permission denied for table sensitive_data');
    const apiErr = convertToAPIError(err);
    expect(apiErr.type).toBe(ErrorTypes.FORBIDDEN);
    expect(apiErr.statusCode).toBe(403);
  });

  it('originalError and code are preserved in details (for server-side logging)', () => {
    const err = new Error('ENOENT: no such file or directory');
    err.code = 'ENOENT';
    err.name = 'SystemError';
    const apiErr = convertToAPIError(err);
    expect(apiErr.details.code).toBe('ENOENT');
    expect(apiErr.details.originalError).toBe('SystemError');
  });
});
