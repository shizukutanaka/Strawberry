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
    }
  }

  const orderIds = new Set(orders.map((o) => o.id));
  const orderStatus = new Map(orders.map((o) => [o.id, o.status]));

  // orderId を持つ全レコードの参照先存在チェック
  for (const [name, rows] of [['payments.json', payments], ['escrows.json', escrows], ['verifications.json', verifications]]) {
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

  // 進行/完了済み order に payment レコードが無い（課金経路を通らず稼働 = 無償提供の可能性）
  const ordersWithPayment = new Set(payments.map((p) => p && p.orderId).filter(Boolean));
  for (const o of orders) {
    if (o && (o.status === 'active' || o.status === 'completed') && !ordersWithPayment.has(o.id)) {
      issues.push({ severity: 'warn', check: 'missing-payment', detail: `orders.json: id "${o.id}" (${o.status}) に対応する payment レコードがない` });
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
