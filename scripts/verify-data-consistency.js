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
const ESCROW_STATES = ['PENDING', 'HELD', 'SETTLED', 'DISPUTED'];

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
function run(dataDir) {
  const issues = [];
  const orders = loadCollection(dataDir, 'orders.json', issues);
  const payments = loadCollection(dataDir, 'payments.json', issues);
  const escrows = loadCollection(dataDir, 'escrows.json', issues);
  const verifications = loadCollection(dataDir, 'verifications.json', issues);

  checkDuplicateIds('orders.json', orders, issues);
  checkDuplicateIds('payments.json', payments, issues);
  checkDuplicateIds('escrows.json', escrows, issues);
  checkDuplicateIds('verifications.json', verifications, issues);

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

  // 状態の相互整合: order 終端 × escrow 未清算
  const escrowsByOrder = new Map();
  for (const e of escrows) {
    if (!e || e.orderId === undefined) continue;
    if (!escrowsByOrder.has(e.orderId)) escrowsByOrder.set(e.orderId, []);
    escrowsByOrder.get(e.orderId).push(e);
  }

  for (const e of escrows) {
    if (!e) continue;
    if (e.status && !ESCROW_STATES.includes(e.status)) {
      issues.push({ severity: 'warn', check: 'unknown-escrow-status', detail: `escrows.json: id "${e.id}" の status "${e.status}" は未定義` });
    }
    const oStatus = orderStatus.get(e.orderId);
    if (oStatus === undefined) continue; // dangling-ref は上で報告済み
    if ((oStatus === 'completed' || oStatus === 'cancelled') && (e.status === 'PENDING' || e.status === 'HELD')) {
      issues.push({
        severity: 'error',
        check: 'stuck-escrow',
        detail: `escrow "${e.id}" (${e.status}) が終端 order "${e.orderId}" (${oStatus}) に残存 — 資金ロックの可能性`,
      });
    }
    if (e.status === 'SETTLED' && oStatus !== 'completed') {
      issues.push({
        severity: 'error',
        check: 'premature-settlement',
        detail: `escrow "${e.id}" が SETTLED だが order "${e.orderId}" は ${oStatus}`,
      });
    }
    if (e.status === 'DISPUTED' && oStatus !== 'disputed') {
      issues.push({
        severity: 'warn',
        check: 'dispute-mismatch',
        detail: `escrow "${e.id}" が DISPUTED だが order "${e.orderId}" は ${oStatus}`,
      });
    }
  }

  // 同一 order に複数の未清算 escrow
  for (const [orderId, list] of escrowsByOrder) {
    const open = list.filter((e) => e.status === 'PENDING' || e.status === 'HELD');
    if (open.length > 1) {
      issues.push({
        severity: 'error',
        check: 'double-open-escrow',
        detail: `order "${orderId}" に未清算 escrow が ${open.length} 件 (${open.map((e) => e.id).join(', ')})`,
      });
    }
  }

  // order の未知ステータス
  for (const o of orders) {
    if (o && o.status && !ORDER_STATES.includes(o.status)) {
      issues.push({ severity: 'warn', check: 'unknown-order-status', detail: `orders.json: id "${o.id}" の status "${o.status}" は未定義` });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return {
    issues,
    summary: {
      collections: { orders: orders.length, payments: payments.length, escrows: escrows.length, verifications: verifications.length },
      errors,
      warnings,
      ok: errors === 0,
    },
  };
}

function main() {
  const dataDir = process.argv[2] || path.join(__dirname, '../data');
  const { issues, summary } = run(dataDir);
  console.log(`[verify-data-consistency] ${dataDir}`);
  console.log(`  collections: orders=${summary.collections.orders} payments=${summary.collections.payments} escrows=${summary.collections.escrows} verifications=${summary.collections.verifications}`);
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
