// src/utils/cloud-storage.js — 任意 SDK の遅延 require 契約を固定するテスト。
// 「未導入環境でも本モジュールの require は成功し、呼出時のみ手順付きエラー」は
// #115 で直した backup.js 巻き込みクラッシュの再発防止。SDK 有無は jest.doMock
// で両方向を再現する（本環境のインストール有無に依存しない）。
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, 'cloud-storage-fixture.txt');

function loadWithMocks(mocks) {
  jest.resetModules();
  for (const [name, factory] of Object.entries(mocks)) {
    jest.doMock(name, factory, { virtual: true });
  }
  return require('../../src/utils/cloud-storage');
}
const absent = (name) => () => {
  const e = new Error(`Cannot find module '${name}'`);
  e.code = 'MODULE_NOT_FOUND';
  throw e;
};

beforeAll(() => fs.writeFileSync(FIXTURE, 'payload'));
afterAll(() => fs.rmSync(FIXTURE, { force: true }));

describe('lazy require contract (absent optional deps)', () => {
  it('uploadToS3 rejects with an actionable error naming the install command', async () => {
    const cs = loadWithMocks({ 'aws-sdk': absent('aws-sdk') });
    await expect(cs.uploadToS3(FIXTURE, 'key')).rejects.toThrow('aws-sdk');
    await expect(cs.uploadToS3(FIXTURE, 'key')).rejects.toThrow('npm i aws-sdk');
  });

  it('uploadToGoogleDrive rejects with an actionable error when googleapis is absent', async () => {
    const cs = loadWithMocks({ 'googleapis': absent('googleapis') });
    await expect(cs.uploadToGoogleDrive(FIXTURE, 'name', {})).rejects.toThrow('npm i googleapis');
  });

  it('uploadToDropbox rejects with an actionable error when dropbox is absent', async () => {
    const cs = loadWithMocks({ 'dropbox': absent('dropbox') });
    await expect(cs.uploadToDropbox(FIXTURE, '/x', 'tok')).rejects.toThrow('npm i dropbox');
  });
});

describe('uploadToS3 (aws-sdk present)', () => {
  it('uploads file contents to env bucket under remotePath and returns Location', async () => {
    let captured;
    const FakeS3 = class {
      upload(params) { captured = params; return { promise: async () => ({ Location: 'https://s3.example/key' }) }; }
    };
    jest.doMock('aws-sdk', () => ({ S3: FakeS3 }), { virtual: true });
    jest.resetModules();
    const cs = require('../../src/utils/cloud-storage');

    const saved = process.env.AWS_S3_BUCKET;
    process.env.AWS_S3_BUCKET = 'bucket-1';
    try {
      const out = await cs.uploadToS3(FIXTURE, 'remote/key');
      expect(out).toBe('https://s3.example/key');
      expect(captured).toEqual({ Bucket: 'bucket-1', Key: 'remote/key', Body: Buffer.from('payload') });
    } finally {
      if (saved === undefined) delete process.env.AWS_S3_BUCKET; else process.env.AWS_S3_BUCKET = saved;
    }
  });

  it('propagates fs read errors for a missing local file', async () => {
    const FakeS3 = class { upload() { return { promise: async () => ({}) }; } };
    jest.doMock('aws-sdk', () => ({ S3: FakeS3 }), { virtual: true });
    jest.resetModules();
    const cs = require('../../src/utils/cloud-storage');
    await expect(cs.uploadToS3('/nonexistent/nope', 'k')).rejects.toThrow();
  });
});
