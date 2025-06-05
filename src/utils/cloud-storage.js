// cloud-storage.js - クラウドストレージ連携（AWS S3, Google Drive, Dropbox）
// 成果物やバックアップデータを外部クラウドに保存するための共通ラッパー

const AWS = require('aws-sdk');
const { google } = require('googleapis');
const Dropbox = require('dropbox').Dropbox;
const fs = require('fs');
const { logger } = require('./logger');

// S3アップロード
async function uploadToS3(localPath, remotePath, options = {}) {
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
