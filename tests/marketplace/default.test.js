// tests/marketplace/default.test.js
// 既定 marketplace シングルトン（src/marketplace/default.js）の配線契約を固定する。
// このモジュールは全 HTTP ルートが共有する組み立て地点であり、
// verificationService への reputationService 注入（スラッシング経路）や
// 3 サービスの marketplace への注入が退行すると、検証→評価毀損の連鎖が
// 静かに切れるため、依存順序をピンする。

// 実組み立てを先に検証する（doMock は登録後の require へ持続するため、
// モック配線検証より前に実サービス面を確定させる）。
describe('marketplace/default real composition', () => {
  test('require に成功し 9 メソッドのサービス面を返す', () => {
    const svc = require('../../src/marketplace/default');
    for (const m of ['quoteGpu', 'rankCandidates', 'selectProvider', 'openOrderEscrow', 'recordPaid', 'verifyAndSettle', 'settleByUsage', 'resolveDispute', 'getEscrow']) {
      expect(typeof svc[m]).toBe('function');
    }
  });
});

const ESCROW_API = Symbol('escrowService');
const VERIFY_API = Symbol('verificationService');
const REP_API = Symbol('reputationService');
const MARKET_API = Symbol('marketplaceService');

function load() {
  const createEscrowService = jest.fn(() => ESCROW_API);
  const createVerificationService = jest.fn(() => VERIFY_API);
  const createReputationService = jest.fn(() => REP_API);
  const createMarketplaceService = jest.fn(() => MARKET_API);

  jest.resetModules();
  jest.doMock('../../src/payments/escrow-service', () => ({ createEscrowService }));
  jest.doMock('../../src/verification/verification-service', () => ({ createVerificationService }));
  jest.doMock('../../src/reputation/reputation-service', () => ({ createReputationService }));
  jest.doMock('../../src/marketplace/marketplace-service', () => ({ createMarketplaceService }));

  const exported = require('../../src/marketplace/default');
  return { exported, createEscrowService, createVerificationService, createReputationService, createMarketplaceService };
}

describe('marketplace/default singleton wiring', () => {
  test('verificationService へは同一モジュール内の reputationService を注入する', () => {
    const { createVerificationService } = load();
    expect(createVerificationService).toHaveBeenCalledTimes(1);
    // スラッシング（検証不一致 → 評価減点）のための依存注入をピンする。
    expect(createVerificationService).toHaveBeenCalledWith({ reputationService: REP_API });
  });

  test('marketplaceService へ escrow/verification/reputation の 3 サービスを注入する', () => {
    const { createMarketplaceService } = load();
    expect(createMarketplaceService).toHaveBeenCalledTimes(1);
    expect(createMarketplaceService).toHaveBeenCalledWith({
      escrowService: ESCROW_API,
      verificationService: VERIFY_API,
      reputationService: REP_API
    });
  });

  test('エクスポートは createMarketplaceService の返り値そのもの（追加ラップなし）', () => {
    const { exported } = load();
    expect(exported).toBe(MARKET_API);
  });

  test('各サービス作成関数はちょうど 1 回ずつ呼ばれる（シングルトン）', () => {
    const { createEscrowService, createVerificationService, createReputationService, createMarketplaceService } = load();
    for (const fn of [createEscrowService, createVerificationService, createReputationService, createMarketplaceService]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  test('escrow/reputation は引数なし既定（JSON リポジトリ既定配線）', () => {
    const { createEscrowService, createReputationService } = load();
    expect(createEscrowService).toHaveBeenCalledWith();
    expect(createReputationService).toHaveBeenCalledWith();
  });
});
