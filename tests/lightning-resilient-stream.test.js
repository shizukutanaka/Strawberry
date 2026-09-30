// lightning-service._setupResilientStream の再接続ロジック検証。
// gRPC ストリームは切断時に error→end→close が連鎖発火するため、イベント毎に
// 再接続を積む旧実装では subscribeInvoices が多重化していた。
const { EventEmitter } = require('events');
const { LightningService } = require('../lightning-service');

describe('_setupResilientStream', () => {
  let svc, streams;
  const makeStream = () => {
    const s = new EventEmitter();
    s.cancel = jest.fn();
    streams.push(s);
    return s;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    svc = new LightningService();
    streams = [];
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function start(subscribe = jest.fn(makeStream), onData = jest.fn()) {
    svc._setupResilientStream('invoice', subscribe, onData);
    return { subscribe, onData };
  }

  it('error/end/close の連鎖発火でも再接続は1本だけスケジュールされる', () => {
    const { subscribe } = start();
    const s = streams[0];
    s.emit('error', new Error('boom'));
    s.emit('end');
    s.emit('close');
    jest.advanceTimersByTime(5000);
    expect(subscribe).toHaveBeenCalledTimes(2); // 初回 + 再接続1回のみ
    expect(streams[0].cancel).toHaveBeenCalled(); // 旧ストリームは cancel 済み
  });

  it('連続失敗で指数バックオフし、データ到着でリセットされる', () => {
    const { subscribe, onData } = start();
    // 1回目失敗 → 5s
    streams[0].emit('error', new Error('e1'));
    expect(subscribe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(4999);
    expect(subscribe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(subscribe).toHaveBeenCalledTimes(2);

    // 2回目失敗 → 10s
    streams[1].emit('error', new Error('e2'));
    jest.advanceTimersByTime(9999);
    expect(subscribe).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(subscribe).toHaveBeenCalledTimes(3);

    // 3回目失敗 → 20s
    streams[2].emit('error', new Error('e3'));
    jest.advanceTimersByTime(19999);
    expect(subscribe).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    expect(subscribe).toHaveBeenCalledTimes(4);

    // データ到着で健全 → 次の失敗は 5s に戻る
    streams[3].emit('data', { ok: 1 });
    expect(onData).toHaveBeenCalledWith({ ok: 1 });
    streams[3].emit('end');
    jest.advanceTimersByTime(4999);
    expect(subscribe).toHaveBeenCalledTimes(4);
    jest.advanceTimersByTime(1);
    expect(subscribe).toHaveBeenCalledTimes(5);
  });

  it('subscribe 自体が投げても回復を試行し続ける', () => {
    let throwOnce = true;
    const subscribe = jest.fn(() => {
      if (throwOnce) { throwOnce = false; throw new Error('subscribe fail'); }
      return makeStream();
    });
    start(subscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(streams).toHaveLength(1);
  });

  it('バックオフは maxMs(5分) にキャップされる', () => {
    const { subscribe } = start();
    // 失敗を連鎖: 5s,10s,20s,40s,80s,160s の順に再接続
    const delays = [5000, 10000, 20000, 40000, 80000, 160000];
    for (const d of delays) {
      streams[streams.length - 1].emit('error', new Error('e'));
      jest.advanceTimersByTime(d);
    }
    // 7回目の失敗 → 5s*2^6=320s だが 300s にキャップ
    streams[streams.length - 1].emit('error', new Error('final'));
    const before = subscribe.mock.calls.length;
    jest.advanceTimersByTime(299999);
    expect(subscribe.mock.calls.length).toBe(before);
    jest.advanceTimersByTime(1);
    expect(subscribe.mock.calls.length).toBe(before + 1);
  });
});
