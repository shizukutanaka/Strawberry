// src/utils/google-calendar.js — googleapis 遅延 require と OAuth2/insert 配線の契約を固定するテスト。
// 「未導入環境でも require は成功し、呼出時のみ手順付きエラー」は services.js の
// absent→disabled 方針と同型。SDK 有無は jest.doMock で両方向を再現する。
const absent = () => () => {
  const e = new Error("Cannot find module 'googleapis'");
  e.code = 'MODULE_NOT_FOUND';
  throw e;
};

const SAVED = {};
function setEnv(k, v) { if (!(k in SAVED)) SAVED[k] = process.env[k]; process.env[k] = v; }
afterEach(() => {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
    delete SAVED[k];
  }
});

function loadGoogleCalendar(googleFactory) {
  jest.resetModules();
  jest.doMock('googleapis', googleFactory, { virtual: true });
  return require('../../src/utils/google-calendar');
}

describe('addEventToCalendar — googleapis absent', () => {
  it('rejects with an actionable install error (module still loads)', async () => {
    const gcal = loadGoogleCalendar(absent());
    await expect(gcal.addEventToCalendar({ summary: 'x' })).rejects.toThrow('npm i googleapis');
  });
});

describe('addEventToCalendar — googleapis present', () => {
  function fakeGoogle(captured) {
    class OAuth2 {
      constructor(id, secret, redirect) { captured.oauth = { id, secret, redirect }; }
      setCredentials(creds) { captured.creds = creds; }
    }
    return {
      google: {
        auth: { OAuth2 },
        calendar: () => ({
          events: { insert: async (req) => { captured.insert = req; return { data: { id: 'ev-1' } }; } },
        }),
      },
    };
  }

  it('builds OAuth2 client from env config and inserts the event', async () => {
    const captured = {};
    setEnv('GCAL_CLIENT_ID', 'cid');
    setEnv('GCAL_CLIENT_SECRET', 'sec');
    setEnv('GCAL_REDIRECT_URI', 'https://cb');
    setEnv('GCAL_REFRESH_TOKEN', 'rtok');
    const gcal = loadGoogleCalendar(() => fakeGoogle(captured));
    const out = await gcal.addEventToCalendar({ summary: 'rental' });
    expect(out).toEqual({ id: 'ev-1' });
    expect(captured.oauth).toEqual({ id: 'cid', secret: 'sec', redirect: 'https://cb' });
    expect(captured.creds).toEqual({ refresh_token: 'rtok' });
    expect(captured.insert.calendarId).toBe('primary');
    expect(captured.insert.resource).toEqual({ summary: 'rental' });
  });

  it('honors per-call config overrides (calendarId included)', async () => {
    const captured = {};
    setEnv('GCAL_CALENDAR_ID', 'primary');
    const gcal = loadGoogleCalendar(() => fakeGoogle(captured));
    await gcal.addEventToCalendar({ summary: 'x' }, {
      clientId: 'c2', clientSecret: 's2', redirectUri: 'r2',
      refreshToken: 'rt2', calendarId: 'cal-9',
    });
    expect(captured.oauth.id).toBe('c2');
    expect(captured.creds.refresh_token).toBe('rt2');
    expect(captured.insert.calendarId).toBe('cal-9');
  });
});
