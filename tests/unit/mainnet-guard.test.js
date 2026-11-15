// tests/unit/mainnet-guard.test.js
//
// 「mainnet は有効化しない」という配布方針（2026-11-13 決定）を、言葉ではなく
// コードの構造で守るガードの回帰テスト。
//
// 従来は BITCOIN_NETWORK 環境変数と config.json の lightning.network が
// 無検証で素通しされており、設定だけで mainnet の実 LND（admin.macaroon）や
// 本番決済プロバイダへ結線できた。本テストは、ネットワーク指定を受ける
// 全経路（network-guard 単体 / LightningService / 設定モジュール /
// REST 決済ラッパー）で mainnet が「接続・送金を試みる前に」例外になる
// ことを固定する。testnet/regtest の従来動作が変わっていないことも併せて固定する。
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveBitcoinNetwork,
  assertBitcoinNetworkAllowed,
} = require('../../src/utils/network-guard');

const ENV_KEYS = ['BITCOIN_NETWORK', 'LND_MACAROON_PATH', 'LN_PROVIDER', 'LN_API_KEY', 'LN_BASE_URL'];
let savedEnv;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('network-guard: 単体の解決・検査', () => {
  test('未指定は既定の testnet に解決される', () => {
    expect(resolveBitcoinNetwork(undefined)).toBe('testnet');
    expect(resolveBitcoinNetwork(null)).toBe('testnet');
    expect(resolveBitcoinNetwork('')).toBe('testnet');
  });

  test('mainnet は例外になる（大文字・前後空白の表記ゆれも塞ぐ）', () => {
    for (const v of ['mainnet', 'MAINNET', 'Mainnet', ' mainnet ']) {
      expect(() => resolveBitcoinNetwork(v, 'BITCOIN_NETWORK')).toThrow(/mainnet is disabled/);
      expect(() => assertBitcoinNetworkAllowed(v)).toThrow(/mainnet is disabled/);
    }
  });

  test('testnet / regtest / simnet は従来どおり素通しされる', () => {
    for (const v of ['testnet', 'regtest', 'simnet']) {
      expect(resolveBitcoinNetwork(v)).toBe(v);
      expect(assertBitcoinNetworkAllowed(v)).toBe(v);
    }
  });
});

describe('LightningService: mainnet 指定では構築自体が失敗する', () => {
  const { LightningService } = require('../../lightning-service');

  test('BITCOIN_NETWORK=mainnet では接続以前に例外になる', () => {
    process.env.BITCOIN_NETWORK = 'mainnet';
    expect(() => new LightningService()).toThrow(/mainnet is disabled/);
  });

  test('BITCOIN_NETWORK=testnet / regtest は従来どおり構築できる', () => {
    process.env.BITCOIN_NETWORK = 'testnet';
    expect(new LightningService().config.network).toBe('testnet');
    process.env.BITCOIN_NETWORK = 'regtest';
    expect(new LightningService().config.network).toBe('regtest');
  });
});

describe('設定モジュール (src/utils/config.js): mainnet はどちらの経路でも起動時に失敗する', () => {
  test('環境変数 BITCOIN_NETWORK=mainnet で require が例外になる', () => {
    process.env.BITCOIN_NETWORK = 'mainnet';
    jest.resetModules();
    expect(() => require('../../src/utils/config')).toThrow(/mainnet is disabled/);
  });

  test('config.json の lightning.network=mainnet でも require が例外になる', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strawberry-cfg-'));
    const prevCwd = process.cwd();
    try {
      fs.writeFileSync(
        path.join(tmp, 'config.json'),
        JSON.stringify({ lightning: { network: 'mainnet' } })
      );
      process.chdir(tmp);
      jest.resetModules();
      expect(() => require('../../src/utils/config')).toThrow(/mainnet is disabled/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('BITCOIN_NETWORK=testnet では従来どおり読み込める', () => {
    process.env.BITCOIN_NETWORK = 'testnet';
    jest.resetModules();
    const { config } = require('../../src/utils/config');
    expect(config.lightning.network).toBe('testnet');
  });
});

describe('REST 決済ラッパー (lightning-api): mainnet 宣言下では送金が実行されない', () => {
  jest.mock('axios');

  function setup(network) {
    jest.resetModules();
    const ax = require('axios');
    process.env.LN_PROVIDER = 'opennode';
    process.env.LN_API_KEY = 'key-123';
    process.env.LN_BASE_URL = 'https://ln.example.com';
    if (network !== undefined) process.env.BITCOIN_NETWORK = network;
    ax.post.mockResolvedValue({ data: { ok: true } });
    const api = require('../../src/api/utils/lightning-api');
    return { api, ax };
  }

  test('BITCOIN_NETWORK=mainnet では HTTP を発せずに例外になる', async () => {
    const { api, ax } = setup('mainnet');
    await expect(api.sendLightningPayment('bc1qaddr', 0.001)).rejects.toThrow(/mainnet is disabled/);
    expect(ax.post).not.toHaveBeenCalled();
  });

  test('BITCOIN_NETWORK=testnet では従来どおり送金が実行される', async () => {
    const { api, ax } = setup('testnet');
    await api.sendLightningPayment('bc1qaddr', 0.001);
    expect(ax.post).toHaveBeenCalledTimes(1);
  });

  test('BITCOIN_NETWORK 未指定（既定 testnet）でも従来どおり実行される', async () => {
    const { api, ax } = setup(undefined);
    await api.sendLightningPayment('bc1qaddr', 0.001);
    expect(ax.post).toHaveBeenCalledTimes(1);
  });
});
