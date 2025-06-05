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

async function backupAll() {
  for (const file of TARGET_FILES) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      // S3
      if (process.env.AWS_S3_BUCKET) {
        await uploadToS3(filePath, `backup/${file}`, {});
      }
      // Google Drive
      if (process.env.GDRIVE_OAUTH_TOKEN) {
        // OAuth2Client生成はgoogle-calendar.js参照
        logger.info('Google Driveバックアップは未実装（OAuth2Client生成要）');
      }
      // Dropbox
      if (process.env.DROPBOX_ACCESS_TOKEN) {
        await uploadToDropbox(filePath, `/backup/${file}`, process.env.DROPBOX_ACCESS_TOKEN);
      }
      logger.info(`バックアップ成功: ${file}`);
    } catch (err) {
      logger.error(`バックアップ失敗: ${file}`, { error: err.message });
      // 管理者へ通知
      if (process.env.LINE_TOKEN) {
        sendNotification(NotifyType.LINE, `バックアップ失敗: ${file}\n${err.message}`, { token: process.env.LINE_TOKEN }).catch(()=>{});
      }
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
