// scripts/sample.js（i18next 多言語デモ）の任意依存ハンドリングを検証する。
// i18next / i18next-fs-backend は package.json に未宣言のため、未導入環境で
// トップレベル require すると MODULE_NOT_FOUND で即死していた。

describe('scripts/sample.js', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('require しても副作用（i18next.init 実行）を起こさない', () => {
    // 旧実装は require 時点で i18next.init を実行していた（ライブラリ的に読み込めない）。
    expect(() => require('../../scripts/sample')).not.toThrow();
  });

  test('i18next 未導入では導入案内を表示して false を返す', async () => {
    jest.doMock('i18next', () => {
      const e = new Error("Cannot find module 'i18next'");
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }, { virtual: true });
    const { runI18nSample } = require('../../scripts/sample');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runI18nSample()).resolves.toBe(false);
      expect(spy.mock.calls.flat().join(' ')).toContain('npm i i18next i18next-fs-backend');
    } finally {
      spy.mockRestore();
    }
  });

  test('i18next 利用可なら locales パスで init してメッセージを表示する', async () => {
    const init = jest.fn((opts, cb) => cb(null));
    jest.doMock('i18next', () => ({
      use: jest.fn().mockReturnValue({ init }),
      t: jest.fn().mockReturnValue('ようこそ！'),
    }), { virtual: true });
    jest.doMock('i18next-fs-backend', () => function FsBackend() {}, { virtual: true });
    const { runI18nSample } = require('../../scripts/sample');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(runI18nSample()).resolves.toBe(true);
      expect(init).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbackLng: 'en',
          backend: expect.objectContaining({ loadPath: expect.stringContaining('locales') }),
        }),
        expect.any(Function),
      );
      expect(log).toHaveBeenCalledWith('ようこそ！');
    } finally {
      log.mockRestore();
    }
  });

  test('init がエラーを返した場合も false で返す', async () => {
    const init = jest.fn((opts, cb) => cb(new Error('locale load failed')));
    jest.doMock('i18next', () => ({ use: jest.fn().mockReturnValue({ init }), t: jest.fn() }), { virtual: true });
    jest.doMock('i18next-fs-backend', () => function FsBackend() {}, { virtual: true });
    const { runI18nSample } = require('../../scripts/sample');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runI18nSample()).resolves.toBe(false);
      expect(err.mock.calls.flat().join(' ')).toContain('locale load failed');
    } finally {
      err.mockRestore();
    }
  });
});
