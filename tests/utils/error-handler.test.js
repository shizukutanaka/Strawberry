// エラーハンドリングユーティリティの自動テスト雛形（Jest）
const { APIError, ErrorTypes, convertToAPIError, createError } = require('../../src/utils/error-handler');

describe('error-handler', () => {
  it('APIError生成・toJSON', () => {
    const err = new APIError(ErrorTypes.VALIDATION, 'msg', 400, { foo: 1 });
    const json = err.toJSON();
    expect(json.error.type).toBe(ErrorTypes.VALIDATION);
    expect(json.error.statusCode).toBe(400);
    expect(json.error.details.foo).toBe(1);
  });

  it('convertToAPIError: 既存APIErrorはそのまま', () => {
    const err = new APIError(ErrorTypes.NOT_FOUND, 'not found', 404);
    expect(convertToAPIError(err)).toBe(err);
  });

  it('convertToAPIError: 一般エラー→APIError変換', () => {
    const err = new Error('not found');
    const apiErr = convertToAPIError(err);
    expect(apiErr).toBeInstanceOf(APIError);
    expect(apiErr.type === ErrorTypes.NOT_FOUND || apiErr.type === 'INTERNAL').toBe(true);
  });

  it('createErrorでAPIError生成', () => {
    const err = createError(ErrorTypes.FORBIDDEN, 'forbidden', 403);
    expect(err).toBeInstanceOf(APIError);
    expect(err.type).toBe(ErrorTypes.FORBIDDEN);
    expect(err.statusCode).toBe(403);
  });
});
