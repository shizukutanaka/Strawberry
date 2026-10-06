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
    }
  }

  const orderIds = new Set(orders.map((o) => o.id));
  const orderStatus = new Map(orders.map((o) => [o.id, o.status]));

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
      issues.push({ severity: 'warn', check: 'verdict-escrow-mismatch', detail: `verifications.json: id "${v.id}" は verified 判定なのに escrow "${v.escrowId}" が CANCELED（成功作業の未払い?）` });
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
      if (o && BLOCKING.has(o.status) && o.gpuId) {
        const g = gpuById.get(o.gpuId);
        if (g && g.available === false) {
          issues.push({ severity: 'warn', check: 'unavailable-gpu-order', detail: `orders.json: id "${o.id}" (${o.status}) は available=false の gpu "${o.gpuId}" を参照（予約中の利用不可出品）` });
        }
      }
    }
  }

  // 予約/価格フィールドの健全性（作成ルートの検証と同一規約）:
  //   order.durationMinutes … 正の整数かつ5の倍数（order/index.js:881）
  //   gpu.pricePerHour      … 正の数（order/index.js:952）
  for (const o of orders) {
    if (o && 'durationMinutes' in o && !(Number.isInteger(o.durationMinutes) && o.durationMinutes > 0 && o.durationMinutes % 5 === 0)) {
      issues.push({ severity: 'warn', check: 'invalid-duration', detail: `orders.json: id "${o.id}" の durationMinutes "${o.durationMinutes}" は正の5の倍数整数ではない` });
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
    for (const key of ['renterReview', 'providerReview']) {
      const r = o[key];
      if (r && !(Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5)) {
        issues.push({ severity: 'warn', check: 'invalid-rating', detail: `orders.json: id "${o.id}" の ${key}.rating "${r.rating}" は整数1-5ではない（集計対象外の幽霊レビュー）` });
      }
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
    const orderById = new Map(orders.map((o) => [o && o.id, o]));
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
  const { resolveDataDir } = require('../src/db/json/data-dir');
  const dataDir = process.argv[2] || resolveDataDir();
  const { issues, summary } = run(dataDir);
  console.log(`[verify-data-consistency] ${dataDir}`);
  console.log(`  collections: orders=${summary.collections.orders} payments=${summary.collections.payments} escrows=${summary.collections.escrows} verifications=${summary.collections.verifications} gpus=${summary.collections.gpus} users=${summary.collections.users}`);
  for (const i of issues) {
    console.log(`  [${i.severity}] ${i.check}: ${i.detail}`);
  }
  console.log(`  result: ${summary.errors} error(s), ${summary.warnings} warning(s) — ${summary.ok ? 'OK' : 'INCONSISTENT'}`);
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { run };
