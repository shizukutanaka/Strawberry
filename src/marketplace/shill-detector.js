// src/marketplace/shill-detector.js
// 逆オークションにおける談合・シール（囮）入札の検出（docs/improvement-research-2026.md §17）。
// BidRepository に蓄積した入札履歴を横断分析し、プロバイダごとの疑念スコア
// （Shill Score 風）を算出する純関数群。インフラ非依存・決定論的・テスト可能。
//
// 前提: Strawberry のオークションは「逆オークション」（プロバイダが価格を下げて競い、
// 勝者は自身の入札額を受け取る first-price 型）。この構造では談合の利益は
// 「指定した勝者の落札価格を競争下より高く保つ」ことにある。共犯者は勝者の直ぐ上に
// カバー入札（complementary bidding）を置いて競争があったかのように装う。
// 検出シグナルは調達オークション談合検知と Shill Score の定式に従う:
//  - chronic_loser       … 繰り返し入札するがほぼ勝たない（シールの基本特徴）
//  - cover_bidder        … 敗北入札が勝者価格の直ぐ上に集中（見せかけの競争）
//  - dedicated_co_bidder … 特定勝者の勝利オークションに常時参加し、勝者が勝たない
//                          オークションはスキップする（選択的共演=受益者相関）。
//                          「全部のオークションに出て全部負ける高値提供者」と区別する。
//  - rotation_member     … 2者ペアが共演オークションの勝利を交互に分け合う（受注調整）
//  - propped_winner      … 自身の勝利が常に特定の常敗共演者に支えられている受益者
//                          （受益だけでは談合の証明にならないため単独では flag しない重み）
//
// 参考: Trevathan & Read の Shill Score / collusion score（交互入札・交互オークション
// 戦略、η/θ レーティング）、arXiv:1812.10868（複数売り手の共謀シール入札検出）、
// arXiv:2506.00282（検出→動的ペナルティ）、OECD/調達談合のカバー入札類型。
// スコア算出のみを担い、スラッシング・入札除外等の enforcement は呼び出し側の
// ポリシー（marketplace-service の opts）に委ねる。

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function num(v, def = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

const DEFAULT_WEIGHTS = {
  chronicLoser: 0.35,
  coverBidder: 0.35,
  dedicatedCoBidder: 0.3,
  rotationMember: 0.5,
  proppedWinner: 0.2,
};

const DEFAULTS = {
  minParticipations: 4, // これ未満では統計的に判定不能
  chronicLoserMaxWinRate: 0.15, // 常敗の上限勝率
  coverBidMaxMarginPct: 0.25, // 勝者価格の +25% 以内の敗北入札をカバーとみなす
  coverBidMinLosses: 3,
  coverBidMinRatio: 0.6, // 敗北のうちカバー入札の割合
  coBidMinCount: 3,
  coBidMinRatio: 0.7, // 勝者の勝利のうち共演者が参加した割合
  coBidMaxNonWinAttendance: 0.5, // 選択性: 勝者が勝たないオークションへの出席率の上限
  rotationMinSharedAuctions: 4,
  rotationMinDominance: 0.9, // 共演オークションの勝利がペア内に収まる割合
  rotationMinWinShare: 0.25, // ペア内勝利のうち弱者側の最低取り分
  flagScore: 0.5,
  weights: DEFAULT_WEIGHTS,
};

/**
 * 入札履歴をオークション単位に正規化して集計する内部表現を作る。
 * 各行: { auctionId, providerId, pricePerHour?, won?, eligible? }。
 * auctionId/providerId の無い行はスキップ。providerId は文字列に正規化。
 */
function normalizeHistory(history) {
  const byAuction = new Map(); // auctionId -> rows[]
  for (const row of history) {
    if (!row || row.auctionId === undefined || row.auctionId === null) continue;
    if (row.providerId === undefined || row.providerId === null) continue;
    const auctionId = String(row.auctionId);
    const r = {
      providerId: String(row.providerId),
      pricePerHour: Number.isFinite(row.pricePerHour) ? row.pricePerHour : null,
      won: row.won === true,
    };
    if (!byAuction.has(auctionId)) byAuction.set(auctionId, []);
    byAuction.get(auctionId).push(r);
  }
  return byAuction;
}

/**
 * 入札履歴から談合スコアを算出する。
 * @param {Array<object>} history BidRepository の行配列（新しい順である必要はない）
 * @param {object} opts 各閾値・重み・flagScore の上書き（DEFAULTS 参照）
 * @returns {{
 *   flagged: string[],
 *   suspicions: Array<{providerId:string, score:number, flagged:boolean,
 *     signals:Array<object>, stats:{participations:number,wins:number,winRate:number}}>,
 *   pairs: Array<{a:string,b:string,sharedAuctions:number,winsInside:number,winsA:number,winsB:number}>
 * }}
 */
function detectShills(history, opts = {}) {
  if (!Array.isArray(history)) throw new Error('history must be an array');
  const cfg = { ...DEFAULTS, ...opts, weights: { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) } };
  const byAuction = normalizeHistory(history);

  // オークションごとの勝者・勝者価格・参加者集合・参加者の最良（最低）価格を解決
  const auctions = new Map(); // auctionId -> { winnerId, winnerPrice, participants, bestPriceBy }
  for (const [auctionId, rows] of byAuction) {
    const winnerRow = rows.find((r) => r.won);
    const participants = new Set();
    const participantWon = new Set();
    const bestPriceBy = new Map();
    for (const r of rows) {
      participants.add(r.providerId);
      if (r.pricePerHour === null) continue;
      const cur = bestPriceBy.get(r.providerId);
      if (cur === undefined || r.pricePerHour < cur) bestPriceBy.set(r.providerId, r.pricePerHour);
    }
    auctions.set(auctionId, {
      winnerId: winnerRow ? winnerRow.providerId : null,
      winnerPrice: winnerRow ? winnerRow.pricePerHour : null,
      participants: [...participants],
      bestPriceBy,
    });
  }

  // プロバイダ別統計
  const stats = new Map(); // providerId -> mutable stats
  const st = (pid) => {
    if (!stats.has(pid)) {
      stats.set(pid, {
        participations: 0,
        wins: 0,
        coverLosses: 0,
        competitiveLosses: 0, // 勝者価格が確定している敗北（カバー判定の分母）
        coBidWithWinner: new Map(), // winnerId -> その勝者の勝利オークションに参加した回数
      });
    }
    return stats.get(pid);
  };

  const pairKey = (a, b) => (a < b ? `${a}${b}` : `${b}${a}`);
  const pairs = new Map(); // pairKey -> {a,b,sharedAuctions,winsInside,winsA,winsB}

  for (const [, a] of auctions) {
    const participants = a.participants;
    for (const pid of participants) {
      const s = st(pid);
      s.participations += 1;
      if (a.winnerId === pid) {
        s.wins += 1;
      } else if (a.winnerId !== null) {
        // 敗北かつ勝者価格が確定している場合のみカバー判定
        if (a.winnerPrice !== null && a.winnerPrice > 0) {
          s.competitiveLosses += 1;
          const p = a.bestPriceBy.get(pid);
          if (p > a.winnerPrice && p <= a.winnerPrice * (1 + cfg.coverBidMaxMarginPct)) {
            s.coverLosses += 1;
          }
        }
        const n = s.coBidWithWinner.get(a.winnerId) || 0;
        s.coBidWithWinner.set(a.winnerId, n + 1);
      }
    }
    // ペア集計（共演・ペア内勝利）
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const a1 = participants[i];
        const b1 = participants[j];
        const key = pairKey(a1, b1);
        if (!pairs.has(key)) pairs.set(key, { a: a1 < b1 ? a1 : b1, b: a1 < b1 ? b1 : a1, sharedAuctions: 0, winsInside: 0, winsA: 0, winsB: 0 });
        const p = pairs.get(key);
        p.sharedAuctions += 1;
        if (a.winnerId === a1 || a.winnerId === b1) {
          p.winsInside += 1;
          if (a.winnerId === p.a) p.winsA += 1;
          else p.winsB += 1;
        }
      }
    }
  }

  // 勝者別の総勝利数（co-bidder 比率の分母）
  const winsByProvider = new Map();
  for (const [pid, s] of stats) winsByProvider.set(pid, s.wins);

  // フラグ済みローテーションペア
  const flaggedPairs = [...pairs.values()]
    .filter((p) => p.sharedAuctions >= cfg.rotationMinSharedAuctions)
    .filter((p) => p.winsInside / p.sharedAuctions >= cfg.rotationMinDominance)
    .filter((p) => Math.min(p.winsA, p.winsB) / p.winsInside >= cfg.rotationMinWinShare)
    .sort((x, y) => y.sharedAuctions - x.sharedAuctions);
  const rotationMembers = new Set();
  for (const p of flaggedPairs) {
    rotationMembers.add(p.a);
    rotationMembers.add(p.b);
  }

  // プロバイダ別シグナル→スコア。参加数が minParticipations 未満では統計的に
  // 判定不能として全シグナルを抑止する（少データでの誤検知を防ぐ）。
  const suspicions = [];
  for (const [pid, s] of stats) {
    if (s.participations < cfg.minParticipations) continue;
    const signals = [];
    const winRate = s.participations > 0 ? s.wins / s.participations : 0;

    if (s.participations >= cfg.minParticipations && winRate <= cfg.chronicLoserMaxWinRate) {
      signals.push({
        type: 'chronic_loser',
        participations: s.participations,
        winRate: Math.round(winRate * 1000) / 1000,
      });
    }

    if (s.competitiveLosses >= cfg.coverBidMinLosses) {
      const coverRatio = s.coverLosses / s.competitiveLosses;
      if (coverRatio >= cfg.coverBidMinRatio) {
        signals.push({
          type: 'cover_bidder',
          coverLosses: s.coverLosses,
          competitiveLosses: s.competitiveLosses,
          coverRatio: Math.round(coverRatio * 1000) / 1000,
        });
      }
    }

    // 特定勝者への常時共演（その勝者の勝利の ≥ratio に参加し、自分は勝っていない）。
    // さらに選択性を要求: その勝者が勝っていないオークションへの出席率が低いこと。
    // 「高額で毎回負けるだけの正直な提供者」と受益者相関の共犯者を区別するため、
    // 勝者が全勝している（比較対象の非勝利オークションが無い）ときは発火しない。
    for (const [winnerId, count] of s.coBidWithWinner) {
      const winnerWins = winsByProvider.get(winnerId) || 0;
      const nonWinnerAuctions = auctions.size - winnerWins;
      const attendedNonWinner = s.participations - count;
      const nonWinAttendance = nonWinnerAuctions > 0 ? attendedNonWinner / nonWinnerAuctions : null;
      const selective = nonWinAttendance !== null && nonWinAttendance <= cfg.coBidMaxNonWinAttendance;
      if (winnerWins >= cfg.coBidMinCount && count / winnerWins >= cfg.coBidMinRatio && selective) {
        signals.push({
          type: 'dedicated_co_bidder',
          winnerId,
          attendedWinnerAuctions: count,
          winnerWins,
          ratio: Math.round((count / winnerWins) * 1000) / 1000,
          nonWinAttendance: Math.round(nonWinAttendance * 1000) / 1000,
        });
        break; // 1件あれば十分（最強のものを1つ）
      }
    }

    if (rotationMembers.has(pid)) {
      const pair = flaggedPairs.find((p) => p.a === pid || p.b === pid); // eslint-disable-line
      signals.push({
        type: 'rotation_member',
        partner: pair.a === pid ? pair.b : pair.a,
        sharedAuctions: pair.sharedAuctions,
        winsInside: pair.winsInside,
      });
    }

    const score = clamp01(
      signals.reduce(
        (acc, sig) =>
          acc +
          (sig.type === 'chronic_loser'
            ? cfg.weights.chronicLoser
            : sig.type === 'cover_bidder'
              ? cfg.weights.coverBidder
              : sig.type === 'dedicated_co_bidder'
                ? cfg.weights.dedicatedCoBidder
                : sig.type === 'rotation_member'
                  ? cfg.weights.rotationMember
                  : 0),
        0,
      ),
    );

    if (signals.length > 0) {
      suspicions.push({
        providerId: pid,
        score: Math.round(score * 1000) / 1000,
        flagged: score >= cfg.flagScore,
        signals,
        stats: {
          participations: s.participations,
          wins: s.wins,
          winRate: Math.round(winRate * 1000) / 1000,
        },
      });
    }
  }

  // propped_winner: flagged な共演者が自分の勝利の ≥coBidMinRatio に参加していた勝者
  const flaggedSet = new Set(suspicions.filter((x) => x.flagged).map((x) => x.providerId));
  for (const [pid, s] of stats) {
    if (s.wins < cfg.coBidMinCount) continue;
    // pid が勝者として、その勝利オークションへの flagged 共演者の出席率を見る
    let attended = 0;
    for (const [otherId, otherStats] of stats) {
      if (otherId === pid || !flaggedSet.has(otherId)) continue;
      attended += otherStats.coBidWithWinner.get(pid) || 0;
    }
    if (attended > 0 && attended / s.wins >= cfg.coBidMinRatio) {
      const existing = suspicions.find((x) => x.providerId === pid);
      const signal = {
        type: 'propped_winner',
        attendedWins: attended,
        wins: s.wins,
        ratio: Math.round((attended / s.wins) * 1000) / 1000,
      };
      if (existing) {
        existing.signals.push(signal);
        existing.score = Math.round(clamp01(existing.score + cfg.weights.proppedWinner) * 1000) / 1000;
        existing.flagged = existing.score >= cfg.flagScore;
      } else {
        suspicions.push({
          providerId: pid,
          score: cfg.weights.proppedWinner,
          flagged: false,
          signals: [signal],
          stats: {
            participations: s.participations,
            wins: s.wins,
            winRate: Math.round((s.wins / s.participations) * 1000) / 1000,
          },
        });
      }
    }
  }

  suspicions.sort((x, y) => y.score - x.score);
  return {
    flagged: suspicions.filter((x) => x.flagged).map((x) => x.providerId),
    suspicions,
    pairs: flaggedPairs,
  };
}

module.exports = { detectShills, DEFAULTS };
