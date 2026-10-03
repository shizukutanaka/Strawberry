// src/api/utils/tokens.js — access/refresh の2トークン構成と claim 契約を固定するテスト。
// type 厳密区別・jti 埋め込み・refresh の ati 連携・TTL の env 優先解決は
// セッション失効・クロスタイプ置換防止の前提となる不変条件。
const jwt = require('jsonwebtoken');
const { signAccessToken, signRefreshToken, accessTTL, refreshTTL } = require('../../src/api/utils/tokens');

const USER = { id: 'u-1', role: 'user' };
const SAVED = {};

const ENV_KEYS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN'];
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv(k);
  process.env.JWT_SECRET = 'test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
});
afterEach(() => {
  for (const k of ENV_KEYS) restoreEnv(k);
});
function savedEnv(k) { SAVED[k] = process.env[k]; }
function restoreEnv(k) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }

describe('signAccessToken', () => {
  it('embeds id/role/type:"access"/jti claims', () => {
    const payload = jwt.decode(signAccessToken(USER));
    expect(payload.id).toBe('u-1');
    expect(payload.role).toBe('user');
    expect(payload.type).toBe('access');
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honors a caller-supplied jti', () => {
    const payload = jwt.decode(signAccessToken(USER, 'jti-custom'));
    expect(payload.jti).toBe('jti-custom');
  });

  it('is verifiable with the access secret, not the refresh secret', () => {
    const token = signAccessToken(USER);
    expect(() => jwt.verify(token, 'test-access-secret')).not.toThrow();
    expect(() => jwt.verify(token, 'test-refresh-secret')).toThrow();
  });
});

describe('signRefreshToken', () => {
  it('embeds type:"refresh" and a jti distinct from access', () => {
    const payload = jwt.decode(signRefreshToken(USER));
    expect(payload.type).toBe('refresh');
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('embeds ati only when supplied (paired access-token revocation)', () => {
    expect(jwt.decode(signRefreshToken(USER, 'ati-1')).ati).toBe('ati-1');
    expect(jwt.decode(signRefreshToken(USER)).ati).toBeUndefined();
  });

  it('is verifiable with the refresh secret, not the access secret', () => {
    const token = signRefreshToken(USER);
    expect(() => jwt.verify(token, 'test-refresh-secret')).not.toThrow();
    expect(() => jwt.verify(token, 'test-access-secret')).toThrow();
  });
});

describe('token TTL resolution', () => {
  it('defaults to 1h access / 7d refresh', () => {
    delete process.env.JWT_EXPIRES_IN;
    delete process.env.JWT_REFRESH_EXPIRES_IN;
    expect(accessTTL()).toBe('1h');
    expect(refreshTTL()).toBe('7d');
  });

  it('env overrides apply per call', () => {
    process.env.JWT_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '30d';
    expect(accessTTL()).toBe('15m');
    expect(refreshTTL()).toBe('30d');
  });

  it('signs with the resolved TTL (exp-iat matches)', () => {
    process.env.JWT_EXPIRES_IN = '15m';
    const payload = jwt.decode(signAccessToken(USER));
    expect(payload.exp - payload.iat).toBe(900);
  });
});
