// tests/unit/lightning-service-network-default.test.js
//
// LightningService のネットワーク既定値を安全側（testnet）に固定する回帰テスト。
//
// 配布方針（2026-11-13 決定）: Strawberry は testnet／モックのまま配布し、
// mainnet は有効化しない。ところが lightning-service.js のコンストラクタ既定は
// network='mainnet' + mainnet の admin.macaroon パスになっており、環境変数を
// 何も設定しない利用者は既定で mainnet の実 LND に向いてしまう配線だった。
// src/utils/config.js と .env.example の既定は testnet で、矛盾していたのは
// このファイルだけ。
//
// このテストは「env 未指定時の既定が testnet であること」と「env で明示指定
// した場合は従来どおりその値が使われること」の両方を固定する。既定が
// mainnet に戻ると前者が落ちる。
const path = require('path');
const { LightningService } = require('../../lightning-service');

describe('LightningService: ネットワーク既定値（安全側 testnet の固定）', () => {
  const KEYS = ['BITCOIN_NETWORK', 'LND_MACAROON_PATH'];
  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('env 未指定では network の既定が testnet になる', () => {
    const svc = new LightningService();
    expect(svc.config.network).toBe('testnet');
  });

  test('env 未指定では macaroon パスが testnet の admin.macaroon を指す', () => {
    const svc = new LightningService();
    const expected = path.join(
      process.env.HOME,
      '.lnd/data/chain/bitcoin/testnet/admin.macaroon'
    );
    expect(svc.config.macaroonPath).toBe(expected);
    expect(svc.config.macaroonPath).not.toContain('mainnet');
  });

  test('環境変数で明示指定した場合はその値が使われる（従来動作を変えない）', () => {
    process.env.BITCOIN_NETWORK = 'regtest';
    process.env.LND_MACAROON_PATH = '/custom/lnd/admin.macaroon';
    const svc = new LightningService();
    expect(svc.config.network).toBe('regtest');
    expect(svc.config.macaroonPath).toBe('/custom/lnd/admin.macaroon');
  });
});
