// public/electron.js の will-navigate 制限が origin 単位で判定されることの回帰テスト。
function loadMain(url) {
  jest.resetModules();
  if (url === undefined) delete process.env.STRAWBERRY_URL;
  else process.env.STRAWBERRY_URL = url;
  const handlers = {};
  jest.doMock('electron', () => ({
    app: {
      whenReady: () => ({ then: (fn) => fn() }),
      on: jest.fn(),
      exit: jest.fn(),
    },
    BrowserWindow: Object.assign(jest.fn().mockImplementation(() => ({
      webContents: {
        setWindowOpenHandler: jest.fn(),
        on: (evt, fn) => { handlers[evt] = fn; },
      },
      loadURL: jest.fn(),
      loadFile: jest.fn(),
    })), { getAllWindows: () => [] }),
    ipcMain: { on: jest.fn() },
    shell: { openExternal: jest.fn() },
  }), { virtual: true });
  require('../../public/electron.js');
  return (target) => {
    const event = { preventDefault: jest.fn() };
    handlers['will-navigate'](event, target);
    return !event.preventDefault.mock.calls.length;
  };
}

afterEach(() => {
  delete process.env.STRAWBERRY_URL;
  jest.dontMock('electron');
});

describe('electron main: will-navigate allowlist', () => {
  it('STRAWBERRY_URL と同一 origin のみ遷移を許可する', () => {
    const allowed = loadMain('https://app.example.com');
    expect(allowed('https://app.example.com/dashboard')).toBe(true);
    expect(allowed('https://app.example.com.evil.test/')).toBe(false);
    expect(allowed('https://app.example.com@evil.test/')).toBe(false);
    expect(allowed('http://app.example.com/')).toBe(false);
    expect(allowed('not a url')).toBe(false);
  });

  it('STRAWBERRY_URL 未指定時は file: のみ許可する', () => {
    const allowed = loadMain(undefined);
    expect(allowed('file:///app/public/index.html')).toBe(true);
    expect(allowed('https://evil.test/')).toBe(false);
  });
});
