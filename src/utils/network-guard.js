// src/utils/network-guard.js - Bitcoin ネットワークの構造的ガード
//
// 配布方針（2026-11-13 決定）: Strawberry は testnet／モックのまま配布し、
// Bitcoin mainnet は有効化しない。この決定を「ドキュメント上の約束」ではなく
// コードの構造で守るための単一の検査点。
//
// 背景: 従来は BITCOIN_NETWORK 環境変数（および config.json の
// lightning.network）が無検証で各所へ素通しされており、設定だけで
// mainnet の実 LND（admin.macaroon = 全権限の資格情報）や本番決済
// プロバイダへ結線できる状態だった。ネットワーク指定を受ける全経路は
// 必ずこのモジュールを経由し、mainnet は値の解決時点で例外にする。
// mainnet を使うにはこのガード自体の撤去というコード変更が必要になる
// （= 設定だけでは有効化できない、が本ガードの保証範囲）。
//
// testnet / regtest / simnet の動作は一切変えない（従来どおり素通し）。

const DEFAULT_NETWORK = 'testnet';
const BLOCKED_NETWORK = 'mainnet';

function _normalize(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
}

function _blockedError(network, source) {
  return new Error(
    `Bitcoin mainnet is disabled by policy (2026-11-13 decision: testnet/mock only). ` +
    `Refusing network "${network}"${source ? ` from ${source}` : ''}. ` +
    `Remove the mainnet setting or use testnet/regtest/simnet.`
  );
}

/**
 * 解決済みのネットワーク値を検査する。mainnet なら例外。
 * @param {string} network 検査対象（例: 'testnet'）
 * @param {string} [source] 値の出所（エラーメッセージ用。例: 'BITCOIN_NETWORK'）
 * @returns {string} 正規化されたネットワーク値
 */
function assertBitcoinNetworkAllowed(network, source) {
  const normalized = _normalize(network);
  if (normalized === BLOCKED_NETWORK) {
    throw _blockedError(network, source);
  }
  return normalized;
}

/**
 * 未指定を既定（testnet）に解決しつつ mainnet を拒否する。
 * env や設定ファイルなど「値が来る経路」の入口で使う。
 * @param {string|undefined|null} raw 生の指定値
 * @param {string} [source] 値の出所（エラーメッセージ用）
 * @returns {string} 解決されたネットワーク値
 */
function resolveBitcoinNetwork(raw, source) {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_NETWORK;
  }
  return assertBitcoinNetworkAllowed(raw, source);
}

module.exports = {
  DEFAULT_NETWORK,
  BLOCKED_NETWORK,
  assertBitcoinNetworkAllowed,
  resolveBitcoinNetwork,
};
