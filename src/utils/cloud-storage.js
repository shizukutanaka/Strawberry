// cloud-storage.js - クラウドストレージ連携（AWS S3, Google Drive, Dropbox）
// 成果物やバックアップデータを外部クラウドに保存するための共通ラッパー

const fs = require('fs');
const { logger } = require('./logger');

// クラウド SDK は重い任意依存のため遅延 require する（未導入環境でも本モジュールの
// require 自体は成功させる。services.js の「absent → disabled, not broken」方針と同型）。
// 以前はトップレベルで require していたため googleapis/dropbox 未インストールの環境で
// require('cloud-storage') 自体が MODULE_NOT_FOUND で落ち、これを取り込む
// utils/backup.js まで巻き込んでローカル世代バックアップすら動かなかった。
function loadAWS() {
  try {
    return require('aws-sdk');
  } catch (e) {
    throw new Error('S3 upload requires the optional dependency "aws-sdk" (npm i aws-sdk)');
  }
}
function loadGoogleApis() {
  try {
    return require('googleapis').google;
  } catch (e) {
    throw new Error('Google Drive upload requires the optional dependency "googleapis" (npm i googleapis)');
  }
}
function loadDropbox() {
  try {
    return require('dropbox').Dropbox;
  } catch (e) {
    throw new Error('Dropbox upload requires the optional dependency "dropbox" (npm i dropbox)');
  }
}

// S3アップロード
async function uploadToS3(localPath, remotePath, options = {}) {
  const AWS = loadAWS();
  const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });
  const fileContent = fs.readFileSync(localPath);
  const params = {
    Bucket: process.env.AWS_S3_BUCKET,
    Key: remotePath,
    Body: fileContent,
  };
  try {
    const res = await s3.upload(params).promise();
    logger.info('S3アップロード成功', { url: res.Location });
    return res.Location;
  } catch (err) {
    logger.error('S3アップロード失敗', { error: err.message });
    throw err;
  }
}

// Google Driveアップロード（OAuth2認証済みトークン必須）
async function uploadToGoogleDrive(localPath, remoteName, oauth2Client, folderId) {
  const google = loadGoogleApis();
  fs.accessSync(localPath, fs.constants.R_OK);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const fileMetadata = { name: remoteName, parents: folderId ? [folderId] : undefined };
  const media = { mimeType: 'application/octet-stream', body: fs.createReadStream(localPath) };
  try {
    const res = await drive.files.create({ resource: fileMetadata, media, fields: 'id,webViewLink' });
    logger.info('Google Driveアップロード成功', { id: res.data.id, link: res.data.webViewLink });
    return res.data;
  } catch (err) {
    logger.error('Google Driveアップロード失敗', { error: err.message });
    throw err;
  }
}

// Dropboxアップロード
async function uploadToDropbox(localPath, remotePath, accessToken) {
  const Dropbox = loadDropbox();
  const dbx = new Dropbox({ accessToken });
  const fileContent = fs.readFileSync(localPath);
  try {
    const res = await dbx.filesUpload({ path: remotePath, contents: fileContent });
    logger.info('Dropboxアップロード成功', { id: res.id });
    return res;
  } catch (err) {
    logger.error('Dropboxアップロード失敗', { error: err.message });
    throw err;
  }
}

module.exports = {
  uploadToS3,
  uploadToGoogleDrive,
  uploadToDropbox,
};
