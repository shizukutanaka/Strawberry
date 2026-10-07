// scripts/verify-data-consistency.js
// data/*.json の参照整合性を読み取り専用で検査する。
//
// 背景: JSON ファイルリポジトリにはリポジトリ横断トランザクションがないため、
// order/payment/escrow の複数ファイル更新が途中クラッシュすると不整合が残り得る
// （order は cancelled だが escrow は HELD のまま = 資金が永久ロック、等）。
// 本スクリプトはそれを「検知」するだけで変更はしない。
//
// 使い方: node scripts/verify-data-consistency.js [dataDir]
//   不整合があれば一覧表示して exit 1、なければ exit 0。

const fs = require('fs');
const path = require('path');

const ORDER_STATES = ['pending', 'matched', 'active', 'completed', 'cancelled', 'disputed'];
// payment routes（index.js/btc-onchain.js/invoice-poller/auto-recovery）が書く実値
const PAYMENT_STATES = ['pending', 'paid', 'failed', 'refunded'];
// escrow-state-machine.js の実状態（escrows.json は `state` フィールドで保持）
const ESCROW_STATES = ['PENDING', 'HELD', 'SETTLED', 'CANCELED', 'DISPUTED'];
// 資金を保持し続ける open 状態（DISPUTED は非終端で資金ロック中のため含む）
const OPEN_ESCROW_STATES = new Set(['PENDING', 'HELD', 'DISPUTED']);

function escrowState(e) {
  // escrow-service は `state` を書く。`status` も許容（他経路のレコード向け）。
  return e.state !== undefined ? e.state : e.status;
}

function loadCollection(dataDir, name, issues) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) {
    issues.push({ severity: 'warn', check: 'missing-file', detail: `${name}: ファイルが存在しない` });
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    issues.push({ severity: 'error', check: 'parse', detail: `${name}: JSON パース失敗 (${e.message})` });
    return [];
  }
  if (!Array.isArray(parsed)) {
    issues.push({ severity: 'error', check: 'shape', detail: `${name}: 配列ではない (${typeof parsed})` });
    return [];
  }
  return parsed;
}

function checkDuplicateIds(name, rows, issues) {
  const seen = new Set();
  for (const row of rows) {
    const id = row && row.id;
    if (id === undefined || id === null) {
      issues.push({ severity: 'error', check: 'missing-id', detail: `${name}: id のないレコード` });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ severity: 'error', check: 'duplicate-id', detail: `${name}: id "${id}" が重複` });
    }
    seen.add(id);
  }
}

// dataDir の JSON 群を検査し { issues, summary } を返す。書き込みは一切しない。
const KNOWN_COLLECTIONS = ['orders.json', 'payments.json', 'escrows.json', 'verifications.json', 'gpus.json', 'users.json'];

function run(dataDir) {
  const issues = [];
  const orders = loadCollection(dataDir, 'orders.json', issues);
  const payments = loadCollection(dataDir, 'payments.json', issues);
  const escrows = loadCollection(dataDir, 'escrows.json', issues);
  const verifications = loadCollection(dataDir, 'verifications.json', issues);
  const gpus = loadCollection(dataDir, 'gpus.json', issues);
  const users = loadCollection(dataDir, 'users.json', issues);

  checkDuplicateIds('orders.json', orders, issues);
  checkDuplicateIds('payments.json', payments, issues);
  checkDuplicateIds('escrows.json', escrows, issues);
  checkDuplicateIds('verifications.json', verifications, issues);
  checkDuplicateIds('gpus.json', gpus, issues);
  checkDuplicateIds('users.json', users, issues);

  // data/ 内の他の *.json も全件カバー — 固定リスト外のストア（watches/sla/token-denylist等）が
  // 破損・非配列・id 欠落/重複でも静黙スキップされないよう、浅い検査だけ一律適用する。
  // ドットファイル（.e2e-snapshot 等）は対象外。
  let allJson = [];
  try {
    allJson = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json') && !f.startsWith('.') && !KNOWN_COLLECTIONS.includes(f));
  } catch (e) {
    issues.push({ severity: 'warn', check: 'data-dir-unreadable', detail: `data dir の列挙に失敗: ${e.message}` });
  }
  const extraCollections = [];
  const extraObjects = new Map(); // オブジェクト形ストア（sla.json 等）も後続検査へ
  for (const file of allJson) {
    // 実データにはオブジェクト形ストアも混在（notification-settings=userId→prefs、
    // revoked-tokens=jti→expiry）— パースのみ一律で、配列なら id 系チェックまで適用。
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    } catch (e) {
      issues.push({ severity: 'error', check: 'parse', detail: `${file}: JSON パース失敗 (${e.message})` });
      continue;
    }
    if (Array.isArray(parsed)) {
      checkDuplicateIds(file, parsed, issues);
      extraCollections.push([file, parsed]);
    } else if (parsed && typeof parsed === 'object') {
      extraObjects.set(file, parsed);
    }
  }

  const orderIds = new Set(orders.map((o) => o.id));
  const orderStatus = new Map(orders.map((o) => [o.id, o.status]));
  const orderById = new Map(orders.map((o) => [o && o.id, o]));

  // orderId を持つ全レコードの参照先存在チェック（配列ストアなら全件 — reputations の
  // orderId も対象。資金・取引直結の参照なので error）
  for (const [name, rows] of [['payments.json', payments], ['escrows.json', escrows], ['verifications.json', verifications], ...extraCollections]) {
    for (const row of rows) {
      if (row && row.orderId !== undefined && !orderIds.has(row.orderId)) {
        issues.push({
          severity: 'error',
          check: 'dangling-order-ref',
          detail: `${name}: id "${row.id}" が存在しない order "${row.orderId}" を参照`,
        });
      }
    }
  }

  // orderId 未設定の escrow/payment — orderId フィールド自体を欠くレコードは
  // 上の dangling 検査をすり抜ける（!== undefined でしか判定しない）が、
  // どの注文の資金か判別不能 = 「誰の資金か不明」。清算・返金で注文へ戻れない。
  for (const [name, rows] of [['payments.json', payments], ['escrows.json', escrows]]) {
    for (const row of rows) {
      if (row && row.orderId === undefined) {
        issues.push({ severity: 'warn', check: 'missing-order-ref', detail: `${name}: id "${row.id}" に orderId がない（どの注文の資金か判別不能）` });
      }
    }
  }

  // エンティティ横断参照: gpuId→gpus、providerId/renterId/userId→users。
  // ユーザー削除等で dangling が正当な場合もあり得るため warn 止まり
  // （資金直結の orderId 参照だけ error）。
  const gpuIds = new Set(gpus.map((g) => g.id));
  const userIds = new Set(users.map((u) => u.id));
  const USER_REF_FIELDS = ['providerId', 'renterId', 'userId'];
  const collections = [
    ['orders.json', orders],
    ['payments.json', payments],
    ['escrows.json', escrows],
    ['verifications.json', verifications],
    ['gpus.json', gpus],
    ...extraCollections, // reputations/uptime 等の配列ストアも参照整合へ含める
  ];
  for (const [name, rows] of collections) {
    for (const row of rows) {
      if (!row) continue;
      if (row.gpuId !== undefined && !gpuIds.has(row.gpuId)) {
        issues.push({ severity: 'warn', check: 'dangling-gpu-ref', detail: `${name}: id "${row.id}" が存在しない gpu "${row.gpuId}" を参照` });
      }
      for (const f of USER_REF_FIELDS) {
        if (row[f] !== undefined && !userIds.has(row[f])) {
          issues.push({ severity: 'warn', check: 'dangling-user-ref', detail: `${name}: id "${row.id}" の ${f} "${row[f]}" は存在しない user を参照` });
        }
      }
    }
  }

  // 状態の相互整合: order 終端 × escrow 未清算
  const escrowsByOrder = new Map();
  for (const e of escrows) {
    if (!e || e.orderId === undefined) continue;
    if (!escrowsByOrder.has(e.orderId)) escrowsByOrder.set(e.orderId, []);
    escrowsByOrder.get(e.orderId).push(e);
  }

  for (const e of escrows) {
    if (!e) continue;
    const st = escrowState(e);
    if (st && !ESCROW_STATES.includes(st)) {
      issues.push({ severity: 'warn', check: 'unknown-escrow-status', detail: `escrows.json: id "${e.id}" の state "${st}" は未定義` });
    }
    const oStatus = orderStatus.get(e.orderId);
    if (oStatus === undefined) continue; // dangling-ref は上で報告済み
    if ((oStatus === 'completed' || oStatus === 'cancelled') && OPEN_ESCROW_STATES.has(st)) {
      issues.push({
        severity: 'error',
        check: 'stuck-escrow',
        detail: `escrow "${e.id}" (${st}) が終端 order "${e.orderId}" (${oStatus}) に残存 — 資金ロックの可能性`,
      });
    }
    if (st === 'SETTLED' && oStatus !== 'completed') {
      issues.push({
        severity: 'error',
        check: 'premature-settlement',
        detail: `escrow "${e.id}" が SETTLED だが order "${e.orderId}" は ${oStatus}`,
      });
    }
    if (st === 'DISPUTED' && oStatus !== 'disputed') {
      issues.push({
        severity: 'warn',
        check: 'dispute-mismatch',
        detail: `escrow "${e.id}" が DISPUTED だが order "${e.orderId}" は ${oStatus}`,
      });
    }
    // 資金返済/清算済みなのに order が進行中（返金後もレンタル継続 = 無償提供状態）
    if ((st === 'CANCELED' || st === 'SETTLED') && (oStatus === 'active' || oStatus === 'matched')) {
      issues.push({
        severity: 'warn',
        check: 'closed-escrow-active-order',
        detail: `escrow "${e.id}" は ${st} だが order "${e.orderId}" は ${oStatus}（資金フロー終了済みで注文が進行中）`,
      });
    }
  }

  // verification → escrow 参照（verifyAndSettle は常に escrowId 付きで open する）と
  // verdict↔escrow 状態の整合:
  //   dangling-escrow-ref   : escrowId が存在しない → 資金経路を失った検証 (error)
  //   stuck-verdict         : verdict=pending のまま escrow が終端 → 結論のないまま資金移動 (warn)
  //   verdict-escrow-mismatch: verdict=failed で SETTLED / verdict=verified で CANCELED (warn)
  const escrowIds = new Set(escrows.map((e) => e && e.id));
  const escrowStateById = new Map(escrows.map((e) => [e.id, escrowState(e)]));
  for (const v of verifications) {
    if (!v) continue;
    if (v.escrowId !== undefined && v.escrowId !== null && !escrowIds.has(v.escrowId)) {
      issues.push({ severity: 'error', check: 'dangling-escrow-ref', detail: `verifications.json: id "${v.id}" が存在しない escrow "${v.escrowId}" を参照` });
      continue;
    }
    if (v.escrowId === undefined || v.escrowId === null) continue;
    const es = escrowStateById.get(v.escrowId);
    if (v.verdict === 'pending' && (es === 'SETTLED' || es === 'CANCELED')) {
      issues.push({ severity: 'warn', check: 'stuck-verdict', detail: `verifications.json: id "${v.id}" は verdict=pending のまま escrow "${v.escrowId}" が ${es}` });
    }
    if (v.verdict === 'failed' && es === 'SETTLED') {
      issues.push({ severity: 'warn', check: 'verdict-escrow-mismatch', detail: `verifications.json: id "${v.id}" は failed 判定なのに escrow "${v.escrowId}" が SETTLED（失敗作業への支払い?）` });
    }
    if (v.verdict === 'verified' && es === 'CANCELED') {
      issues.push({ severity: 'warn', check: 'verdict-escrow-mismatch', detail: `verifications.json: id "${v.id}" は verified 判定なのに escrow "${v.escrowId}" が CANCELED（成功作業が未支払い?）` });
    }
    // 検証が結論を出したのに order が cancelled — 証明された作業をしても
    // 支払い側に転がらなかった証跡。
    const vOrderId = v.escrowId != null ? (escrows.find((e) => e && e.id === v.escrowId) || {}).orderId : undefined;
    const vOrderStatus = vOrderId != null ? orderStatus.get(vOrderId) : undefined;
    if (v.verdict === 'verified' && vOrderStatus === 'cancelled') {
      issues.push({ severity: 'warn', check: 'verified-cancelled-order', detail: `verifications.json: id "${v.id}" は verified 判定だが order "${vOrderId}" は cancelled（証明された作業が未支払いの可能性）` });
    }
  }

  // GPU 二重予約: order 作成ルートは同一 gpuId の BLOCKING(pending/matched/active)
  // 注文と時間帯重複を拒否する（order/index.js:1019-1032）。そのガードを迂回して
  // 共存する予約 = 物理的に不可能な同時占有。range = [scheduledStartAt||createdAt, +durationMinutes]。
  const BLOCKING = new Set(['pending', 'matched', 'active']);
  const byGpu = new Map();
  for (const o of orders) {
    if (!o || !o.gpuId || !BLOCKING.has(o.status)) continue;
    const start = Date.parse(o.scheduledStartAt || o.createdAt);
    if (Number.isNaN(start)) continue;
    const end = start + (o.durationMinutes || 0) * 60 * 1000;
    const list = byGpu.get(o.gpuId) || [];
    for (const prev of list) {
      if (start < prev.end && end > prev.start) {
        issues.push({ severity: 'error', check: 'double-booked-gpu', detail: `orders.json: gpu "${o.gpuId}" に時間帯重複する BLOCKING 注文 ("${prev.id}" ${prev.status} と "${o.id}" ${o.status})` });
      }
    }
    list.push({ id: o.id, status: o.status, start, end });
    byGpu.set(o.gpuId, list);
  }

  // settlement の保存不変条件（settlement-calculator.js が保証するもの）:
  //   providerPayoutSats + renterRefundSats + operatorFeeSats === total(=amountSats)
  //   chargedSats <= amountSats、全フィールド非負。乖離 = 直接編集か旧計算の漂流。
  for (const e of escrows) {
    if (!e || !e.settlement) continue;
    const s = e.settlement;
    const fields = ['providerPayoutSats', 'renterRefundSats', 'operatorFeeSats', 'chargedSats'];
    const nums = fields.map((f) => s[f]);
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      issues.push({ severity: 'warn', check: 'settlement-invalid', detail: `escrows.json: id "${e.id}" の settlement に非有限/負のフィールド` });
      continue;
    }
    const [payout, refund, fee, charged] = nums;
    if (payout + refund + fee !== e.amountSats) {
      issues.push({ severity: 'error', check: 'settlement-mismatch', detail: `escrows.json: id "${e.id}" の settlement 合計 ${payout + refund + fee} ≠ amountSats ${e.amountSats}` });
    }
    if (charged > e.amountSats) {
      issues.push({ severity: 'error', check: 'settlement-overflow', detail: `escrows.json: id "${e.id}" の chargedSats ${charged} が amountSats ${e.amountSats} を超過（預かり超の課金）` });
    }
  }

  // 利用不可 GPU 上の open order — 作成ルートは available===false を 409 で拒否する
  // （order/index.js:909）。open 状態の order が available=false の GPU を指すのは
  // 予約後の可用性低下（正常）か出品側の誤更新（要復帰判断） — ops 判断材料として warn。
  {
    const gpuById = new Map(gpus.map((g) => [g && g.id, g]));
    for (const o of orders) {
      if (!o || !o.gpuId) continue;
      const g = gpuById.get(o.gpuId);
      if (BLOCKING.has(o.status) && g && g.available === false) {
        issues.push({ severity: 'warn', check: 'unavailable-gpu-order', detail: `orders.json: id "${o.id}" (${o.status}) は available=false の gpu "${o.gpuId}" を参照（予約中の利用不可出品）` });
      }
      // order.providerId は作成時に gpu.providerId をスナップショット
      // （order/index.js:1037）。両者の食い違いは出品者変更・直接編集の兆候で、
      // SLA 違反通知・評判更新・払い戻しの宛先が齟齬になる。
      if (g && o.providerId !== undefined && g.providerId !== undefined
          && o.providerId !== g.providerId) {
        issues.push({ severity: 'warn', check: 'provider-mismatch', detail: `orders.json: id "${o.id}" の providerId "${o.providerId}" と gpu "${o.gpuId}" の providerId "${g.providerId}" が不一致（帰属ずれの兆候）` });
      }
    }
  }

  // totalPrice の非正値 — 作成時は Math.max(1, round(price×h)) で ≥1 を保証
  // （order/index.js:1051）。0・負・非数の totalPrice は集計系（stats の
  // completedSats/JPY 加算）で静黙に 0 扱いされる売上計上漏れの兆候。
  // レガシー注文の totalPrice 未設定は order-pricing 側が再計算するので対象外。
  for (const o of orders) {
    if (o && o.totalPrice !== undefined && !(typeof o.totalPrice === 'number' && Number.isFinite(o.totalPrice) && o.totalPrice > 0)) {
      issues.push({ severity: 'warn', check: 'invalid-total-price', detail: `orders.json: id "${o.id}" の totalPrice "${o.totalPrice}" は非正値（集計・請求で 0 扱いの売上計上漏れ）` });
    }
  }

  // profit-addresses.json — 運営利益の送金先。要素はアドレス文字列のみの
  // プレーン配列で、書込み側は isValidBtcAddress
  // （api/utils/profit-addresses.js:33-46 の mainnet/testnet/regtest 形式）
  // で検証する。形式外の混入値は sendBTC の瞬間に不可逆な損失になるため error。
  // 0 件登録は手数料の送金経路が全くない状態（backup.js の注記と同等）で warn。
  const PAYOUT_ADDR_PATTERNS = [
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,39}$/,
    /^[2mn][a-km-zA-HJ-NP-Z1-9]{25,39}$/,
    /^bc1[a-z0-9]{11,87}$/,
    /^tb1[a-z0-9]{11,87}$/,
    /^bcrt1[a-z0-9]{11,87}$/,
  ];
  const payoutEntry = extraCollections.find(([file]) => file === 'profit-addresses.json');
  const payoutAddrs = payoutEntry ? payoutEntry[1] : null;
  if (Array.isArray(payoutAddrs)) {
    for (const a of payoutAddrs) {
      const s = typeof a === 'string' ? a.trim() : a;
      const ok = typeof s === 'string' && s.length >= 14 && s.length <= 100
        && PAYOUT_ADDR_PATTERNS.some((re) => re.test(s));
      if (!ok) {
        issues.push({ severity: 'error', check: 'invalid-payout-address', detail: `profit-addresses.json: "${String(a).slice(0, 40)}" は BTC アドレス形式外（この先の送金は不可逆な損失になる）` });
      }
    }
    if (payoutAddrs.length === 0) {
      issues.push({ severity: 'warn', check: 'no-payout-address', detail: 'profit-addresses.json が 0 件（手数料の送金先が未登録）' });
    }
  }

  // revoked-tokens.json — {jti: expiryMs} のオブジェクトマップ。ローダーは
  // 非数値エントリを静黙ドロップ（token-denylist.js:42）するため、数値以外の
  // 値を持つ失効レコードは「記録されているが効いていない」= logout 済み JWT
  // が復活するセキュリティホール → error。期限切れ残存は次回 revoke で
  // GC される滞留（warn）。
  {
    // {jti: expiryMs} のオブジェクトマップ（配列系チェックとは形状が違うため直接読む）
    let denyParsed = null;
    try {
      denyParsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'revoked-tokens.json'), 'utf8'));
    } catch { /* 不在・破損は loadCollection 系の parse エラー側で報告済み */ }
    if (denyParsed && typeof denyParsed === 'object' && !Array.isArray(denyParsed)) {
      const now = Date.now();
      for (const [jti, expiryMs] of Object.entries(denyParsed)) {
        if (typeof expiryMs !== 'number' || !Number.isFinite(expiryMs)) {
          issues.push({ severity: 'error', check: 'invalid-denylist-entry', detail: `revoked-tokens.json: "${jti}" の expiry "${expiryMs}" は非数値 — ローダーが静黙ドロップし失効が効いていない` });
        } else if (expiryMs <= now) {
          issues.push({ severity: 'warn', check: 'stale-revoked-token', detail: `revoked-tokens.json: "${jti}" は期限切れ（次回 revoke まで滞留 — GC 対象）` });
        }
      }
    }
  }

  // notification-settings.json — {userId: {enabled, lineToken, ...}} の
  // オブジェクトマップ（user-notify.js:31）。users.json にないキーへの設定は
  // 「消えたユーザーへの通知ルート」= 宛先不明のゴースト設定（warn）。
  // 値がオブジェクトでない異形レコードも warn。
  {
    let notifParsed = null;
    try {
      notifParsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'notification-settings.json'), 'utf8'));
    } catch { /* 不在・破損は parse 系で報告済み */ }
    if (notifParsed && typeof notifParsed === 'object' && !Array.isArray(notifParsed)) {
      for (const [uid, prefs] of Object.entries(notifParsed)) {
        if (userIds.size > 0 && !userIds.has(uid)) {
          issues.push({ severity: 'warn', check: 'orphan-notification-settings', detail: `notification-settings.json: 存在しない user "${uid}" への通知設定（宛先不明のゴースト設定）` });
        }
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
          issues.push({ severity: 'warn', check: 'invalid-notification-settings', detail: `notification-settings.json: user "${uid}" の設定値がオブジェクトでない（通知解決が壊れる）` });
        }
      }
    }
  }

  // 終端/進行ステータスの対応タイムスタンプ欠落 — completed は completedAt
  // （旧レコードは stoppedAt フォールバック order/index.js:1555）、cancelled は
  // cancelledAt、matched は matchedAt が書かれる。欠落はレビュー期間アンカー・
  // 課金期間・タイムライン (:586-589) を破壊する。
  const STATUS_TS = {
    completed: ['completedAt', 'stoppedAt'],
    cancelled: ['cancelledAt'],
    matched: ['matchedAt'],
  };
  for (const o of orders) {
    const fields = o && STATUS_TS[o.status];
    if (fields && !fields.some((f) => o[f])) {
      issues.push({ severity: 'warn', check: 'missing-status-timestamp', detail: `orders.json: id "${o.id}" は status "${o.status}" だが ${fields.join('/')} がない（レビュー期間・課金アンカーが不明）` });
    }
  }

  // paid だが paidAt を欠く payment — status→paid 遷移は paidAt を書く
  // （payment/index.js:97, btc-onchain.js:288）。欠落は支払い時刻の
  // 欠損で、課金レポート・監査の時系列復元ができない。
  for (const p of payments) {
    if (p && p.status === 'paid' && !p.paidAt) {
      issues.push({ severity: 'warn', check: 'missing-paid-timestamp', detail: `payments.json: id "${p.id}" は paid だが paidAt がない（支払い時刻が不明）` });
    }
  }

  // 開始予定を大幅に過ぎた pending order — scheduledStartAt は作成時
  // 「過去5分以内」必須（order/index.js:1007）で LN invoice 期限は ~1h。
  // 24h 以上前の予約が pending のまま = 支払いが永遠に来ない枠占有
  // （時間帯重複ガードが pending を BLOCKING に含むため他注文を締め出す）。
  {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const o of orders) {
      const t = o && o.status === 'pending' && o.scheduledStartAt && Date.parse(o.scheduledStartAt);
      if (t && t < cutoff) {
        issues.push({ severity: 'warn', check: 'stuck-pending-reservation', detail: `orders.json: id "${o.id}" は開始予定 ${o.scheduledStartAt} から24h超経過も pending（支払いの来ない枠占有）` });
      }
    }
  }

  // 同一 order の二重 paid — 1注文の入金は payment 1レコードが前提
  // （invoice-poller は paid→matched を一度だけ進める）。paid が2件以上
  // ある = 二重請求・二重入金の証跡で、返金しても残った paid が
  // 無払い検査をすり抜ける → error。
  {
    const paidByOrder = new Map();
    for (const p of payments) {
      if (p && p.status === 'paid' && p.orderId) {
        paidByOrder.set(p.orderId, (paidByOrder.get(p.orderId) || 0) + 1);
      }
    }
    // 支払者≠借り手 — payment.userId は req.user.id（payment/index.js:52等）、
    // order.userId も注文者自身（order/index.js:1035）。両者が異なる = 他人の注文を
    // 支払った帰属矛盾（ルートは :197 で本人/admin のみ許可 — admin 代理払いは
    // あり得るため warn）。返金・監査時に「誰が払ったか」が食い違う。
    for (const p of payments) {
      if (!p || !p.orderId || !p.userId) continue;
      const o = orderById.get(p.orderId);
      if (o && o.userId && o.userId !== p.userId) {
        issues.push({ severity: 'warn', check: 'payer-order-mismatch', detail: `payments.json: id "${p.id}" の userId "${p.userId}" と order "${p.orderId}" の userId "${o.userId}" が不一致（支払者≠借り手）` });
      }
    }

    for (const [orderId, count] of paidByOrder) {
      if (count > 1) {
        issues.push({ severity: 'error', check: 'double-paid-order', detail: `payments.json: order "${orderId}" に paid が ${count} 件（二重課金の証跡）` });
      }
    }
  }

  // escrow.history の異形 — FSM は遷移ごとに `{ event, from, to, at }` を
  // append し、紛争時の再現はこれに依存する。配列でない・イベント名の
  // ない要素は遷移証跡の破損 → warn（監査ログが一次証跡のため warn 止まり）。
  for (const e of escrows) {
    if (!e || e.history === undefined) continue;
    if (!Array.isArray(e.history)) {
      issues.push({ severity: 'warn', check: 'malformed-escrow-history', detail: `escrows.json: id "${e.id}" の history が配列でない（遷移証跡破損）` });
      continue;
    }
    if (e.history.some((h) => !h || typeof h !== 'object' || !h.event)) {
      issues.push({ severity: 'warn', check: 'malformed-escrow-history', detail: `escrows.json: id "${e.id}" の history に event 名のない要素がある（遷移証跡破損）` });
    }
  }

  // userId 未設定の order — 作成は `orderData.userId = req.user.id` で
  // 借り手を必ず記録する（order/index.js:1035）。欠落は課金・レビュー・
  // 返金・SLA 通知の帰属ができない「誰の注文か分からない」状態。
  for (const o of orders) {
    if (o && !o.userId && !o.renterId) {
      issues.push({ severity: 'warn', check: 'missing-renter', detail: `orders.json: id "${o.id}" (${o.status}) に userId/renterId がない（借り手帰属不能）` });
    }
  }

  // gpuId 未設定の order — 作成ルートは gpuId を必須とする
  // （order/index.js:888 'gpuId is required'）。欠落は実行対象を失った予約で
  // 二重予約判定・検証・SLA 集計の全てが対象を特定できない。
  for (const o of orders) {
    if (o && !o.gpuId) {
      issues.push({ severity: 'warn', check: 'missing-gpu', detail: `orders.json: id "${o.id}" (${o.status}) に gpuId がない（実行対象を失った予約）` });
    }
  }

  // 予約/価格フィールドの健全性（作成ルートの検証と同一規約）:
  //   order.durationMinutes … 正の整数かつ5の倍数かつ ≤43200（order/index.js:881、
  //     上限は Joi schemas.order.create が担保 — 30日超の注文はスキーマ迂回）
  //   gpu.pricePerHour      … 正の数（order/index.js:952）
  for (const o of orders) {
    if (o && 'durationMinutes' in o) {
      if (!(Number.isInteger(o.durationMinutes) && o.durationMinutes > 0 && o.durationMinutes % 5 === 0)) {
        issues.push({ severity: 'warn', check: 'invalid-duration', detail: `orders.json: id "${o.id}" の durationMinutes "${o.durationMinutes}" は正の5の倍数整数ではない` });
      } else if (o.durationMinutes > 43200) {
        issues.push({ severity: 'warn', check: 'invalid-duration', detail: `orders.json: id "${o.id}" の durationMinutes "${o.durationMinutes}" は上限 43200（30日）超過 — スキーマ検証の迂回` });
      }
    }
    // 予約窓の不変条件: scheduledEndAt = scheduledStartAt + durationMinutes
    // （order/index.js:1042）。ずれは手動編集・他経路書き込みの兆候 — 二重予約
    // 判定や SLA 計算が壊れる。±1秒の許容誤差（端数・手動補正の丸め）。
    if (o && o.scheduledStartAt && o.scheduledEndAt && Number.isFinite(o.durationMinutes)) {
      const start = Date.parse(o.scheduledStartAt);
      const end = Date.parse(o.scheduledEndAt);
      if (Number.isFinite(start) && Number.isFinite(end)
          && Math.abs(end - (start + o.durationMinutes * 60 * 1000)) > 1000) {
        issues.push({ severity: 'warn', check: 'schedule-window-mismatch', detail: `orders.json: id "${o.id}" の scheduledEndAt が start+duration と不一致（予約窓の破損 — 重複判定/SLA が狂う）` });
      }
    }
    // 課金額の不変条件: totalPrice = max(1, round(pricePerHour × durationMinutes / 60))
    // sats（order/index.js:1049-1051 — pricePerHour は注文時にロック :1058）。
    // ずれは「請求書が約定額と違う」直接編集/他経路書込みの兆候。1 sat の
    // 端数許容（手動補正）。非正値は invalid-total-price が担当するので対象外。
    if (o && Number.isFinite(o.totalPrice) && o.totalPrice > 0
        && Number.isFinite(o.pricePerHour) && o.pricePerHour > 0
        && Number.isFinite(o.durationMinutes) && o.durationMinutes > 0) {
      const expected = Math.max(1, Math.round(o.pricePerHour * o.durationMinutes / 60));
      if (Math.abs(o.totalPrice - expected) > 1) {
        issues.push({ severity: 'warn', check: 'total-price-mismatch', detail: `orders.json: id "${o.id}" の totalPrice ${o.totalPrice} sat が約定計算値 ${expected} sat と不一致（価格ロックの破損）` });
      }
    }
  }
  // gpu.available の非真偽値 — ブッキングゲートは `available === false` の
  // 厳密比較（order/index.js:909）。"no"/0/"false" のような異形値は
  // ブロックされずに予約を受け付ける一方、集計・検索側では偽値として
  // 扱われ得る「どちらとも取れない」出品状態 → warn。
  for (const g of gpus) {
    if (g && 'available' in g && typeof g.available !== 'boolean') {
      issues.push({ severity: 'warn', check: 'invalid-availability', detail: `gpus.json: id "${g.id}" の available "${g.available}" は真偽値でない（出品フラグ破損）` });
    }
  }

  // GPU 登録スキーマ（validator.js:36-49）を迂回した出品 — vendor/apiType の
  // enum 外値はフィルタ検索（gpu/index.js:177-178）にヒットしない「見えない出品」、
  // memoryGB の範囲外値は能力誤表示。
  {
    const VENDORS = ['NVIDIA', 'AMD', 'Intel'];
    const API_TYPES = ['CUDA', 'ROCm', 'oneAPI', 'OpenCL'];
    for (const g of gpus) {
      if (!g) continue;
      if (g.vendor !== undefined && !VENDORS.includes(g.vendor)) {
        issues.push({ severity: 'warn', check: 'invalid-gpu-enum', detail: `gpus.json: id "${g.id}" の vendor "${g.vendor}" は enum 外（検索フィルタに載らない出品）` });
      }
      if (g.apiType !== undefined && !API_TYPES.includes(g.apiType)) {
        issues.push({ severity: 'warn', check: 'invalid-gpu-enum', detail: `gpus.json: id "${g.id}" の apiType "${g.apiType}" は enum 外（検索フィルタに載らない出品）` });
      }
      if (g.memoryGB !== undefined && !(typeof g.memoryGB === 'number' && g.memoryGB >= 1 && g.memoryGB <= 8192)) {
        issues.push({ severity: 'warn', check: 'invalid-gpu-memory', detail: `gpus.json: id "${g.id}" の memoryGB "${g.memoryGB}" は範囲外 [1,8192]（能力誤表示）` });
      }
    }
  }

  // model 未設定の GPU — model は価格推定（market-pricing-engine）、検索
  // （gpu/index.js:178）、重複排除キー (:522,:717) の識別子。欠落は
  // 「何の GPU か判別不能な出品」。
  for (const g of gpus) {
    if (g && !g.model) {
      issues.push({ severity: 'warn', check: 'missing-gpu-model', detail: `gpus.json: id "${g.id}" に model がない（価格推定・検索・重複排除が効かない出品）` });
    }
  }

  // pricePerHour 未設定の GPU — 価格不明の出品は見積もり・order 作成を
  // 通せない。'pricePerHour' in g ガードで非正値を見ている invalid-price と対。
  for (const g of gpus) {
    if (g && !('pricePerHour' in g)) {
      issues.push({ severity: 'warn', check: 'missing-gpu-price', detail: `gpus.json: id "${g.id}" に pricePerHour がない（価格不明で注文不能な出品）` });
    }
  }
  for (const g of gpus) {
    if (g && 'pricePerHour' in g && !(typeof g.pricePerHour === 'number' && Number.isFinite(g.pricePerHour) && g.pricePerHour > 0)) {
      issues.push({ severity: 'warn', check: 'invalid-price', detail: `gpus.json: id "${g.id}" の pricePerHour "${g.pricePerHour}" は正の数ではない（予約不可・価格計算破損）` });
    }
  }

  // 金額の健全性: escrow-service は create 時に amountSats の正有限数を強制するが、
  // 手動編集・旧レコードで非数/0/負が混入し得る。payment.amount も同様。
  for (const e of escrows) {
    if (e && 'amountSats' in e && !(typeof e.amountSats === 'number' && Number.isFinite(e.amountSats) && e.amountSats > 0)) {
      issues.push({ severity: 'warn', check: 'invalid-amount', detail: `escrows.json: id "${e.id}" の amountSats "${e.amountSats}" は正の有限数ではない` });
    }
  }
  for (const p of payments) {
    if (p && 'amount' in p && !(typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0)) {
      issues.push({ severity: 'warn', check: 'invalid-amount', detail: `payments.json: id "${p.id}" の amount "${p.amount}" は正の有限数ではない` });
    }
  }

  // 同一 paymentHash の payment 複数存在 — LN invoice は hash で一意のはず。
  // 二重レコード = 同一請求書の重複課金経路 or レコード破損。
  const seenHashes = new Map();
  for (const p of payments) {
    if (!p || !p.paymentHash) continue;
    const prev = seenHashes.get(p.paymentHash);
    if (prev) {
      issues.push({ severity: 'error', check: 'duplicate-payment-hash', detail: `payments.json: paymentHash が複数 id (${prev}, ${p.id}) で重複（同一請求書の二重課金経路?）` });
    } else {
      seenHashes.set(p.paymentHash, p.id);
    }
  }

  // open escrow が deadlineAt を超過 — escrow-service は deadlineAt を書くが
  // 参照するコードが存在しないため、期限切れ hold は放置される。要手動対応の warn。
  const now = Date.now();
  for (const e of escrows) {
    if (!e) continue;
    const st = escrowState(e);
    if (st !== undefined && OPEN_ESCROW_STATES.has(st) && e.deadlineAt) {
      const dl = Date.parse(e.deadlineAt);
      if (!Number.isNaN(dl) && dl < now) {
        issues.push({ severity: 'warn', check: 'expired-open-escrow', detail: `escrows.json: id "${e.id}" (${st}) は deadlineAt ${e.deadlineAt} を超過しているが open のまま` });
      }
    }
  }

  // HELD escrow の解放情報欠落 — LN escrow の清算は preimageHash の開示
  // （escrow-service.js:38, state-machine DELIVER_OK→reveal_preimage）、
  // btc-onchain escrow は txBorrowerToOperator を前提（btc-onchain.js:252）。
  // 両方を欠く HELD は「鍵を失った資金ロック」— 解除にも清算にも進めない → warn。
  for (const e of escrows) {
    if (e && escrowState(e) === 'HELD' && !e.preimageHash && !e.txBorrowerToOperator) {
      issues.push({ severity: 'warn', check: 'held-escrow-unreleasable', detail: `escrows.json: id "${e.id}" が HELD だが解放情報（preimageHash / txBorrowerToOperator）を欠く — 資金ロック解除不能` });
    }
  }

  // 同一 order に複数の未清算 escrow（DISPUTED も資金保持中のため含む）
  for (const [orderId, list] of escrowsByOrder) {
    const open = list.filter((e) => OPEN_ESCROW_STATES.has(escrowState(e)));
    if (open.length > 1) {
      issues.push({
        severity: 'error',
        check: 'double-open-escrow',
        detail: `order "${orderId}" に未清算 escrow が ${open.length} 件 (${open.map((e) => e.id).join(', ')})`,
      });
    }
  }

  // タイムスタンプ健全性 — createdAt/paidAt/updatedAt が ISO 解釈不能、または
  // 未来日付のレコード。期限切れ検査（expired-open-escrow）や各種表示集計が
  // 時刻に依存するため、不正値は検査・集計の両方を誤判定させる。
  {
    const nowMs = Date.now();
    // scheduledStartAt は未来日付が正常（予約）なので future チェックは過去時刻前提の3フィールドのみ
    const TS_FIELDS = ['createdAt', 'updatedAt', 'paidAt', 'scheduledStartAt'];
    const PAST_TS_FIELDS = new Set(['createdAt', 'updatedAt', 'paidAt']);
    for (const [name, rows] of collections) {
      for (const row of rows) {
        if (!row) continue;
        for (const f of TS_FIELDS) {
          if (row[f] !== undefined) {
            const t = Date.parse(row[f]);
            if (!Number.isFinite(t)) {
              issues.push({ severity: 'warn', check: 'invalid-timestamp', detail: `${name}: id "${row.id}" の ${f} "${row[f]}" は解釈不能` });
            } else if (PAST_TS_FIELDS.has(f) && t > nowMs) {
              issues.push({ severity: 'warn', check: 'future-timestamp', detail: `${name}: id "${row.id}" の ${f} "${row[f]}" は未来日付（時刻ずれか改竄の疑い）` });
            }
          }
        }
      }
    }
  }

  // ステータス時系列の逆転 — createdAt→matchedAt→(completedAt|stoppedAt|cancelledAt)
  // の順は状態機械が保証するはずで、逆転は時計ずれ・直接編集・移行破損の兆候。
  // payment 側は paidAt→settledAt（invoice-poller.js:157 で paid→settle の順）。
  {
    const ts = (v) => (v !== undefined && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
    for (const o of orders) {
      if (!o) continue;
      const created = ts(o.createdAt);
      const matched = ts(o.matchedAt);
      const end = ts(o.completedAt || o.stoppedAt || o.cancelledAt);
      if (created !== null && matched !== null && matched < created) {
        issues.push({ severity: 'warn', check: 'status-chronology', detail: `orders.json: id "${o.id}" の matchedAt が createdAt より前（状態遷移の時系列逆転）` });
      }
      if (matched !== null && end !== null && end < matched) {
        issues.push({ severity: 'warn', check: 'status-chronology', detail: `orders.json: id "${o.id}" の終了時刻が matchedAt より前（状態遷移の時系列逆転）` });
      }
      if (matched === null && created !== null && end !== null && end < created) {
        issues.push({ severity: 'warn', check: 'status-chronology', detail: `orders.json: id "${o.id}" の終了時刻が createdAt より前（状態遷移の時系列逆転）` });
      }
    }
    for (const p of payments) {
      if (!p) continue;
      const paid = ts(p.paidAt);
      const settled = ts(p.settledAt);
      if (paid !== null && settled !== null && settled < paid) {
        issues.push({ severity: 'warn', check: 'status-chronology', detail: `payments.json: id "${p.id}" の settledAt が paidAt より前（決済時系列の逆転）` });
      }
    }
  }

  // providerId 未設定の GPU — 支払い先を欠いた出品（escrow 清算で providerId に
  // 払えない・出品者特定不能）。同時にレビュー評価の範囲検査（書込み側は整数1-5
  // を強制: order/index.js:1573。読み集計は同フィルタで静黙除外するため範囲外値は
  // 「あるのに集計に出ない」不整合になる — #233 のフィルタをここでも適用）
  for (const g of gpus) {
    if (g && !g.providerId) {
      issues.push({ severity: 'warn', check: 'missing-provider', detail: `gpus.json: id "${g.id}" に providerId がない（支払い先不明の出品）` });
    }
  }
  for (const o of orders) {
    if (!o) continue;
    for (const key of ['renterReview', 'providerReview', 'review']) {
      const r = o[key];
      if (r && !(Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5)) {
        issues.push({ severity: 'warn', check: 'invalid-rating', detail: `orders.json: id "${o.id}" の ${key}.rating "${r.rating}" は整数1-5ではない（集計対象外の幽霊レビュー）` });
      }
    }
    // o.review は completed 注文へ1回限り（order/index.js:1582 の updateIf ガード）。
    // 完了前レビュー・完了後に status が戻った注文はゲート迂回の兆候。
    if (o.review && o.status !== 'completed') {
      issues.push({ severity: 'warn', check: 'review-on-unfinished-order', detail: `orders.json: id "${o.id}" (${o.status}) にレビューがある（completed 前提ゲートの迂回）` });
    }
  }

  // email 未設定の user — ログイン・パスワードリセット・通知全てが email を
  // キーにするため、email のないアカウントは認証経路を失った「開かない部屋」。
  for (const u of users) {
    if (u && !u.email) {
      issues.push({ severity: 'warn', check: 'missing-email', detail: `users.json: id "${u.id}" に email がない（ログイン・通知経路を失ったアカウント）` });
    }
    // 形式異常 email — 書込み側は Joi.string().email() で検証する
    // (user/index.js:78 → validator.js:220) ので、混入は移行・直接編集の兆候。
    // 通知・リセットは静黙失敗するため保守的パターンで warn。
    if (u && typeof u.email === 'string' && u.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)) {
      issues.push({ severity: 'warn', check: 'invalid-email', detail: `users.json: id "${u.id}" の email "${u.email}" は形式外（通知・認証が静黙失敗）` });
    }
  }

  // 未定義ロール — 権限チェックは admin/lender/provider/renter/user/system の
  // 集合で判定するため、それ以外の role は「どの権限にも合致しない幽霊権限」
  // （レンターのはずが借りられない等）になり得る。
  const KNOWN_ROLES = new Set(['admin', 'lender', 'provider', 'renter', 'user', 'system']);
  for (const u of users) {
    if (u && u.role !== undefined && !KNOWN_ROLES.has(u.role)) {
      issues.push({ severity: 'warn', check: 'unknown-role', detail: `users.json: id "${u.id}" の role "${u.role}" は未定義（権限マトリクス外）` });
    }
  }

  // 同一メールの複数ユーザ（登録経路で大小文字正規化が揃っていないため衝突し得る:
  // OAuth は lowered、パスワード登録は非正規化。getByEmail が曖昧化する）
  const seenEmails = new Map();
  for (const u of users) {
    if (!u || !u.email) continue;
    const key = String(u.email).toLowerCase();
    const prev = seenEmails.get(key);
    if (prev) {
      issues.push({ severity: 'warn', check: 'duplicate-email', detail: `users.json: email "${u.email}" が複数 id (${prev}, ${u.id}) で重複（大小文字無視）` });
    } else {
      seenEmails.set(key, u.id);
    }
  }

  // 重複/形式異常 username — getByUsername は完全一致（UserRepository.js:20）のため
  // 重複は片方が照会不能なアカウント化、形式外値（3-30文字の [a-zA-Z0-9_-] 以外:
  // user/index.js:408）は更新・認証系バリデーションを通れない化石レコードの兆候。
  {
    const seenUsernames = new Map();
    const USERNAME_RE = /^[a-zA-Z0-9_-]{3,30}$/;
    for (const u of users) {
      if (!u || u.username === undefined) continue;
      if (seenUsernames.has(u.username)) {
        issues.push({ severity: 'warn', check: 'duplicate-username', detail: `users.json: username "${u.username}" が複数 id (${seenUsernames.get(u.username)}, ${u.id}) で重複（片方が照会不能）` });
      } else {
        seenUsernames.set(u.username, u.id);
      }
      if (typeof u.username === 'string' && !USERNAME_RE.test(u.username)) {
        issues.push({ severity: 'warn', check: 'invalid-username', detail: `users.json: id "${u.id}" の username "${u.username}" は形式外（バリデーションを通れない化石レコード）` });
      }
    }
  }

  // watches.json — (userId, gpuId) 一意はルートの upsert で担保
  // （gpu/index.js:1229）。upsert を迂回した重複は同じ GPU に複数しきい値が
  // 残り通知が二重化する。targetPrice は作成時に正の数を検証（:1216） —
  // 非正値はアラートが永遠に発火しない死レコード。
  {
    const watches = (extraCollections.find(([n]) => n === 'watches.json') || [null, []])[1];
    const seenWatch = new Map();
    for (const w of watches) {
      if (!w) continue;
      if (w.userId !== undefined && w.gpuId !== undefined) {
        const key = `${w.userId}${w.gpuId}`;
        if (seenWatch.has(key)) {
          issues.push({ severity: 'warn', check: 'duplicate-watch', detail: `watches.json: (userId,gpuId)=("${w.userId}","${w.gpuId}") のウォッチが複数 (${seenWatch.get(key)}, ${w.id}) — upsert 迂回の重複で通知二重化` });
        } else {
          seenWatch.set(key, w.id);
        }
      }
      if (w.targetPrice !== undefined && !(typeof w.targetPrice === 'number' && Number.isFinite(w.targetPrice) && w.targetPrice > 0)) {
        issues.push({ severity: 'warn', check: 'invalid-watch-target', detail: `watches.json: id "${w.id}" の targetPrice "${w.targetPrice}" は非正値（永遠に発火しない死レコード）` });
      }
    }
  }

  // reputations.json — providerId で1レコード（ReputationRepository.js の
  // getByProviderId 単発検索）。重複は片方が集計から見えない評判の分裂。
  {
    const reputations = (extraCollections.find(([n]) => n === 'reputations.json') || [null, []])[1];
    const seenProvider = new Map();
    for (const r of reputations) {
      if (!r || r.providerId === undefined) continue;
      if (seenProvider.has(r.providerId)) {
        issues.push({ severity: 'warn', check: 'duplicate-provider-reputation', detail: `reputations.json: providerId "${r.providerId}" のレコードが複数 (${seenProvider.get(r.providerId)}, ${r.id}) — 評判の分裂` });
      } else {
        seenProvider.set(r.providerId, r.id);
      }
    }
  }

  // sla.json — updateSLA は total++ と up++/down++ を必ずペアで進める
  // （sla-tracker.js:50-53）ため、up+down≠total は手動編集・途中クラッシュの兆候。
  // カウンタの非数・負値も uptimeRate 計算（:73）を破損する。
  {
    const sla = extraObjects.get('sla.json');
    if (sla) {
      for (const k of ['total', 'up', 'down']) {
        if (sla[k] !== undefined && !(typeof sla[k] === 'number' && Number.isFinite(sla[k]) && sla[k] >= 0)) {
          issues.push({ severity: 'warn', check: 'sla-counter-invalid', detail: `sla.json: ${k} "${sla[k]}" は非数・負値（uptimeRate 計算を破損）` });
        }
      }
      if (typeof sla.up === 'number' && typeof sla.down === 'number' && typeof sla.total === 'number'
          && sla.up + sla.down !== sla.total) {
        issues.push({ severity: 'warn', check: 'sla-counter-mismatch', detail: `sla.json: up(${sla.up})+down(${sla.down}) != total(${sla.total}) — カウンタの不整合（手動編集・途中クラッシュの兆候）` });
      }
      if (sla.history !== undefined) {
        if (!Array.isArray(sla.history)) {
          issues.push({ severity: 'warn', check: 'sla-history-invalid', detail: 'sla.json: history が配列でない（死活履歴の破損）' });
        } else {
          const bad = sla.history.filter((h) => !h || typeof h.time !== 'string' || typeof h.alive !== 'boolean').length;
          if (bad > 0) {
            issues.push({ severity: 'warn', check: 'sla-history-invalid', detail: `sla.json: history に形式外の要素が ${bad} 件（{time, alive} 形でない）` });
          }
        }
      }
    }
  }

  // uptime.json — providerId で1レコード（UptimeRepository.js の getByProviderId
  // 単発検索、upsert で一意担保）。重複は片方が集計から見えない稼働実績の分裂。
  // beats/gapEvents/sessions の非数・負値は稼働率算出を破損する。
  {
    const uptimes = (extraCollections.find(([n]) => n === 'uptime.json') || [null, []])[1];
    const seenProvider = new Map();
    for (const u of uptimes) {
      if (!u) continue;
      if (u.providerId !== undefined) {
        if (seenProvider.has(u.providerId)) {
          issues.push({ severity: 'warn', check: 'duplicate-provider-uptime', detail: `uptime.json: providerId "${u.providerId}" のレコードが複数 (${seenProvider.get(u.providerId)}, ${u.id}) — 稼働実績の分裂` });
        } else {
          seenProvider.set(u.providerId, u.id);
        }
      }
      for (const k of ['beats', 'gapEvents', 'sessions']) {
        if (u[k] !== undefined && !(typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0)) {
          issues.push({ severity: 'warn', check: 'invalid-uptime-counter', detail: `uptime.json: id "${u.id}" の ${k} "${u[k]}" は非数・負値（稼働率算出を破損）` });
        }
      }
    }
  }

  // order/payment の未知ステータス
  for (const o of orders) {
    if (o && o.status && !ORDER_STATES.includes(o.status)) {
      issues.push({ severity: 'warn', check: 'unknown-order-status', detail: `orders.json: id "${o.id}" の status "${o.status}" は未定義` });
    }
  }
  for (const p of payments) {
    if (p && p.status && !PAYMENT_STATES.includes(p.status)) {
      issues.push({ severity: 'warn', check: 'unknown-payment-status', detail: `payments.json: id "${p.id}" の status "${p.status}" は未定義` });
    }
  }

  // 支払いチャネル不明 — paid な payment で method/paymentMethod が両方ないと
  // 「Lightning? BTC on-chain? 手動承認?」が判別不能で、二重課金検査
  // （btc-onchain.js:63 は paid && method !== 'btc_onchain' で既払いを検出）をすり抜ける。
  // pending/failed/refunded はチャネルが資金安全性に効かないため対象外。
  for (const p of payments) {
    if (p && p.status === 'paid' && p.method === undefined && p.paymentMethod === undefined) {
      issues.push({ severity: 'warn', check: 'missing-method', detail: `payments.json: id "${p.id}" (paid) に method/paymentMethod がない（支払いチャネル不明 — 二重課金検査をすり抜ける）` });
    }
  }

  // 支払者不明 — payment 自身にも、その orderId が指す order にも
  // userId/providerId がないと「誰が払ったか」に辿り着けない
  // （返金・照会・監査で当事者を特定できない）。
  {
    for (const p of payments) {
      if (!p || p.userId !== undefined || p.providerId !== undefined) continue;
      const o = p.orderId !== undefined ? orderById.get(p.orderId) : undefined;
      if (!o || (o.userId === undefined && o.providerId === undefined && o.renterId === undefined)) {
        issues.push({ severity: 'warn', check: 'missing-payer', detail: `payments.json: id "${p.id}" は payment/order のどちらからも支払い当事者に辿り着けない` });
      }
    }
  }

  // 期限切れの未払い invoice — payment.invoiceExpiresAt は LN invoice の有効期限
  // （payment/index.js:287-298、既定1時間）。pending のまま期限超過したレコードは
  // 二度と paid にならない死に invoice — order も pending 停滞するのでキャンセル
  // または invoice 再発行の運用判断が必要。
  {
    const nowMs = Date.now();
    for (const p of payments) {
      if (p && p.status === 'pending' && p.invoiceExpiresAt) {
        const t = Date.parse(p.invoiceExpiresAt);
        if (Number.isFinite(t) && t < nowMs) {
          issues.push({ severity: 'warn', check: 'expired-invoice', detail: `payments.json: id "${p.id}" は pending のまま invoiceExpiresAt "${p.invoiceExpiresAt}" 超過（二度と支払われない死に invoice）` });
        }
      }
    }
  }

  // feeRate 範囲外 — create は [0,0.99] にクランプ（escrow-service.js:148）。
  // 範囲外の保存値は書き込み側検証を迂回した混入（fee>=1 は payout<=0 で
  // provider が無報酬になる、負値は運営損失）。
  for (const e of escrows) {
    if (e && e.feeRate !== undefined && !(typeof e.feeRate === 'number' && e.feeRate >= 0 && e.feeRate <= 0.99)) {
      issues.push({ severity: 'warn', check: 'invalid-fee-rate', detail: `escrows.json: id "${e.id}" の feeRate "${e.feeRate}" は [0,0.99] 範囲外（清算時の支払い計算が破綻する）` });
    }
  }

  // jobId 未設定の verification — open(jobId,...) は jobId を必須とし
  // （verification-service.js:36-37）、getByJobId のフィールドキーでもある。
  // jobId のないレコードは finalize/参照の全経路から見えない孤立検証証跡。
  for (const v of verifications) {
    if (v && !v.jobId) {
      issues.push({ severity: 'warn', check: 'missing-job-ref', detail: `verifications.json: id "${v.id}" に jobId がない（検証対象不明の孤立レコード）` });
    }
  }

  // 検証結論の未定義値 — verdict は pending/verified/failed/inconclusive
  // （verification-service.js）。それ以外は 「検証したのに判定不明」 の漂流値。
  {
    const KNOWN_VERDICTS = new Set(['pending', 'verified', 'failed', 'inconclusive']);
    for (const v of verifications) {
      if (v && v.verdict !== undefined && !KNOWN_VERDICTS.has(v.verdict)) {
        issues.push({ severity: 'warn', check: 'unknown-verdict', detail: `verifications.json: id "${v.id}" の verdict "${v.verdict}" は未定義` });
      }
    }
  }

  // 返金済み payment を持つ進行/完了 order — 返金で資金が借り手へ戻ったのに
  // order が matched/active/completed（= 支払いなしで仕事が進行）なら
  // order 側を cancelled へ倒すべきか、返金自体が誤操作の可能性。
  const refundedOrderIds = new Set(payments.filter((p) => p && p.status === 'refunded').map((p) => p.orderId));
  const paidOrderIds = new Set(payments.filter((p) => p && p.status === 'paid').map((p) => p.orderId));
  for (const o of orders) {
    if (o && ['matched', 'active', 'completed'].includes(o.status) && refundedOrderIds.has(o.id) && !paidOrderIds.has(o.id)) {
      issues.push({ severity: 'warn', check: 'refunded-active-order', detail: `orders.json: id "${o.id}" は ${o.status} だが返金済み payment があり paid がない（無支払い進行の疑い）` });
    }
  }

  // 進行/完了済み order に payment レコードが無い（課金経路を通らず稼働 = 無償提供の可能性）
  const ordersWithPayment = new Set(payments.map((p) => p && p.orderId).filter(Boolean));
  for (const o of orders) {
    if (o && (o.status === 'active' || o.status === 'completed') && !ordersWithPayment.has(o.id)) {
      issues.push({ severity: 'warn', check: 'missing-payment', detail: `orders.json: id "${o.id}" (${o.status}) に対応する payment レコードがない` });
    }
  }
  // matched 以降の order に 'paid' な payment が無い — missing-payment の厳密版:
  // invoice-poller は paid→matched のため matched/active/completed は全て支払い証跡が前提。
  // レコードはあっても paid 到達していない（failed/pending のみ or 全額 refunded）なら
  // 進行の根拠となる支払いが無い。
  const ordersWithPaid = new Set(payments.filter((p) => p && p.status === 'paid').map((p) => p.orderId));
  const PAID_REQUIRED_STATUSES = new Set(['matched', 'active', 'completed']);
  for (const o of orders) {
    if (o && PAID_REQUIRED_STATUSES.has(o.status) && ordersWithPayment.has(o.id) && !ordersWithPaid.has(o.id)) {
      issues.push({ severity: 'warn', check: 'unpaid-completed-order', detail: `orders.json: id "${o.id}" は ${o.status} だが paid な payment がない` });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return {
    issues,
    summary: {
      collections: { orders: orders.length, payments: payments.length, escrows: escrows.length, verifications: verifications.length, gpus: gpus.length, users: users.length },
      errors,
      warnings,
      ok: errors === 0,
    },
  };
}

function main() {
  // argv > STRAWBERRY_DATA_DIR > repo-root data/（resolveDataDir と同一の解決規約）
  // --json で機械可読出力（監視系からの消費用 — Slack 通知や外形監視から
  // issues 配列を直接差分処理できる）。フラグは可変位置で受け付ける。
  const { resolveDataDir } = require('../src/db/json/data-dir');
  const jsonMode = process.argv.includes('--json');
  const dataDir = process.argv.slice(2).find((a) => !a.startsWith('-')) || resolveDataDir();
  const { issues, summary } = run(dataDir);
  if (jsonMode) {
    console.log(JSON.stringify({ dataDir, ...summary, issues }, null, 2));
  } else {
    console.log(`[verify-data-consistency] ${dataDir}`);
    console.log(`  collections: orders=${summary.collections.orders} payments=${summary.collections.payments} escrows=${summary.collections.escrows} verifications=${summary.collections.verifications} gpus=${summary.collections.gpus} users=${summary.collections.users}`);
    for (const i of issues) {
      console.log(`  [${i.severity}] ${i.check}: ${i.detail}`);
    }
    console.log(`  result: ${summary.errors} error(s), ${summary.warnings} warning(s) — ${summary.ok ? 'OK' : 'INCONSISTENT'}`);
  }
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { run };
