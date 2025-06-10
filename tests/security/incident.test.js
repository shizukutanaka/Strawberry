// セキュリティインシデント検知・証跡管理ユーティリティの自動テスト雛形（Jest）
const fs = require('fs');
const path = require('path');
const { recordIncident } = require('../../src/security/incident');

const INCIDENT_LOG_PATH = path.join(__dirname, '../../logs/security-incident.log');

describe('incident', () => {
  beforeEach(() => {
    if (fs.existsSync(INCIDENT_LOG_PATH)) fs.unlinkSync(INCIDENT_LOG_PATH);
  });

  it('recordIncidentでインシデント証跡が記録される', () => {
    recordIncident('unauthorized_access', { user: 'attacker', ip: '1.2.3.4' });
    const content = fs.readFileSync(INCIDENT_LOG_PATH, 'utf-8');
    expect(content).toMatch(/unauthorized_access/);
    expect(content).toMatch(/attacker/);
  });
});
