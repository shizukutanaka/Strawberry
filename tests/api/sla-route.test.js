// GET /api/sla (JWT) と GET /api/anomalies (admin) の配線・認可契約を固定する。
// sla-tracker が data/sla.json へ集計する稼働率の配信経路。ルータは実装済み
// だが未 mount だったため、配線と同時に契約を固定する。
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { app } = require('../../src/api/server');
const { resolveDataDir } = require('../../src/db/json/data-dir');

const SLA_PATH = path.join(resolveDataDir(), 'sla.json');
const ANOMALY_PATH = path.join(__dirname, '../../logs/anomaly-history.json');

let token;
let adminToken;

beforeAll(async () => {
  const suffix = `${Date.now()}`;
  const password = 'TestPass123!';
  const email = `sla${suffix}@example.com`;
  await request(app).post('/api/v1/users/register').send({
    username: `slatester${suffix}`,
    email,
    password,
  });
  const login = await request(app).post('/api/v1/users/login').send({ email, password });
  token = login.body.token;

  const adminEmail = `slaadmin${suffix}@example.com`;
  await request(app).post('/api/v1/users/register').send({
    username: `slaadmin${suffix}`,
    email: adminEmail,
    password,
  });
  const UserRepository = require('../../src/db/json/UserRepository');
  const u = UserRepository.getByEmail(adminEmail);
  UserRepository.update(u.id, { role: 'admin' });
  const adminLogin = await request(app).post('/api/v1/users/login').send({ email: adminEmail, password });
  adminToken = adminLogin.body.token;
});

describe('GET /api/sla', () => {
  it('requires authentication (401 without token)', async () => {
    const res = await request(app).get('/api/sla');
    expect(res.statusCode).toBe(401);
  });

  it('returns default uptime stats when sla.json does not exist', async () => {
    if (fs.existsSync(SLA_PATH)) fs.renameSync(SLA_PATH, `${SLA_PATH}.bak`);
    try {
      const res = await request(app).get('/api/sla').set('Authorization', `Bearer ${token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ uptimeRate: 1, up: 0, down: 0, total: 0 });
    } finally {
      if (fs.existsSync(`${SLA_PATH}.bak`)) fs.renameSync(`${SLA_PATH}.bak`, SLA_PATH);
    }
  });

  it('computes uptimeRate from the tracked sla.json counters', async () => {
    const existed = fs.existsSync(SLA_PATH);
    let backup = null;
    if (existed) backup = fs.readFileSync(SLA_PATH, 'utf-8');
    fs.writeFileSync(SLA_PATH, JSON.stringify({ up: 9, down: 1, total: 10 }));
    try {
      const res = await request(app).get('/api/sla').set('Authorization', `Bearer ${token}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ uptimeRate: 0.9, up: 9, down: 1, total: 10 });
    } finally {
      if (backup !== null) fs.writeFileSync(SLA_PATH, backup);
      else if (fs.existsSync(SLA_PATH)) fs.unlinkSync(SLA_PATH);
    }
  });
});

describe('GET /api/anomalies', () => {
  it('requires authentication (401 without token)', async () => {
    const res = await request(app).get('/api/anomalies');
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-admin users (403)', async () => {
    const res = await request(app).get('/api/anomalies').set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(403);
  });

  it('returns the most recent 100 anomaly entries in reverse order for admin', async () => {
    const existed = fs.existsSync(ANOMALY_PATH);
    let backup = null;
    if (existed) backup = fs.readFileSync(ANOMALY_PATH, 'utf-8');
    fs.writeFileSync(ANOMALY_PATH, JSON.stringify([{ t: 1 }, { t: 2 }, { t: 3 }]));
    try {
      const res = await request(app).get('/api/anomalies').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual([{ t: 3 }, { t: 2 }, { t: 1 }]);
    } finally {
      if (backup !== null) fs.writeFileSync(ANOMALY_PATH, backup);
      else if (fs.existsSync(ANOMALY_PATH)) fs.unlinkSync(ANOMALY_PATH);
    }
  });

  it('returns [] for admin when the history file is missing', async () => {
    const existed = fs.existsSync(ANOMALY_PATH);
    if (existed) fs.renameSync(ANOMALY_PATH, `${ANOMALY_PATH}.bak`);
    try {
      const res = await request(app).get('/api/anomalies').set('Authorization', `Bearer ${adminToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual([]);
    } finally {
      if (existed) fs.renameSync(`${ANOMALY_PATH}.bak`, ANOMALY_PATH);
    }
  });
});
