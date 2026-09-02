// src/api/routes/gpu/index.js - GPU関連APIルート
const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../../../utils/error-handler');
const { validateMiddleware, schemas, Joi } = require('../../../utils/validator');
const { logger } = require('../../../utils/logger');
const { authenticateJWT, checkRole, allowOwnerOrAdmin } = require('../../middleware/security');

// コアサービスは共有のガード付きシングルトンから取得（未導入時は null）
const { gpuDetector, vgpuManager, requireService } = require('../../../core/services');
// ファイルベースJSONストレージリポジトリ
const GpuRepository = require('../../../db/json/GpuRepository');
// GPU アテステーション（申告スペック vs デバイス計測の照合）
const { createMockAttestationVerifier } = require('../../../security/gpu-attestation-verifier');
// 開発/テスト時は Mock、本番では実 nvtrust アダプタへ置き換え可能（DI）
const _attestationVerifier = createMockAttestationVerifier();
// プロバイダ・レピュテーション記録（アテステーション結果の反映）
const { createReputationService } = require('../../../reputation/reputation-service');
// プロバイダー稼働実績（客観的な信頼性スコア）
const providerUptime = require('../../../reputation/provider-uptime');
// 機種横断で比較可能な正規化性能スコア（DLPerf 風）と価格対性能
const perfScore = require('../../../gpu/perf-score');
// Spot（中断許容）ティアのポリシーと中断率
const spotTier = require('../../../marketplace/spot-tier');
// 申告所在地に基づく系統カーボン強度と排出量推定（研究ドキュメント §15）
const carbonIntensity = require('../../../gpu/carbon-intensity');
// 出品時に申告されなかった項目を機種から導出する（必須項目を 5 つに絞るため）
const { applyListingDefaults } = require('../../../gpu/listing-defaults');
// 価格×レピュテーション×稼働×アテステーションの統合スコア（sort=recommended）
const { runAuction } = require('../../../marketplace/auction-engine');
const { sanitizeObject } = require('../../../utils/sanitize');
const { providerSummary } = require('../../../reputation/trust-summary');
const { withLock } = require('../../../utils/async-lock');
const { appendAuditLog } = require('../../../utils/audit-log');
// 価格ウォッチ（値下げアラート）
const WatchRepository = require('../../../db/json/WatchRepository');
const { notifyPriceWatchers, notifyWatchJustCreated } = require('../../../services/price-watch');

// Short-lived cache for per-GPU rating aggregation (O(n) order scan).
// TTL: 3 minutes — stale long enough to cut DoS load, fresh enough for display.
// Invalidated when a review is submitted (see order routes).
const _gpuRatingCache = new Map();
const GPU_RATING_TTL = process.env.NODE_ENV === 'test' ? 0 : 3 * 60 * 1000;

function getGpuRating(gpuId) {
  const cached = _gpuRatingCache.get(gpuId);
  if (cached && Date.now() - cached.cachedAt < GPU_RATING_TTL) return cached;
  const OrderRepository = require('../../../db/json/OrderRepository');
  const orders = OrderRepository.getAll().filter(o => o.gpuId === gpuId && o.review);
  const count = orders.length;
  const avg = count > 0
    ? Math.round((orders.reduce((s, o) => s + o.review.rating, 0) / count) * 10) / 10
    : null;
  const entry = { avg, count, cachedAt: Date.now() };
  _gpuRatingCache.set(gpuId, entry);
  return entry;
}

function invalidateGpuRatingCache(gpuId) {
  _gpuRatingCache.delete(gpuId);
}

/**
 * 出品の spot（中断許容）ティア情報。提供していなければ enabled:false だけを返す。
 * 割引後の実効時給まで返すのは、借り手が「中断リスクを負う見返り」を一目で比較できるように
 * するため（Vast.ai が interruptible の入札価格を並記するのと同じ意図）。
 */
function spotSummary(gpu) {
  const cfg = spotTier.resolveSpotConfig(gpu);
  if (!cfg.enabled) return { enabled: false };
  let pricePerHour = null;
  try {
    pricePerHour = spotTier.effectivePrice(gpu.pricePerHour, spotTier.TIERS.SPOT, gpu).pricePerHour;
  } catch (_) { /* pricePerHour 不正な出品は価格を出さない */ }
  return {
    enabled: true,
    discountPct: cfg.discountPct,
    noticeSeconds: cfg.noticeSeconds,
    pricePerHour,
  };
}

/**
 * プロバイダの中断率（注文履歴から導出）。中断は SLA 違反として減点しない代わりに、
 * 借り手が選べるよう必ず開示する。「安いが中断される」ことと「約束を破る」ことは別で、
 * 前者を隠すと spot ティアは信頼できない商品になる。
 */
function providerPreemptionRate(providerId) {
  if (!providerId) return { rate: null, preempted: 0, spotOrders: 0, measuring: false };
  const OrderRepository = require('../../../db/json/OrderRepository');
  return spotTier.preemptionRate(OrderRepository.getAll().filter((o) => o.providerId === providerId));
}

module.exports._invalidateGpuRatingCache = invalidateGpuRatingCache;

// 利用可能なGPU一覧を取得
router.get('/', asyncHandler(async (req, res) => {
  logger.info('Fetching available GPUs');
  // クエリパラメータからフィルタリング条件を取得
  let parsedFeatures = null;
  if (req.query.features) {
    // HPP（HTTP Parameter Pollution）対策: 同一パラメータが複数回送られると Express は
    // 配列にする（例: ?features=A&features=B → req.query.features = ['A','B']）。
    // 配列に対する .length は要素数であり文字数でないため、512 バイト上限チェックを
    // すり抜けてしまう。文字列型以外は早期拒否する。
    if (typeof req.query.features !== 'string') {
      return res.status(400).json({ error: '"features" query param must be provided once' });
    }
    // サイズ制限: 未認証呼び出し元が巨大な JSON を送り O(keys × GPUs) の CPU DoS を起こせる。
    // 512 バイト超 or 20 キー超は拒否する。
    if (req.query.features.length > 512) {
      return res.status(400).json({ error: '"features" query param exceeds 512 character limit' });
    }
    try {
      parsedFeatures = JSON.parse(req.query.features);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid "features" query: must be valid JSON' });
    }
    if (parsedFeatures !== null && typeof parsedFeatures === 'object' && !Array.isArray(parsedFeatures)) {
      if (Object.keys(parsedFeatures).length > 20) {
        return res.status(400).json({ error: '"features" may not contain more than 20 keys' });
      }
    } else if (parsedFeatures !== null) {
      return res.status(400).json({ error: '"features" must be a JSON object' });
    }
  }
  // minMemoryGB: 整数 0–8192 GB。負値はフィルタが `> 0` チェックで無視され、
  // 全 GPU を返してしまうバイパスになる。上限も GPU の最大 VRAM を超える値は無意味。
  let _minMemGB = 0;
  if (req.query.minMemoryGB !== undefined) {
    _minMemGB = parseInt(req.query.minMemoryGB, 10);
    if (!Number.isInteger(_minMemGB) || isNaN(_minMemGB) || _minMemGB < 0 || _minMemGB > 8192) {
      return res.status(400).json({ error: 'minMemoryGB must be an integer between 0 and 8192' });
    }
  }
  // maxPrice: 正の有限数のみ許可。0 や負値は意味がない（全 GPU が除外される）。
  let _maxPrice = null;
  if (req.query.maxPrice !== undefined) {
    _maxPrice = parseFloat(req.query.maxPrice);
    if (!Number.isFinite(_maxPrice) || _maxPrice <= 0) {
      return res.status(400).json({ error: 'maxPrice must be a positive number' });
    }
  }
  const filters = {
    minMemoryGB: _minMemGB,
    vendor: req.query.vendor ? String(req.query.vendor).slice(0, 64) : null,
    maxPrice: _maxPrice,
    features: parsedFeatures,
    country: req.query.country ? String(req.query.country).slice(0, 4).toUpperCase() : null,
    apiType: req.query.apiType ? String(req.query.apiType).slice(0, 16) : null,
    search: req.query.search ? String(req.query.search).slice(0, 128).toLowerCase() : null,
  };
  // ファイル永続化されたGPUリストを取得
  let gpus = GpuRepository.getAll();
  // フィルタリング
  if (filters.minMemoryGB > 0) {
    gpus = gpus.filter(gpu => gpu.memoryGB >= filters.minMemoryGB);
  }
  if (filters.vendor) {
    gpus = gpus.filter(gpu => gpu.vendor.toLowerCase().includes(filters.vendor.toLowerCase()));
  }
  if (filters.maxPrice) {
    gpus = gpus.filter(gpu => gpu.pricePerHour <= filters.maxPrice);
  }
  if (filters.features) {
    gpus = gpus.filter(gpu => {
      if (!gpu.features) return false;
      // 要求された機能がすべて含まれているか確認
      for (const [feature, required] of Object.entries(filters.features)) {
        if (required && !gpu.features[feature]) {
          return false;
        }
      }
      return true;
    });
  }
  if (filters.country) {
    gpus = gpus.filter(gpu => gpu.location && gpu.location.country &&
      gpu.location.country.toUpperCase() === filters.country);
  }
  if (filters.apiType) {
    const api = filters.apiType.toUpperCase();
    gpus = gpus.filter(gpu => gpu.apiType && gpu.apiType.toUpperCase() === api);
  }
  if (filters.search) {
    const q = filters.search;
    gpus = gpus.filter(gpu =>
      (gpu.name && gpu.name.toLowerCase().includes(q)) ||
      (gpu.model && gpu.model.toLowerCase().includes(q)) ||
      (gpu.vendor && gpu.vendor.toLowerCase().includes(q))
    );
  }
  // 占有状況の注釈: 現時刻と時間帯が重複する BLOCKING 注文がある GPU は available=false。
  // 二重予約は注文作成時に 409 で拒否されるため、ここは閲覧時のヒント表示。
  // Single getAll() — derive both occupancy and ratings from one read to halve disk I/O.
  const OrderRepository = require('../../../db/json/OrderRepository');
  const BLOCKING = new Set(['pending', 'matched', 'active', 'preempting']);
  const nowMs = Date.now();
  const allOrders = OrderRepository.getAll();
  const occupiedGpuIds = new Set(
    allOrders.filter(o => {
      if (!BLOCKING.has(o.status)) return false;
      const slotStart = new Date(o.scheduledStartAt || o.createdAt).getTime();
      const slotEnd = slotStart + (o.durationMinutes || 0) * 60 * 1000;
      return slotStart <= nowMs && slotEnd > nowMs;
    }).map(o => o.gpuId)
  );
  // available: プロバイダが手動で false に設定している場合はそれを優先し、
  // そうでなければ現在時刻に重複注文がない場合は true とする。
  gpus = gpus.map(gpu => {
    if (gpu.available === false) return { ...gpu, available: false };
    return { ...gpu, available: !occupiedGpuIds.has(gpu.id) };
  });
  // ?available=true で空き GPU のみに絞り込み
  if (req.query.available === 'true') {
    gpus = gpus.filter(gpu => gpu.available);
  }
  // ?minRating=N (1–5) で平均評価が N 以上の GPU のみに絞り込み（レビューなし GPU は除外）
  // レーティングは sort=rating でも使うので先に計算しておく
  const reviewMap = new Map(); // gpuId → { sum, count }
  for (const o of allOrders) {
    if (o.review && o.gpuId) {
      const raw = Number(o.review.rating);
      if (!Number.isFinite(raw)) continue;
      const clamped = Math.min(5, Math.max(1, raw));
      const cur = reviewMap.get(o.gpuId) || { sum: 0, count: 0 };
      cur.sum += clamped;
      cur.count++;
      reviewMap.set(o.gpuId, cur);
    }
  }
  // minRating: 1–5 の範囲で検証。負値を渡すと `> 0` のガードをすり抜けてフィルタが
  // スキップされ全 GPU が返ってしまう（minMemoryGB の旧バグと同じパターン）。
  // 範囲外は明示的に 400 を返して曖昧な結果を防ぐ。
  if (req.query.minRating !== undefined) {
    const _minRating = parseFloat(req.query.minRating);
    if (!Number.isFinite(_minRating) || _minRating < 1 || _minRating > 5) {
      return res.status(400).json({ error: 'minRating must be a number between 1 and 5' });
    }
    gpus = gpus.filter(gpu => {
      const r = reviewMap.get(gpu.id);
      if (!r || r.count === 0) return false;
      return (r.sum / r.count) >= _minRating;
    });
  }
  // ソート: ?sort=price(default)|rating(高→低)|memory(高→低)|reliability(高→低)
  //          |perf(性能スコア高→低)|value(価格対性能 高→低)|carbon(カーボン強度 低→高)|availability(空き優先)
  //          |recommended(価格×レピュテーション×稼働×アテステーションの総合)
  // ?sortDir=asc(default)|desc で方向を逆転（price/memory のみ有効; その他は常に高→低）
  const sort = req.query.sort || 'price';
  const sortDir = req.query.sortDir === 'desc' ? -1 : 1;
  // sort=recommended のときだけ埋まる（出品 id → 総合スコア）。
  // 順位だけ返して根拠を返さないと「なぜこの順番なのか」が利用者に分からないため、
  // レスポンスにスコアも載せる。
  let _recommendScores = null;
  // 性能スコアは純関数だが型番の正規表現照合を伴うため、ソートとレスポンス整形で
  // 二重計算しないよう GPU ごとにメモ化する。
  const _perfCache = new Map();
  const perfFor = (gpu) => {
    if (!_perfCache.has(gpu.id)) _perfCache.set(gpu.id, perfScore.summarize(gpu));
    return _perfCache.get(gpu.id);
  };
  const _carbonCache = new Map();
  const carbonFor = (gpu) => {
    if (!_carbonCache.has(gpu.id)) _carbonCache.set(gpu.id, carbonIntensity.summarize(gpu));
    return _carbonCache.get(gpu.id);
  };
  // 信頼性は providerId 単位でファイル読み取りを伴うため、リクエスト内でメモ化する
  // （ソート比較で同一 provider を何度も引くのと、レスポンス整形での再取得を防ぐ）。
  const _relCache = new Map();
  const relFor = (pid) => {
    if (!pid) return { score: null, tier: 'unrated', sessions: 0, beats: 0, gapEvents: 0, measuring: false };
    if (!_relCache.has(pid)) _relCache.set(pid, providerUptime.getReliability(pid));
    return _relCache.get(pid);
  };
  if (sort === 'rating') {
    gpus.sort((a, b) => {
      const ra = reviewMap.get(a.id);
      const rb = reviewMap.get(b.id);
      const avgA = ra && ra.count > 0 ? ra.sum / ra.count : 0;
      const avgB = rb && rb.count > 0 ? rb.sum / rb.count : 0;
      return avgB - avgA; // 常に高評価順（降順）
    });
  } else if (sort === 'memory') {
    gpus.sort((a, b) => sortDir * (b.memoryGB - a.memoryGB));
  } else if (sort === 'reliability') {
    // 信頼性スコアの高い順（未計測=null は 0 扱いで末尾に寄せる）。常に降順。
    gpus.sort((a, b) => {
      const sa = relFor(a.providerId).score || 0;
      const sb = relFor(b.providerId).score || 0;
      return sb - sa;
    });
  } else if (sort === 'perf') {
    // 正規化性能スコアの高い順。算出不能（未知型番・根拠不足）は 0 扱いで末尾へ。常に降順。
    gpus.sort((a, b) => (perfFor(b).score || 0) - (perfFor(a).score || 0));
  } else if (sort === 'value') {
    // 価格対性能（DLPerf/$ 相当）の高い順。算出不能は末尾へ。常に降順。
    gpus.sort((a, b) => (perfFor(b).perfPerHourSat || 0) - (perfFor(a).perfPerHourSat || 0));
  } else if (sort === 'carbon') {
    // 系統カーボン強度の低い順。強度不明（未知の地域／所在地未申告）は末尾へ回す
    // ——「不明」を 0 扱いして最上位に出すと、申告を省いた出品が最もグリーンに見えてしまう。
    gpus.sort((a, b) => {
      const ca = carbonFor(a).gCO2PerKWh;
      const cb = carbonFor(b).gCO2PerKWh;
      if (ca == null && cb == null) return 0;
      if (ca == null) return 1;
      if (cb == null) return -1;
      return ca - cb;
    });
  } else if (sort === 'recommended') {
    // 価格・レピュテーション・稼働実績・アテステーションを 1 本の効用スコアに
    // まとめた総合順位（src/marketplace/auction-engine.js の scoreBid）。
    //
    // このスコア計算はもともと「逆オークション」用に書かれたが、この製品には
    // 入札という概念そのものが存在しない（GPU は固定価格で出品され、入札を
    // 保存する場所も、貸し手が要件を見る画面も無い）。唯一の呼び出し口だった
    // POST /marketplace/auction は**入札内容を呼び出し側が捏造できた**ため削除し、
    // 計算だけを「サーバが持っている実データで実在の出品を並べる」用途に移した。
    // 借り手が本当に欲しいのは「安いが不安定」と「高いが堅い」を一目で比べる
    // 手段であり、単軸ソートの寄せ集めではそれができない。
    // レピュテーション（stake 加重の実績スコア）と稼働信頼性（ハートビート由来の
    // 稼働率）は**別のサービスで別のものを測っている**。前者を reputation 軸、
    // 後者を SLA 軸に入れる。片方で両方を代用すると、実績のあるプロバイダと
    // 単に無事故なだけの新規を区別できない。
    const { createReputationService } = require('../../../reputation/reputation-service');
    const reputationSvc = createReputationService();
    const _repCache = new Map();
    const repFor = (pid) => {
      if (!pid) return 0;
      if (!_repCache.has(pid)) {
        const r = reputationSvc.getScore(pid);
        _repCache.set(pid, (r && typeof r.score === 'number') ? r.score : 0);
      }
      return _repCache.get(pid);
    };
    const bids = gpus.map((g) => {
      const rel = relFor(g.providerId);
      return {
        providerId: g.id, // ここでの識別子は出品単位（同一プロバイダが複数出品しうる）
        pricePerHour: g.pricePerHour,
        reputationScore: repFor(g.providerId),
        // 稼働率は未計測なら null。scoreBid の既定 100 に落ちるが、それは
        // 「まだ違反が観測されていない」の意味で妥当（違反があれば score が出る）。
        slaUptimePct: typeof rel.score === 'number' ? rel.score * 100 : undefined,
        attestationScore: (g.attestation && g.attestation.score) || 0,
        attestationPassed: !!(g.attestation && g.attestation.passed),
      };
    });
    const { ranked } = runAuction(bids, {});
    const rank = new Map(ranked.map((r, i) => [r.providerId, i]));
    const scoreOf = new Map(ranked.map((r) => [r.providerId, r.score]));
    // ranked に載らない出品（価格が非正など不適格）は末尾へ。
    gpus.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
    _recommendScores = scoreOf;
  } else if (sort === 'availability') {
    // 空き GPU を先に表示
    gpus.sort((a, b) => {
      if (a.available === b.available) return a.pricePerHour - b.pricePerHour;
      return a.available ? -1 : 1;
    });
  } else {
    // price (default)
    gpus.sort((a, b) => sortDir * (a.pricePerHour - b.pricePerHour));
  }
  // ページネーション（limit: 1..200 既定50 / offset: 0..100000）
  // offset を上限化する理由: 未認証エンドポイントで offset=999999999 を指定されると
  // gpus 配列全体をロードした後 O(n) slice が走りイベントループをブロックする DoS になる。
  const totalCount = gpus.length;
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;
  const pagedGpus = gpus.slice(offset, offset + limit);

  // 全 GPU の状況サマリ（ページング前の全体集計）
  const allGpus = GpuRepository.getAll();
  const totalRegistered = allGpus.length;
  const totalAvailable = allGpus.filter(g => g.available !== false && !occupiedGpuIds.has(g.id)).length;
  const totalOccupied = allGpus.filter(g => occupiedGpuIds.has(g.id)).length;

  // レスポンスに追加情報を含める（reviewMap を使ってページ内 GPU に rating を付与）
  const response = {
    message: 'Fetched available GPUs',
    total: totalCount,
    limit,
    offset,
    summary: { totalRegistered, totalAvailable, totalOccupied },
    gpus: pagedGpus.map(({ apiKey, providerId: _pid, ...gpu }) => {
      const r = reviewMap.get(gpu.id);
      const rel = relFor(_pid);
      // perfFor はページング前の全 GPU ではなくページ内のみ計算される（sort=perf/value 時は
      // ソートで既に全件分がメモ化済み）。gpu は分割代入後で id を保持しているので流用できる。
      const perf = perfFor(gpu);
      return {
        ...gpu,
        rating: r && r.count > 0
          ? { average: Math.round((r.sum / r.count) * 10) / 10, count: r.count }
          : { average: null, count: 0 },
        // 客観的な信頼性シグナル（プロバイダー身元は露出しない — 集計値のみ）
        reliability: { score: rel.score, tier: rel.tier, sessions: rel.sessions },
        // 機種横断で比較可能な正規化性能スコアと価格対性能（一覧は findings/basis を省く）
        performanceScore: {
          score: perf.score, confidence: perf.confidence,
          matchedModel: perf.matchedModel, perfPerHourSat: perf.perfPerHourSat,
        },
        // Spot（中断許容）ティアの提供状況と実効価格
        spot: spotSummary(gpu),
        // 申告所在地に基づく推定カーボン強度（検証済みの環境価値ではない）
        carbon: carbonFor(gpu),
        // sort=recommended のときだけ付く総合スコア（0..1）。順位の根拠を示す。
        ...(_recommendScores ? { recommendScore: _recommendScores.get(gpu.id) ?? null } : {}),
      };
    }),
    timestamp: new Date().toISOString()
  };
  res.json(response);
}));

// プロバイダ自身のGPU一覧（認証必須 — ページネーションと available フラグを含む）
// GET /gpus/my
router.get('/my', authenticateJWT, asyncHandler(async (req, res) => {
  const providerId = req.user.id;
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.min(offsetRaw, 100000) : 0;

  let gpus = GpuRepository.getAll().filter(g => g.providerId === providerId);
  const total = gpus.length;
  // apiKey はプロバイダ自身のレスポンスにも含めない（他タブ・XSS・ログ経由での漏洩防止）
  const page = gpus.slice(offset, offset + limit).map(({ apiKey, ...g }) => g);
  res.json({ total, limit, offset, gpus: page });
}));

// 特定のGPUの詳細情報を取得（レーティング集計を含む）
router.get('/:id', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  logger.info(`Fetching GPU detail: ${gpuId}`);
  // ファイル永続化GPUリポジトリから取得
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) {
    return res.status(404).json({ error: 'GPU not found' });
  }
  // 詳細情報取得（vgpuManager 未導入時は null）。
  // details/usageStats はオーナー/管理者にのみ返す — 借り手の稼働パターン de-anonymize を防ぐ。
  // /gpus/* は GET 公開のため req.user が無いケース（未認証マーケット閲覧）で必ず安全側に倒す。
  const viewerIsOwnerOrAdmin = req.user && (req.user.role === 'admin' || gpu.providerId === req.user.id);
  const details = (vgpuManager && viewerIsOwnerOrAdmin) ? await vgpuManager.getGPUDetails(gpuId).catch(() => null) : null;
  const usageStats = (vgpuManager && viewerIsOwnerOrAdmin) ? await vgpuManager.getGPUUsageStats(gpuId).catch(() => null) : null;
  const availability = vgpuManager ? await vgpuManager.getGPUAvailability(gpuId).catch(() => null) : null;
  // レーティング集計（TTL キャッシュ付き — 生 O(n) スキャンの繰り返し呼び出しを防ぐ）
  const { avg: ratingAverage, count: ratingCount } = getGpuRating(gpuId);
  // レスポンスを構築。
  // providerId: 公開エンドポイントで返すとプロバイダ身元列挙に使われる（リスト側と同じ扱い）。
  //   オーナー/管理者には返す（本人は自分の ID を知る必要がある）。
  // apiKey: 常に除外。
  // 出品者の信頼度。借り手が「この人から借りて大丈夫か」を判断する材料で、
  // providerId を出さずに出す（ID を出すと出品者列挙に使われる）。
  const { providerId: _rp, ...providerReputation } = providerSummary(gpu.providerId) || {};
  const { apiKey, providerId, ...gpuSafe } = gpu;
  const rel = providerUptime.getReliability(providerId);
  const response = {
    message: 'Fetched GPU detail',
    gpu: {
      ...gpuSafe,
      ...(viewerIsOwnerOrAdmin ? { providerId } : {}),
      providerReputation: Object.keys(providerReputation).length ? providerReputation : null,
      details, usageStats, availability,
      rating: { average: ratingAverage, count: ratingCount },
      // 客観的な信頼性シグナル（集計値のみ — プロバイダー身元は露出しない）
      reliability: { score: rel.score, tier: rel.tier, sessions: rel.sessions, beats: rel.beats, gapEvents: rel.gapEvents, measuring: rel.measuring },
      // 正規化性能スコア。詳細ページでは根拠(basis)と申告矛盾(findings)まで開示する
      // — 借り手が「なぜこのスコアなのか」「申告に矛盾は無いか」を自分で検証できるようにする。
      // basis/findings は公開済みフィールド（型番・VRAM・電力・申告TFLOPS）からの導出値のみで、
      // 非公開情報は含まない。
      performanceScore: perfScore.summarize(gpu),
      // Spot（中断許容）ティア。提供中なら中断率も併記する — 割引の代償がどれくらいの
      // 頻度で現実になるかを借り手が判断できなければ、このティアは選びようがない。
      spot: (() => {
        const s = spotSummary(gpu);
        return s.enabled ? { ...s, providerPreemptionRate: providerPreemptionRate(providerId) } : s;
      })(),
      // 推定カーボン強度と 1 時間あたりの推定排出量。所在地は自己申告で未検証のため、
      // confidence を必ず添えて「検証済みのグリーン認証」と誤読されないようにする。
      carbon: carbonIntensity.summarize(gpu),
    }
  };
  res.json(response);
}));

// GPU レビュー一覧（認証不要 — マーケットプレイスブラウジングと同等）
router.get('/:id/reviews', asyncHandler(async (req, res) => {
  const gpuId = req.params.id;
  const gpu = GpuRepository.getById(gpuId);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  const OrderRepository = require('../../../db/json/OrderRepository');
  const limitRaw = parseInt(req.query.limit, 10);
  const offsetRaw = parseInt(req.query.offset, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  // レビュー本体を spread すると reviewerId（借り手の UUID）が漏れ、認証済み任意ユーザーが
   // GPU 単位で借り手を列挙できる（renter-profile と組合せて renter プロファイリング可能）。
   // 公開して問題ない rating/comment/reviewedAt のみを明示的に投影する。
  const reviews = OrderRepository.getAll()
    .filter(o => o.gpuId === gpuId && o.review)
    .sort((a, b) => (b.review.reviewedAt || '').localeCompare(a.review.reviewedAt || ''))
    .map(o => ({
      orderId: o.id,
      rating: o.review.rating,
      comment: o.review.comment,
      reviewedAt: o.review.reviewedAt,
    }));

  const total = reviews.length;
  const page = reviews.slice(offset, offset + limit);
  const ratingAverage = total > 0
    ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10
    : null;

  res.json({ gpuId, total, limit, offset, ratingAverage, reviews: page });
}));

// 同機種の相場（中央値・最小・最大 sats/時）取得（認証不要 — マーケット閲覧と同等）。
// 借り手が「この価格は妥当か」を他機種横断ではなく同一 model 内で判断できるようにする。
// price-watch (値下げ通知) の自然な発展形 — 既存の listings データのみで算出し、
// 新しい永続化は不要。
router.get('/:id/market-rate', asyncHandler(async (req, res) => {
  const gpu = GpuRepository.getById(req.params.id);
  if (!gpu) return res.status(404).json({ error: 'GPU not found' });

  const peers = GpuRepository.getAll()
    .filter(g => g.model === gpu.model && typeof g.pricePerHour === 'number' && g.pricePerHour > 0)
    .map(g => g.pricePerHour)
    .sort((a, b) => a - b);
  const sampleCount = peers.length;
  const mid = Math.floor(sampleCount / 2);
  const medianPricePerHour = sampleCount === 0
    ? null
    : sampleCount % 2 === 1
      ? peers[mid]
      : Math.round((peers[mid - 1] + peers[mid]) / 2);

  res.json({
    gpuId: gpu.id,
    model: gpu.model,
    sampleCount,
    medianPricePerHour,
    minPricePerHour: sampleCount > 0 ? peers[0] : null,
    maxPricePerHour: sampleCount > 0 ? peers[sampleCount - 1] : null,
  });
}));

// GPU出品登録 (認証必須)
router.post('/',
  authenticateJWT,
  checkRole(['provider', 'admin']),
  validateMiddleware(schemas.gpu.register),
  asyncHandler(async (req, res) => {
    // 入力値サニタイズ
    // 入力値サニタイズ＋クロスベンダー必須項目
    const submitted = sanitizeObject(req.validatedBody, [
      'name', 'vendor', 'model', 'apiType', 'driverVersion', 'os', 'arch',
      'memoryGB', 'clockMHz', 'powerWatt', 'pricePerHour', 'availability',
      'features', 'capabilities', 'location', 'performance', 'minRenterRating',
      'rejectUnratedRenters',
    ]);
    // 出品者が申告しなかった項目のうち、機種から導出できるものを埋める
    // （apiType/arch/powerWatt）。導出した項目名は derivedFields に残し、
    // UI が「申告」と「推定」を区別できるようにする。詳細は
    // src/gpu/listing-defaults.js のヘッダ。
    const { gpu: gpuInfo, derivedFields } = applyListingDefaults(submitted);
    if (derivedFields.length) gpuInfo.derivedFields = derivedFields;
    logger.info(`[GPU登録] ${gpuInfo.vendor} ${gpuInfo.model} (${gpuInfo.apiType || 'API不明'}) by ${req.user.id}`
      + (derivedFields.length ? ` [導出: ${derivedFields.join(',')}]` : ''));

    // 提供者ごとのGPU登録数上限チェック（スパム・在庫偽装防止）
    const MAX_GPUS = (() => {
      const raw = process.env.MAX_GPUS_PER_PROVIDER;
      const n = Number(raw);
      return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : 50;
    })();
    // getAll() は呼び出す度に gpus.json を同期読み込み+パースするためキャッシュしない。
    // クォータチェックと重複チェックで別々に呼ぶと 1 リクエストで 2 回のディスク I/O が
    // 発生するため、1 回のロードを両方のチェックで再利用する。
    const allGpus = GpuRepository.getAll();
    if (req.user.role !== 'admin') {
      const providerGpuCount = allGpus.filter(g => g.providerId === req.user.id).length;
      if (providerGpuCount >= MAX_GPUS) {
        return res.status(429).json({ error: `GPU registration limit reached (max ${MAX_GPUS} per provider)` });
      }
    }

    // 重複登録チェック（model, vendor, providerId, memoryGB）
    const duplicate = allGpus.find(g =>
      g.name === gpuInfo.name &&
      g.model === gpuInfo.model &&
      g.vendor === gpuInfo.vendor &&
      g.memoryGB === gpuInfo.memoryGB &&
      g.providerId === req.user.id
    );
    if (duplicate) {
      return res.status(409).json({ error: 'Duplicate GPU spec already registered' });
    }
    // ユーザーIDを設定
    gpuInfo.providerId = req.user.id;
    // クロスベンダー用のcapabilities自動補完
    gpuInfo.capabilities = gpuInfo.capabilities || {};
    if (gpuInfo.apiType === 'CUDA') gpuInfo.capabilities.cuda = true;
    if (gpuInfo.apiType === 'ROCm') gpuInfo.capabilities.rocm = true;
    if (gpuInfo.apiType === 'oneAPI') gpuInfo.capabilities.oneapi = true;
    if (gpuInfo.apiType === 'OpenCL') gpuInfo.capabilities.opencl = true;

    // GPU アテステーション（任意）— validatedBody から読む（Joi で許可フィールドを限定済み）。
    // req.body から直接読むと攻撃者が任意フィールドを注入し検証を欺けるため必ず validated 側を使う。
    const attestationReport = (req.validatedBody || {}).attestationReport;
    if (attestationReport) {
      try {
        const attResult = await _attestationVerifier.verify(gpuInfo, attestationReport);
        gpuInfo.attestation = {
          passed: attResult.passed,
          score: attResult.score,
          findings: attResult.findings,
          verifiedAt: new Date().toISOString(),
        };
        // レピュテーション記録（DI 済みシングルトン）
        const repSvc = createReputationService();
        repSvc.recordAttestation(req.user.id, attResult.passed);
        if (!attResult.passed) {
          logger.warn(`[GPU登録] アテステーション失敗: providerId=${req.user.id} score=${attResult.score} findings=${attResult.findings.join('; ')}`);
        }
      } catch (attErr) {
        logger.warn(`[GPU登録] アテステーション検証エラー（スキップ）: ${attErr.message}`);
        gpuInfo.attestation = { passed: false, score: 0, findings: ['verifier error: ' + attErr.message], verifiedAt: new Date().toISOString() };
      }
    } else {
      gpuInfo.attestation = { passed: false, score: 0, findings: ['no attestation report provided'], verifiedAt: null };
    }

    // ファイル永続化リポジトリに登録
    const registeredGpu = GpuRepository.create(gpuInfo);
    // GPUイベントをログに記録
    logger.gpuEvent('gpu_registered', {
      gpuId: registeredGpu.id,
      provider: req.user.id,
      specs: {
        name: registeredGpu.name,
        model: registeredGpu.model,
        vendor: registeredGpu.vendor,
        apiType: registeredGpu.apiType,
        driverVersion: registeredGpu.driverVersion,
        os: registeredGpu.os,
        arch: registeredGpu.arch,
        memoryGB: registeredGpu.memoryGB,
        capabilities: registeredGpu.capabilities
      }
    });
    // apiKey等の機密情報を除外
    const { apiKey, ...gpuSafe } = registeredGpu;
    res.status(201).json({
      message: 'GPU successfully registered',
      gpu: gpuSafe,
      attestation: gpuSafe.attestation || null,
    });
  })
);

// GPU情報更新 (認証必須)
router.put('/:id',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
  validateMiddleware(schemas.gpu.update),
  asyncHandler(async (req, res) => {
    const gpu = req.resource;
    const gpuId = gpu.id;
    logger.info(`Updating GPU: ${gpuId}`);
    // 入力値サニタイズ
    // validatedBody は Joi で許可フィールドだけに絞られているため、これを起点にする。
    // 旧コードは req.body をそのまま spread しており、providerId/attestation/apiKey/id 等の
    // 任意フィールドをクライアントが上書きできるマスアサインメント脆弱性があった
    // （GPU 所有権の奪取・偽アテステーション・価格上限回避が可能だった）。
    // rejectUnratedRenters はスキーマ (schemas.gpu.update) で許可済みだが
    // 旧 allowlist に含まれておらずサニタイズで無言に剥落し、機能が完全に
    // 死んでいた（gpu.rejectUnratedRenters は常に undefined → 注文時チェックが
    // 素通り）。allowlist に追加して機能を正常化する。
    const sanitized = sanitizeObject(req.validatedBody, ['name', 'pricePerHour', 'availability', 'minRenterRating', 'available', 'rejectUnratedRenters']);
    // available は boolean のみ許可（任意の型汚染を防ぐ）
    if ('available' in sanitized && typeof sanitized.available !== 'boolean') {
      return res.status(400).json({ error: '"available" must be a boolean' });
    }
    // 名前変更時の重複チェック（memoryGB を正しいフィールド名で参照）
    if (sanitized.name !== undefined && sanitized.name !== gpu.name) {
      const duplicate = GpuRepository.getAll().find(g =>
        g.id !== gpuId &&
        g.name === sanitized.name &&
        g.providerId === gpu.providerId
      );
      if (duplicate) {
        return res.status(409).json({ error: 'Duplicate GPU name already registered by this provider' });
      }
    }
    // Audit minRenterRating / rejectUnratedRenters changes: providers can use
    // these fields to selectively block renters. Log every change for admin review.
    if (sanitized.minRenterRating !== undefined && sanitized.minRenterRating !== gpu.minRenterRating) {
      appendAuditLog('gpu_min_renter_rating_changed', {
        gpuId,
        previousValue: gpu.minRenterRating ?? null,
        newValue: sanitized.minRenterRating,
        providerId: req.user.id,
      }, req.user.id);
    }
    if (sanitized.rejectUnratedRenters !== undefined && sanitized.rejectUnratedRenters !== gpu.rejectUnratedRenters) {
      appendAuditLog('gpu_reject_unrated_renters_changed', {
        gpuId,
        previousValue: gpu.rejectUnratedRenters ?? false,
        newValue: sanitized.rejectUnratedRenters,
        providerId: req.user.id,
      }, req.user.id);
    }
    // GPU情報を更新
    const previousPrice = gpu.pricePerHour;
    const previousAvailable = gpu.available;
    const updatedGPU = GpuRepository.update(gpuId, sanitized);
    logger.info(`GPU updated: ${gpuId}`);
    // 値下げ / 空き復帰を検知: fire-and-forget（通知失敗で更新レスポンスをブロックしない）
    setImmediate(() => notifyPriceWatchers(updatedGPU, { previousPrice, previousAvailable }));
    // apiKey等の機密情報を除外
    const { apiKey, ...gpuSafe } = updatedGPU;
    return res.json({
      message: 'GPU updated successfully',
      gpu: gpuSafe
    });
  })
);

// GPU出品取り下げ (認証必須)
router.delete('/:id', 
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid().required() }).unknown(true), 'params'),
  allowOwnerOrAdmin((req) => GpuRepository.getById(req.params.id)),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    logger.info(`Removing GPU: ${gpuId}`);

    // アクティブ・係争中の注文がある場合は削除を拒否（孤立注文・証拠隠滅を防ぐ）
    // 'disputed' を含めることでプロバイダが係争中に GPU を削除して管理者の裁定材料を
    // 消滅させる griefing パスを塞ぐ。
    const OrderRepository = require('../../../db/json/OrderRepository');
    const BLOCKING = new Set(['pending', 'matched', 'active', 'preempting', 'disputed']);
    const activeOrders = OrderRepository.getAll().filter(o => o.gpuId === gpuId && BLOCKING.has(o.status));
    if (activeOrders.length > 0) {
      return res.status(409).json({
        error: 'Cannot delete GPU with active orders. Cancel or complete all orders first.',
        activeOrderCount: activeOrders.length,
      });
    }

    // GPU登録を削除（ファイル永続化）
    const deleted = GpuRepository.delete(gpuId);
    if (!deleted) {
      return res.status(404).json({ error: 'GPU not found' });
    }
    // 価格ウォッチの後始末: GPU が消えたウォッチは二度と発火せず、watches.json に
    // 永久に残るストレージリークになる。削除と同時に孤児ウォッチを除去する。
    try {
      const orphaned = WatchRepository.getByGpu(gpuId) || [];
      for (const w of orphaned) {
        try { WatchRepository.delete(w.id); } catch (_) {}
      }
    } catch (_) { /* ウォッチ後始末の失敗で GPU 削除レスポンスを妨げない */ }
    // GPUイベントをログに記録
    logger.gpuEvent('gpu_removed', {
      gpuId: gpuId,
      provider: req.user.id
    });
    res.json({ message: 'GPU removed successfully', gpuId });
  })
);

// システムが検出したGPUの一覧を取得 (管理者のみ)
// 旧実装は認証必須のみで一般ユーザーがホストの物理 GPU 在庫を列挙できた
// （ドライバ・ファームウェア・PCI ID 等のサーバー側偵察情報の漏洩）。
router.get('/system/detected',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    if (!requireService(gpuDetector, res)) return;
    logger.info('Detecting system GPUs');
    // 検出できるのは **このサーバが動いているホスト** の GPU であって、
    // 出品されている GPU ではない。また NVIDIA の検出は実装されていないので、
    // 「見つからなかった」と「そもそも見ていない」を混同させないよう明示して返す。
    const result = await gpuDetector.detectAllGPUs();
    res.json({
      message: 'System GPUs detected on the host running this server',
      count: result.gpus.length,
      gpus: result.gpus,
      vendorsCovered: result.vendorsCovered,
      vendorsNotDetected: result.vendorsNotDetected,
      errors: result.errors,
    });
  })
);

// AMD GPUの詳細検出 (管理者のみ)
router.get('/system/amd',
  authenticateJWT,
  checkRole(['admin']),
  asyncHandler(async (req, res) => {
    if (!requireService(gpuDetector, res)) return;
    logger.info('Detecting AMD GPUs with advanced details');
    const amdGPUs = await gpuDetector.detectAMDGPUsAdvanced();
    res.json({
      message: 'AMD GPUs detected',
      count: amdGPUs.length,
      gpus: amdGPUs
    });
  })
);

// ベンチマークのエンドポイント（GET/POST /gpus/:id/benchmark）は削除した。
//
// サーバは**プロバイダのマシンでコードを実行する権限を持たない**。他人の GPU で
// ベンチマークを「走らせる」API はこの構成では原理的に成立せず、実装も
// `throw new Error('GPU benchmarking is not implemented')` のまま登録だけされていて、
// 叩くと 500 を返していた（全ルート走査で唯一の 5xx がこれ）。GET 側も常に null→404。
//
// 性能の裏取りは既に別の仕組みが担っている:
//   - src/gpu/perf-score.js … 型番の公開スペックから正規化スコアを出し、
//     「型番一致（実機検証は未実施）」であることを confidence と根拠として明示する
//   - src/security/gpu-attestation-verifier.js … プロバイダが提出した
//     アテステーションを申告スペックと突き合わせて検証する（出品時に任意提出）
// どちらも「測っていないものを測ったことにしない」形になっているので、
// 走らないベンチマーク API を残す理由が無い。

// GPU 価格ウォッチ登録（値下げアラート）
// POST /gpus/:id/watch — 認証必須（自分が提供していないGPUのみ登録可）
router.post('/:id/watch',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    const gpu = GpuRepository.getById(gpuId);
    if (!gpu) return res.status(404).json({ error: 'GPU not found' });
    if (gpu.providerId === req.user.id) {
      return res.status(403).json({ error: 'Providers cannot watch their own GPUs' });
    }
    const { targetPrice } = req.body;
    if (typeof targetPrice !== 'number' || !Number.isFinite(targetPrice) || targetPrice <= 0) {
      return res.status(400).json({ error: '"targetPrice" must be a positive number' });
    }
    // 1ユーザーあたりのウォッチ上限。無制限だと watches.json を無限に膨張させる
    // リソース枯渇（DoS）経路になるため、上限を設ける。
    // ロックはユーザー単位（gpu 単位ではない）にして、別 GPU への並行登録が
    // 上限チェックを同時通過して cap を超過する TOCTOU を防ぐ。
    const MAX_WATCHES_PER_USER = 200;
    return withLock(`watch:${req.user.id}`, async () => {
      const userWatches = WatchRepository.getByUser(req.user.id) || [];
      const existing = userWatches.find(w => w.gpuId === gpuId);
      let watch;
      if (existing) {
        watch = WatchRepository.update(existing.id, { targetPrice, lastNotifiedPrice: null, lastNotifiedAt: null });
        // ウォッチ更新後も即時チェック: 新 targetPrice が現在価格以下なら即時通知
        setImmediate(() => notifyWatchJustCreated(gpu, watch));
        return res.status(200).json({ watch });
      }
      if (userWatches.length >= MAX_WATCHES_PER_USER) {
        return res.status(429).json({ error: `Cannot watch more than ${MAX_WATCHES_PER_USER} GPUs. Remove an existing watch first.` });
      }
      const { v4: uuidv4 } = require('uuid');
      watch = WatchRepository.create({
        id: uuidv4(),
        userId: req.user.id,
        gpuId,
        targetPrice,
        lastNotifiedPrice: null,
        lastNotifiedAt: null,
        createdAt: new Date().toISOString(),
      });
      // ウォッチ作成直後: 現在価格がすでに目標以下なら即時通知。
      // notifyPriceWatchers は「価格が変化した瞬間」にのみ発火するため、
      // 登録時点で目標達成済みだと以後価格変動がなければ永久に沈黙する UX バグを修正。
      setImmediate(() => notifyWatchJustCreated(gpu, watch));
      return res.status(201).json({ watch });
    });
  })
);

// GPU 価格ウォッチ削除
// DELETE /gpus/:id/watch — 認証必須（自分のウォッチのみ削除可）
router.delete('/:id/watch',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    const gpu = GpuRepository.getById(gpuId);
    if (!gpu) return res.status(404).json({ error: 'GPU not found' });
    const existing = WatchRepository.getAll().find(w => w.userId === req.user.id && w.gpuId === gpuId);
    if (!existing) return res.status(404).json({ error: 'Watch not found' });
    WatchRepository.delete(existing.id);
    return res.status(200).json({ message: 'Watch removed' });
  })
);

// 自分の GPU ウォッチ取得
// GET /gpus/:id/watch — 認証必須
router.get('/:id/watch',
  authenticateJWT,
  validateMiddleware(Joi.object({ id: Joi.string().uuid({ version: 'uuidv4' }).required() }).unknown(true), 'params'),
  asyncHandler(async (req, res) => {
    const gpuId = req.params.id;
    const gpu = GpuRepository.getById(gpuId);
    if (!gpu) return res.status(404).json({ error: 'GPU not found' });
    const watch = WatchRepository.getAll().find(w => w.userId === req.user.id && w.gpuId === gpuId);
    if (!watch) return res.status(404).json({ error: 'Watch not found' });
    return res.json({ watch });
  })
);

module.exports = router;
