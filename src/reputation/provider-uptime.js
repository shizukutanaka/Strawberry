// src/reputation/provider-uptime.js
// プロバイダー稼働実績の永続化と信頼性スコア算出。
//
// なぜ必要か: order ルートの heartbeatTimestamps / usageSessions はメモリ上の Map で、
// プロセス再起動で消える。そのため「このプロバイダーは過去どれだけ安定稼働してきたか」
// という履歴が一切残らず、Vast.ai 等が標準採用する客観的な信頼性スコアを算出できない。
// 本モジュールは lender（プロバイダー）ハートビートを uptime.json へ集計永続化し、
// レビュー（主観）と対になる「信頼性（客観）」の 2 シグナル目を供給する。
//
// 設計方針:
//  - ホットパス（heartbeat ハンドラ）から呼ばれるため、いかなる失敗も握り潰して
//    ハートビート処理自体は絶対に壊さない（fail-open）。稼働統計は best-effort。
//  - providerId をキーに 1 レコードを upsert。CAS ではなく順次読み書きだが、
//    JSON リポジトリは atomicWriteJSON（temp+rename）で書き込むためファイルは常に整合。
//  - 「切断イベント」= 同一オーダー内で前回プロバイダーハートビートから
//    GAP_THRESHOLD_MS を超えて次が届いたケース（＝一度落ちて復帰した兆候）。

const UptimeRepository = require('../db/json/UptimeRepository');
const { logger } = require('../core/logger');

// 前回ビートからこの時間を超えて次のビートが来たら「切断イベント」1回とみなす。
// heartbeat の最小間隔は既定 10s。その 6 倍（60s）を超える空白は、
// 単なる送信タイミングのブレではなく実際のダウン/復帰と判断する。
const GAP_THRESHOLD_MS = Math.max(30000, Number(process.env.UPTIME_GAP_THRESHOLD_MS) || 60000);

// スコアを表示してよい最小サンプル数（ビート数）。これ未満は「計測中」扱いとし、
// 数回のビートだけで満点/ゼロ点が確定する誤誘導を避ける（Vast.ai の「Verified は
// 稼働実績で獲得」と同じ発想）。
const MIN_BEATS_FOR_SCORE = Math.max(1, Number(process.env.UPTIME_MIN_BEATS) || 20);

// SLA 違反（レンタル中にプロバイダーのハートビートが途絶＝実質ダウン）1 件あたりの
// スコア減点。散発的な gap（一時的な送信ブレ）より重く扱う: 「箱が落ちた」は
// マーケットで最も重大な信頼性事故のため、数回で大きくスコアを毀損させる。
const BREACH_PENALTY = Math.min(1, Math.max(0, Number(process.env.UPTIME_BREACH_PENALTY) || 0.2));

// 直近のプロバイダーハートビート時刻（orderId 単位, ms）。切断イベント判定にのみ使う
// 揮発状態で、永続的な集計値は uptime.json 側に持つ。再起動で消えても、
// 消えた直後の 1 ビートが偽の gap を生まないよう「初回ビートは gap 判定しない」。
const lastProviderBeatByOrder = new Map();

// 再起動後や sessions 集計のため、既に集計済みのオーダーを記録（プロセス揮発）。
const countedOrders = new Set();

function _clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// プロバイダー（lender ロール）ハートビート 1 件を記録する。
// order ルートの heartbeat ハンドラから best-effort で呼ばれる。
function recordProviderHeartbeat(providerId, orderId, nowMs = Date.now()) {
  if (!providerId || !orderId) return;
  try {
    const prev = lastProviderBeatByOrder.get(orderId);
    let gapEvent = false;
    if (prev !== undefined && nowMs - prev > GAP_THRESHOLD_MS) {
      gapEvent = true;
    }
    lastProviderBeatByOrder.set(orderId, nowMs);

    const isNewSession = !countedOrders.has(orderId);
    if (isNewSession) countedOrders.add(orderId);

    const nowIso = new Date(nowMs).toISOString();
    const existing = UptimeRepository.getByProviderId(providerId);
    if (!existing) {
      UptimeRepository.create({
        providerId,
        beats: 1,
        gapEvents: gapEvent ? 1 : 0,
        sessions: 1,
        lastBeatAt: nowIso,
        updatedAt: nowIso,
      });
      return;
    }
    UptimeRepository.update(existing.id, {
      beats: (Number(existing.beats) || 0) + 1,
      gapEvents: (Number(existing.gapEvents) || 0) + (gapEvent ? 1 : 0),
      sessions: (Number(existing.sessions) || 0) + (isNewSession ? 1 : 0),
      lastBeatAt: nowIso,
      updatedAt: nowIso,
    });
  } catch (e) {
    // 稼働統計は best-effort。ハートビート本処理を巻き込まないよう握り潰す。
    logger.warn(`[provider-uptime] failed to record heartbeat for ${providerId}: ${e.message}`);
  }
}

// SLA 違反（レンタル中のプロバイダー・ハートビート途絶）を 1 件記録する。
// SLA スイープから best-effort で呼ばれる。既存レコードが無い場合でも作成する
// （初回稼働で即ダウンしたプロバイダーも記録に残すため）。
function recordSlaBreach(providerId, nowMs = Date.now()) {
  if (!providerId) return;
  try {
    const nowIso = new Date(nowMs).toISOString();
    const existing = UptimeRepository.getByProviderId(providerId);
    if (!existing) {
      UptimeRepository.create({
        providerId, beats: 0, gapEvents: 0, sessions: 0, breaches: 1,
        lastBeatAt: null, lastBreachAt: nowIso, updatedAt: nowIso,
      });
      return;
    }
    UptimeRepository.update(existing.id, {
      breaches: (Number(existing.breaches) || 0) + 1,
      lastBreachAt: nowIso,
      updatedAt: nowIso,
    });
  } catch (e) {
    logger.warn(`[provider-uptime] failed to record SLA breach for ${providerId}: ${e.message}`);
  }
}

// providerId の信頼性サマリを返す。UI・検索ランキング用。
// { score: number|null, tier: string, beats, gapEvents, sessions, breaches, measuring: boolean }
// score は 0..1（切断頻度・SLA 違反が少ないほど高い）。サンプル不足時は score=null / measuring=true。
function getReliability(providerId) {
  const empty = { score: null, tier: 'unrated', beats: 0, gapEvents: 0, sessions: 0, breaches: 0, measuring: false };
  if (!providerId) return empty;
  let rec = null;
  try {
    rec = UptimeRepository.getByProviderId(providerId);
  } catch (e) {
    logger.warn(`[provider-uptime] failed to read uptime for ${providerId}: ${e.message}`);
    return empty;
  }
  if (!rec) return empty;

  const beats = Number(rec.beats) || 0;
  const gapEvents = Number(rec.gapEvents) || 0;
  const sessions = Number(rec.sessions) || 0;
  const breaches = Number(rec.breaches) || 0;

  // サンプル不足でも SLA 違反があれば「計測中」で隠さずスコアを出す:
  // ダウン実績を「まだ実績なし」の陰に隠すのは不誠実で、借り手保護にも反する。
  if (beats < MIN_BEATS_FOR_SCORE && breaches === 0) {
    return { score: null, tier: 'measuring', beats, gapEvents, sessions, breaches, measuring: true };
  }

  // 切断率 = gapEvents / beats（低いほど安定）。SLA 違反は 1 件ごとに重く減点。
  // スコア = 1 - 切断率 - 違反ペナルティ。
  const disruptionRate = beats > 0 ? _clamp01(gapEvents / beats) : 0;
  const breachPenalty = _clamp01(breaches * BREACH_PENALTY);
  const score = Math.round(_clamp01(1 - disruptionRate - breachPenalty) * 100) / 100;
  const tier =
    score >= 0.95 ? 'excellent' :
    score >= 0.85 ? 'good' :
    score >= 0.6 ? 'fair' : 'poor';

  return { score, tier, beats, gapEvents, sessions, breaches, measuring: false };
}

// テスト用: 揮発状態のリセット。
function _resetVolatileState() {
  lastProviderBeatByOrder.clear();
  countedOrders.clear();
}

module.exports = {
  recordProviderHeartbeat,
  recordSlaBreach,
  getReliability,
  GAP_THRESHOLD_MS,
  MIN_BEATS_FOR_SCORE,
  _resetVolatileState,
};
