// エラーハンドリングユーティリティの自動テスト雛形（Jest）
const { APIError, ErrorTypes, convertToAPIError, createError, errorMiddleware } = require('../../src/utils/error-handler');

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

  describe('errorMiddleware', () => {
    const makeRes = (headersSent) => ({
      headersSent,
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    });
    const req = { id: 'req-1', path: '/x', method: 'GET' };

    it('headersSent=false: JSON エラーレスポンスを返し next を呼ばない', () => {
      const res = makeRes(false);
      const next = jest.fn();
      errorMiddleware(new Error('boom'), req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(next).not.toHaveBeenCalled();
    });

    it('headersSent=true: 二重送信せず既定ハンドラへ委譲する', () => {
      // sendFile 途中のディスク障害などで到達。res.json() を呼ぶと
      // "Cannot set headers after they are sent" でハンドラ内例外になる。
      const res = makeRes(true);
      const next = jest.fn();
      const err = new Error('disk read failed mid-stream');
      errorMiddleware(err, req, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
