// tests/verification/utilization-collector.test.js
// ゼロ負荷課金の検出（研究ドキュメント §1 Proof-of-Compute）。
//
// 重点は「片側の自己申告を証拠として扱っていないか」。プロバイダは検出したい不正の当事者、
// 借り手は返金目的で偽る動機があるため、どちらか一方が「遊休だった」と言っただけで
// zero_load と断定してはならない。
const uc = require('../../src/verification/utilization-collector');

const idle = (n = 10) => Array(n).fill(0);
const busy = (n = 10) => Array(n).fill(85);

beforeEach(() => uc._reset());

describe('record', () => {
  it('keeps samples separated by reporting role', () => {
    uc.record('o1', 'lender', 50);
    uc.record('o1', 'renter', 10);
    expect(uc.getSamples('o1')).toEqual({ lender: [50], renter: [10] });
  });

  it('rejects out-of-range and non-numeric values without throwing', () => {
    for (const bad of [-1, 101, NaN, 'ninety', null, undefined, {}]) {
      expect(uc.record('o1', 'lender', bad)).toBe(false);
    }
    expect(uc.getSamples('o1').lender).toEqual([]);
  });

  it('rejects an unknown role or a missing order id', () => {
    expect(uc.record('o1', 'admin', 50)).toBe(false);
    expect(uc.record('', 'lender', 50)).toBe(false);
  });

  it('bounds memory with a ring buffer, keeping the most recent samples', () => {
    // 長時間レンタルで無制限に積み上がるとプロセスメモリを食い潰す
    for (let i = 0; i < uc.MAX_SAMPLES_PER_ROLE + 50; i++) uc.record('o1', 'lender', i % 101);
    const { lender } = uc.getSamples('o1');
    expect(lender).toHaveLength(uc.MAX_SAMPLES_PER_ROLE);
    expect(lender[lender.length - 1]).toBe((uc.MAX_SAMPLES_PER_ROLE + 49) % 101);
  });

  it('clear() drops everything for an order', () => {
    uc.record('o1', 'lender', 50);
    uc.clear('o1');
    expect(uc.getSamples('o1')).toEqual({ lender: [], renter: [] });
  });
});

describe('assess', () => {
  const feed = (orderId, role, samples) => samples.forEach((s) => uc.record(orderId, role, s));

  it('reports no_data when neither side sent telemetry', () => {
    expect(uc.assess('o1').verdict).toBe('no_data');
  });

  it('refuses to judge on too few samples', () => {
    feed('o1', 'lender', [0, 0]);
    const r = uc.assess('o1');
    expect(r.verdict).toBe('insufficient');
    expect(r.lender.verdict).toBe('insufficient');
  });

  it('flags zero_load only when BOTH sides agree the GPU was idle', () => {
    // 偽る動機が逆向きの2者が同じことを言っている = 信頼できる
    feed('o1', 'lender', idle());
    feed('o1', 'renter', idle());
    const r = uc.assess('o1');
    expect(r.verdict).toBe('zero_load');
    expect(r.lender.activeRatio).toBe(0);
    expect(r.renter.activeRatio).toBe(0);
  });

  it('does NOT call it zero_load when only the renter claims idle', () => {
    // 借り手は返金目的で「遊休だった」と偽れる。単独申告で提供者を不正認定してはならない。
    feed('o1', 'lender', busy());
    feed('o1', 'renter', idle());
    expect(uc.assess('o1').verdict).toBe('disputed');
  });

  it('does NOT call it active when only the provider claims busy', () => {
    // 提供者は検出したい不正の当事者。自己申告だけで潔白にしてはならない。
    feed('o1', 'lender', busy());
    feed('o1', 'renter', idle());
    expect(uc.assess('o1').verdict).not.toBe('active');
  });

  it('reports active when both sides agree work was running', () => {
    feed('o1', 'lender', busy());
    feed('o1', 'renter', busy());
    expect(uc.assess('o1').verdict).toBe('active');
  });

  it('accepts a single side reporting activity when the other is silent', () => {
    // 片側のクライアントがテレメトリ非対応でも、稼働の記録がある方を採用する。
    // （zero_load の断定と違い、active 判定は誰も不利益を被らない）
    feed('o1', 'lender', busy());
    expect(uc.assess('o1').verdict).toBe('active');
  });

  it('does not flag zero_load from one silent side', () => {
    feed('o1', 'lender', idle());
    // 借り手が何も送っていない → 一致の確認ができないので断定しない
    expect(uc.assess('o1').verdict).toBe('insufficient');
  });

  it('honours the detection thresholds', () => {
    // 20% 未満の稼働率をゼロ負荷とみなす既定（minActiveRatio=0.2）
    const mostlyIdle = [0, 0, 0, 0, 0, 0, 0, 0, 0, 90];
    feed('o1', 'lender', mostlyIdle);
    feed('o1', 'renter', mostlyIdle);
    expect(uc.assess('o1').verdict).toBe('zero_load');

    uc._reset();
    const halfBusy = [0, 0, 0, 0, 0, 90, 90, 90, 90, 90];
    feed('o2', 'lender', halfBusy);
    feed('o2', 'renter', halfBusy);
    expect(uc.assess('o2').verdict).toBe('active');
  });

  it('is isolated per order', () => {
    feed('o1', 'lender', idle());
    feed('o1', 'renter', idle());
    feed('o2', 'lender', busy());
    feed('o2', 'renter', busy());
    expect(uc.assess('o1').verdict).toBe('zero_load');
    expect(uc.assess('o2').verdict).toBe('active');
  });
});
