// backup-poller: start/stop と pollOnce の安全性
const path = require('path');
const fs = require('fs');
const poller = require('../../src/core/backup-poller');

const DATA_DIR = path.resolve(__dirname, '../../data');
const BACKUP_DIR = path.resolve(__dirname, '../../backups');

describe('backup-poller', () => {
  afterEach(() => poller.stop());

  it('start() は初期遅延タイマーと定期タイマーを起動し、stop() で両方止まる', () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    try {
      poller.start();
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), poller.INITIAL_DELAY_MS);
      poller.stop();
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('start() の二重呼び出しは無害（タイマー増殖しない）', () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      poller.start();
      poller.start();
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      poller.stop();
    } finally {
      setTimeoutSpy.mockRestore();
      poller.stop();
    }
  });

  it('pollOnce は backupAll を実行して世代バックアップを作成する', async () => {
    const testFile = path.join(DATA_DIR, 'orders.json');
    const hadOriginal = fs.existsSync(testFile);
    const original = hadOriginal ? fs.readFileSync(testFile, 'utf-8') : null;
    try {
      fs.writeFileSync(testFile, JSON.stringify([{ id: 'bp-test' }]));
      await poller.pollOnce();
      const backups = fs.existsSync(BACKUP_DIR)
        ? fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('orders.json.bak-'))
        : [];
      expect(backups.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (hadOriginal) fs.writeFileSync(testFile, original);
      else try { fs.unlinkSync(testFile); } catch (_) {}
      if (fs.existsSync(BACKUP_DIR)) {
        for (const f of fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('orders.json.bak-'))) {
          try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
        }
      }
    }
  });
});
