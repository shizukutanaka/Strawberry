// backup.js - JSON永続化データの自動バックアップ・リストアスクリプト
// cloud-storage.js, notifier.jsを活用し、主要DBファイルを定期的にクラウドへバックアップ

const path = require('path');
const fs = require('fs');
const { uploadToS3, uploadToGoogleDrive, uploadToDropbox } = require('./cloud-storage');
const { sendNotification, NotifyType } = require('./notifier');
const { logger } = require('./logger');

// バックアップ対象ファイルリスト
const DATA_DIR = path.resolve(__dirname, '../../db/json');
const TARGET_FILES = [
  'OrderRepository.json',
  'PaymentRepository.json',
  'GpuRepository.json',
  // 必要に応じて追加
];

// 世代付きローカル自動バックアップ
function backupLocalWithGeneration(filePath) {
  if (!fs.existsSync(filePath)) return;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const backupName = `${base}.bak-${stamp}`;
  const backupPath = path.join(dir, backupName);
  fs.copyFileSync(filePath, backupPath);
  // 古いバックアップを一定数だけ残す（例: 10世代）
  const backups = fs.readdirSync(dir).filter(f => f.startsWith(base + '.bak-')).sort().reverse();
  for (let i = 10; i < backups.length; i++) {
    try { fs.unlinkSync(path.join(dir, backups[i])); } catch (e) {}
  }
}

// ファイル破損・消失時の自動リストア
function restoreFromLatestBackup(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backups = fs.readdirSync(dir).filter(f => f.startsWith(base + '.bak-')).sort().reverse();
  if (backups.length === 0) return false;
  try {
    fs.copyFileSync(path.join(dir, backups[0]), filePath);
    return true;
  } catch (e) { return false; }
}

async function backupAll() {
  for (const file of TARGET_FILES) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    // ローカル世代付きバックアップ
    try {
      backupLocalWithGeneration(filePath);
    } catch (e) {
      logger.error(`ローカルバックアップ失敗: ${file}`, { error: e.message });
    }
    try {
      if (process.env.AWS_S3_BUCKET) {
        try {
          await uploadToS3(backupFilePath, `backup/${file}`);
          success = true;
        } catch (e) {
          errors.push({ type: 'S3', error: e.message });
          logger.warn('S3バックアップ失敗', { error: e.message });
        }
      }
      if (process.env.DROPBOX_ACCESS_TOKEN) {
        try {
          await uploadToDropbox(backupFilePath, `/backup/${file}`);
          success = true;
        } catch (e) {
          errors.push({ type: 'Dropbox', error: e.message });
          logger.warn('Dropboxバックアップ失敗', { error: e.message });
        }
      }
      if (process.env.GDRIVE_OAUTH_TOKEN) {
        try {
          await uploadToGDrive(backupFilePath, `backup/${file}`);
          success = true;
        } catch (e) {
          errors.push({ type: 'GDrive', error: e.message });
          logger.warn('GDriveバックアップ失敗', { error: e.message });
        }
      }
      if (success) {
        logger.info('バックアップ成功', { file });
        if (process.env.LINE_TOKEN) {
          sendNotification(NotifyType.LINE, `バックアップ成功: ${file}`, { token: process.env.LINE_TOKEN }).catch(()=>{});
        }
        appendAuditLog('backup_success', { file });
      } else {
        logger.error('全クラウドバックアップ失敗', { file, errors });
        if (process.env.LINE_TOKEN) {
          sendNotification(NotifyType.LINE, `全クラウドバックアップ失敗: ${file} ${JSON.stringify(errors)}`, { token: process.env.LINE_TOKEN }).catch(()=>{});
        }
        appendAuditLog('backup_failed', { file, errors });
      }
    } catch (err) {
      logger.error('バックアップ処理自体が異常終了', { error: err.message });
      if (process.env.LINE_TOKEN) {
        sendNotification(NotifyType.LINE, `バックアップ処理異常: ${file} ${err.message}`, { token: process.env.LINE_TOKEN }).catch(()=>{});
      }
      appendAuditLog('backup_exception', { file, error: err.message });
    }
  }
}

// CLI/cronから呼び出し可能に
if (require.main === module) {
  backupAll().then(() => {
    logger.info('全バックアップ処理完了');
    process.exit(0);
  }).catch(err => {
    logger.error('バックアップ全体でエラー', { error: err.message });
    process.exit(1);
  });
}

module.exports = {
  backupAll,
};
