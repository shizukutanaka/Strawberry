// src/api 配下のルートハンドラは全て asyncHandler で包む規約。
// Express 4 はハンドラが返す Promise の rejection を捕捉しないため、
// 裸の `async (req,res)` ハンドラ内で同期/非同期を問わず throw/reject すると
// unhandled rejection になり（Node 15 以降の既定ではプロセス終了）、
// errorMiddleware の一貫した 500 応答も発行されない。
const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', '..', 'src', 'api');

function* routeFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* routeFiles(p);
    else if (entry.name.endsWith('.js')) yield p;
  }
}

// `router.get/post/...('path', async (` のようにハンドラが裸の async 関数で
// 始まる宣言を拾う（asyncHandler(async (...) の形は検出しない）。
const BARE_ASYNC = /(?:router|app)\.(?:get|post|put|patch|delete)\([^)]*,\s*async\s*\(/g;

describe('route handlers: 裸の async ハンドラが存在しない（asyncHandler 規約）', () => {
  const offenders = [];
  for (const file of routeFiles(API_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(API_DIR, file);
    for (const m of src.matchAll(BARE_ASYNC)) {
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  it('async (req,res) を直接渡すハンドラが 0 件', () => {
    expect(offenders).toEqual([]);
  });
});

describe('errorHandler asyncHandler: rejection を next() へ転送する', () => {
  const { asyncHandler } = require('../../src/utils/error-handler');
  it('rejected promise が next(err) として errorMiddleware へ届く', async () => {
    const err = new Error('boom');
    const next = jest.fn();
    await asyncHandler(async () => { throw err; })({}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });
  // fn は非 async 関数として呼ばれるため、同期 throw は Express 4 の
  // ハンドラ呼出しの try/catch が捕捉して errorMiddleware へ届く。
  // テスト側で await するとテストへ rethrow される（正しい設計）。
  it('同期 throw は呼出し側へ伝播する（Express が捕捉）', () => {
    const err = new Error('sync-boom');
    const next = jest.fn();
    expect(() => asyncHandler(() => { throw err; })({}, {}, next)).toThrow(err);
    expect(next).not.toHaveBeenCalled();
  });
});
