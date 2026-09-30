// tests/api/mailer.test.js
// src/api/utils/mailer.js（master-auth のメール認証コード送信経路）の安全性を検証。
// - SMTP env 未設定時は nodemailer の不明瞭な接続失敗ではなく「どの env が不足か」の
//   分かるエラーで止まること
// - transporter 設定が requireTLS（587系で STARTTLS 非対応サーバへ認証情報を平文
//   送信しない）とタイムアウトを持つこと
// - transporter が遅延生成・再利用されること

jest.mock('nodemailer', () => {
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
  return { createTransport: jest.fn(() => ({ sendMail })) };
});

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MASTER_EMAIL_FROM'];

// jest.resetModules() 後に nodemailer モックを再 require してから mailer を読む
// （先に取ったモック参照は resetModules で mailer が受け取るインスタンスと別物になる）。
function loadMailer(env = {}) {
  jest.resetModules();
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const nodemailer = require('nodemailer');
  const mailer = require('../../src/api/utils/mailer');
  return {
    mailer,
    nodemailer,
    restore: () => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
    },
  };
}

describe('mailer.js', () => {
  test('SMTP env 未設定では nodemailer を呼ばず設定エラーで止まる', async () => {
    const { mailer, nodemailer, restore } = loadMailer();
    await expect(mailer.sendMail('a@b.c', 's', 'h')).rejects.toThrow(/SMTP_HOST/);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
    restore();
  });

  test('MASTER_EMAIL_FROM 未設定では設定エラーで止まる', async () => {
    const { mailer, restore } = loadMailer({
      SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p',
    });
    await expect(mailer.sendMail('a@b.c', 's', 'h')).rejects.toThrow(/MASTER_EMAIL_FROM/);
    restore();
  });

  test('587 ポートでは requireTLS + 3系統タイムアウトが設定される', async () => {
    const { mailer, nodemailer, restore } = loadMailer({
      SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MASTER_EMAIL_FROM: 'from@x.jp',
    });
    await mailer.sendMail('a@b.c', 's', 'h');
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    const opts = nodemailer.createTransport.mock.calls[0][0];
    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
    expect(opts.connectionTimeout).toBeGreaterThan(0);
    expect(opts.greetingTimeout).toBeGreaterThan(0);
    expect(opts.socketTimeout).toBeGreaterThan(0);
    restore();
  });

  test('465 ポートでは secure:true（implicit TLS）になる', async () => {
    const { mailer, nodemailer, restore } = loadMailer({
      SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MASTER_EMAIL_FROM: 'from@x.jp',
    });
    await mailer.sendMail('a@b.c', 's', 'h');
    const opts = nodemailer.createTransport.mock.calls[0][0];
    expect(opts.secure).toBe(true);
    expect(opts.requireTLS).toBe(false);
    restore();
  });

  test('transporter は遅延生成され再利用される（sendMail のたびに createTransport しない）', async () => {
    const { mailer, nodemailer, restore } = loadMailer({
      SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MASTER_EMAIL_FROM: 'from@x.jp',
    });
    await mailer.sendMail('a@b.c', 's', 'h');
    await mailer.sendMail('a@b.c', 's', 'h');
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    restore();
  });
});
