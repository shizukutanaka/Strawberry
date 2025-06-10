// ロギングユーティリティの自動テスト雛形（Jest）
const fs = require('fs');
const path = require('path');
const { logger } = require('../../src/utils/logger');

const logDir = path.join(__dirname, '../../logs');
const combinedLog = path.join(logDir, 'combined.log');
const errorLog = path.join(logDir, 'error.log');

describe('logger', () => {
  beforeEach(() => {
    if (fs.existsSync(combinedLog)) fs.unlinkSync(combinedLog);
    if (fs.existsSync(errorLog)) fs.unlinkSync(errorLog);
  });

  it('infoログがcombined.logに出力される', done => {
    logger.info('test info log');
    setTimeout(() => {
      const content = fs.readFileSync(combinedLog, 'utf-8');
      expect(content).toMatch(/test info log/);
      done();
    }, 100);
  });

  it('errorログがerror.logに出力される', done => {
    logger.error('test error log');
    setTimeout(() => {
      const content = fs.readFileSync(errorLog, 'utf-8');
      expect(content).toMatch(/test error log/);
      done();
    }, 100);
  });
});
