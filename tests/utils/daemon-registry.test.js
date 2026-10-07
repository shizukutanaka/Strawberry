// daemon-registry — 常駐ループの一元管理（i10）の契約テスト。
const {
  registerDaemon,
  unregisterDaemon,
  stopAllDaemons,
  registeredDaemons,
} = require('../../src/utils/daemon-registry');

afterEach(() => {
  stopAllDaemons(); // 各テストの登録を掃除
});

test('register → registeredDaemons に名前が現れる', () => {
  registerDaemon('alpha', () => {});
  registerDaemon('beta', () => {});
  expect(registeredDaemons()).toEqual(['alpha', 'beta']);
});

test('stopAllDaemons は起動順の逆順に各 stop を呼ぶ', () => {
  const order = [];
  registerDaemon('first', () => order.push('first'));
  registerDaemon('second', () => order.push('second'));
  registerDaemon('third', () => order.push('third'));
  stopAllDaemons();
  expect(order).toEqual(['third', 'second', 'first']);
  expect(registeredDaemons()).toEqual([]);
});

test('1件の stop 失敗でも残りのデーモンは停止される', () => {
  const order = [];
  registerDaemon('bad', () => { throw new Error('boom'); });
  registerDaemon('good', () => order.push('good'));
  expect(() => stopAllDaemons()).not.toThrow();
  expect(order).toEqual(['good']);
  expect(registeredDaemons()).toEqual([]);
});

test('unregisterDaemon は対象だけを除籍する', () => {
  registerDaemon('a', () => {});
  registerDaemon('b', () => {});
  unregisterDaemon('a');
  expect(registeredDaemons()).toEqual(['b']);
});

test('同名の再登録は stopFn を上書きする', () => {
  const order = [];
  registerDaemon('x', () => order.push('old'));
  registerDaemon('x', () => order.push('new'));
  stopAllDaemons();
  expect(order).toEqual(['new']);
});

test('関数以外の stopFn は即座に拒否する', () => {
  expect(() => registerDaemon('bad', 'not-a-function')).toThrow(TypeError);
  expect(registeredDaemons()).not.toContain('bad');
});

test('各デーモンが start 時にレジストリへ自己登録する', () => {
  // 構造的ドリフト防止 — 新デーモン追加時に registry 登録を忘れないよう
  // ソースレベルで登録点を固定する。
  const fs = require('fs');
  const path = require('path');
  const sites = [
    ['src/core/invoice-poller.js', "registerDaemon('invoice-poller'"],
    ['src/utils/sla-tracker.js', "registerDaemon('sla-tracker'"],
    ['src/core/service-monitor.js', "registerDaemon('service-monitor'"],
    ['src/core/backup-scheduler.js', "registerDaemon('backup-scheduler'"],
    ['src/gpu/gpu-auto-heal.js', "registerDaemon('gpu-auto-heal'"],
    ['src/api/server.js', "registerDaemon('metrics-refresh'"],
    ['src/api/routes/order/index.js', "registerDaemon('order-sweep'"],
  ];
  for (const [file, needle] of sites) {
    const src = fs.readFileSync(path.join(__dirname, '../../', file), 'utf8');
    expect(src).toContain(needle);
  }
});
