// src/utils/validator.js - 入力バリデーションユーティリティ
// 後段(L249)で uuid 型を拡張した Joi に差し替えるため let で宣言（二重 const 宣言エラーを解消）
let Joi = require('joi');
const { APIError, ErrorTypes } = require('./error-handler');

// 共通バリデーションスキーマ
const schemas = {
  // Lightningノード情報
  lightningNode: Joi.object({
    pubkey: Joi.string().required(),
    alias: Joi.string().required(),
    activeChannels: Joi.number().min(0).required(),
    peers: Joi.number().min(0).required(),
    blockHeight: Joi.number().min(0).required(),
    synced: Joi.boolean().required(),
    version: Joi.string().required(),
    network: Joi.string().valid('mainnet', 'testnet', 'regtest', 'simnet').required(),
    uris: Joi.array().items(Joi.string())
  }),
  // Lightningチャネル情報
  lightningChannel: Joi.object({
    active: Joi.boolean().required(),
    remotePubkey: Joi.string().required(),
    channelPoint: Joi.string().required(),
    chanId: Joi.string().required(),
    capacity: Joi.number().min(0).required(),
    localBalance: Joi.number().min(0).required(),
    remoteBalance: Joi.number().min(0).required(),
    totalSent: Joi.number().min(0),
    totalReceived: Joi.number().min(0),
    unsettledBalance: Joi.number().min(0)
  }),
  // GPU関連
  gpu: {
    // GPU登録用スキーマ
    register: Joi.object({
  id: Joi.string().max(64).required(),
  name: Joi.string().max(128).required(),
  vendor: Joi.string().valid('NVIDIA', 'AMD', 'Intel').required(),
  model: Joi.string().max(128).required(),
  apiType: Joi.string().valid('CUDA', 'ROCm', 'oneAPI', 'OpenCL').required(),
  driverVersion: Joi.string().max(64).required(),
  os: Joi.string().max(64).required(),
  arch: Joi.string().valid('x86_64', 'arm64', 'aarch64', 'x86', 'arm').required(),
  memoryGB: Joi.number().min(1).required(),
  clockMHz: Joi.number().min(100).required(),
  powerWatt: Joi.number().min(1).required(),
  pricePerHour: Joi.number().min(0.00001).required(),
  availability: Joi.object({
    startTime: Joi.date().iso(),
    endTime: Joi.date().iso(),
    hoursPerDay: Joi.number().min(1).max(24),
    daysAvailable: Joi.array().items(Joi.number().min(0).max(6))
  }),
  features: Joi.object({
    cudaSupport: Joi.boolean(),
    openCLSupport: Joi.boolean(),
    rocmSupport: Joi.boolean(),
    oneAPISupport: Joi.boolean(),
    directXSupport: Joi.boolean(),
    tensorCores: Joi.boolean(),
    rayTracingCores: Joi.boolean()
  }),
  capabilities: Joi.object({
    cuda: Joi.boolean(),
    opencl: Joi.boolean(),
    rocm: Joi.boolean(),
    oneapi: Joi.boolean()
  }),
  location: Joi.object({
    country: Joi.string(),
    region: Joi.string(),
    city: Joi.string(),
    latitude: Joi.number().min(-90).max(90),
    longitude: Joi.number().min(-180).max(180)
  }),
  performance: Joi.object({
    benchmarkScore: Joi.number(),
    teraflops: Joi.number(),
    hashrate: Joi.number()
  }),
  minRenterRating: Joi.number().min(1).max(5).optional()
}),

    // GPU更新用スキーマ（全フィールドオプション — 部分更新）
    update: Joi.object({
      name: Joi.string().max(128).optional(),
      pricePerHour: Joi.number().min(0.00001).optional(),
      availability: Joi.object({
        startTime: Joi.date().iso(),
        endTime: Joi.date().iso(),
        hoursPerDay: Joi.number().min(1).max(24),
        daysAvailable: Joi.array().items(Joi.number().min(0).max(6))
      }).optional(),
      minRenterRating: Joi.number().min(1).max(5).optional(),
      available: Joi.boolean().optional()
    }),

    // GPU検索用スキーマ
    search: Joi.object({
      minMemoryGB: Joi.number().min(1),
      minClockMHz: Joi.number().min(100),
      maxPowerWatt: Joi.number().min(1),
      maxPricePerHour: Joi.number().min(0),
      vendors: Joi.array().items(Joi.string()),
      features: Joi.object({
        cudaSupport: Joi.boolean(),
        openCLSupport: Joi.boolean(),
        directXSupport: Joi.boolean(),
        tensorCores: Joi.boolean(),
        rayTracingCores: Joi.boolean()
      }),
      location: Joi.object({
        country: Joi.string(),
        maxDistance: Joi.number().min(0),
        latitude: Joi.number().min(-90).max(90),
        longitude: Joi.number().min(-180).max(180)
      }),
      availability: Joi.object({
        minHours: Joi.number().min(1),
        startTime: Joi.date().iso(),
        endTime: Joi.date().iso()
      }),
      sort: Joi.string().valid('price', 'performance', 'availability', 'distance'),
      sortDirection: Joi.string().valid('asc', 'desc'),
      limit: Joi.number().min(1).max(100),
      offset: Joi.number().min(0)
    })
  },
  
  // オーダー関連
  order: {
    // オーダー作成用スキーマ
    // 重要: 旧スキーマは gpuRequirements/duration{hours}/maxPricePerHour を要求していたが、
    // ハンドラ(routes/order/index.js)が読むのは gpuId/durationMinutes であり、かつ
    // validate は stripUnknown:true で未知キーを除去する。このため gpuId/durationMinutes が
    // 必ず欠落し、注文作成が常に 400 で失敗していた（プロダクト中核機能が動作不能）。
    // ハンドラの実契約に合わせて再定義する。
    create: Joi.object({
      // userId はトークン(req.user.id)から設定するため body では任意（送られても無視）
      userId: Joi.string().optional(),
      gpuId: Joi.string().required(),
      // ハンドラは正の整数かつ 5 の倍数を要求する
      durationMinutes: Joi.number().integer().min(5).multiple(5).required(),
      description: Joi.string().max(1000).optional(),
      paymentMethod: Joi.string().valid('lightning', 'onchain').optional(),
      // gpuId 指定時はハンドラ側で maxPricePerHour との併用を拒否する（排他）
      maxPricePerHour: Joi.number().min(0.00001).optional(),
      location: Joi.object({
        preferredCountry: Joi.string(),
        maxDistance: Joi.number().min(0),
        latitude: Joi.number().min(-90).max(90),
        longitude: Joi.number().min(-180).max(180)
      }).optional(),
      priority: Joi.string().valid('price', 'performance', 'availability', 'distance').default('price'),
      // 事前予約: 指定しない場合は即時（now）として扱う
      scheduledStartAt: Joi.string().isoDate().optional()
    })
  },
  
  // マッチング関連
  match: {
    // マッチング要求用スキーマ
    request: Joi.object({
      orderId: Joi.string().required(),
      maxResults: Joi.number().min(1).max(50).default(10),
      timeout: Joi.number().min(1000).max(30000).default(5000)
    })
  },
  
  // 決済関連
  payment: {
    // インボイス作成用スキーマ
    createInvoice: Joi.object({
      amount: Joi.number().min(1).required(),
      description: Joi.string().required(),
      expiry: Joi.number().min(60).max(86400).default(3600)
    }),
    
    // 決済実行用スキーマ
    pay: Joi.object({
      paymentRequest: Joi.string().required(),
      amount: Joi.number().min(1),
      maxFeePercent: Joi.number().min(0).max(10).default(1)
    })
  },
  
  // ユーザー関連
  user: {
    // ユーザー登録用スキーマ
    register: Joi.object({
      username: Joi.string().alphanum().min(3).max(30).required(),
      email: Joi.string().email().required(),
      password: Joi.string()
        .min(8)
        .pattern(/[a-z]/, 'lowercase')
        .pattern(/[A-Z]/, 'uppercase')
        .pattern(/[0-9]/, 'number')
        .pattern(/[^a-zA-Z0-9]/, 'symbol')
        .required()
        .messages({
          'string.pattern.name': 'Password must include at least one {#name} character',
          'string.min': 'Password must be at least 8 characters long'
        }),
      role: Joi.string().valid('user', 'provider').optional()
    }),
    
    // ログイン用スキーマ
    login: Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().required()
    })
  }
};

// バリデーション関数
function validate(data, schema) {
  const { error, value } = schema.validate(data, {
    abortEarly: false,
    stripUnknown: true
  });
  
  if (error) {
    // エラーメッセージを整形
    const details = error.details.map(detail => ({
      field: detail.path.join('.'),
      message: detail.message
    }));
    
    throw new APIError(
      ErrorTypes.VALIDATION,
      'Validation failed',
      400,
      { details }
    );
  }
  
  return value;
}

// Express用バリデーションミドルウェア
// 既存バグ: 第2引数 source('params'/'query')が無視され常に req.body を検証していたため、
// validateMiddleware(paramSchema, 'params') が body を param スキーマで検証し、PUT/DELETE /:id
// などが「id is required」で 400 になっていた。source を尊重して該当部位を検証する。
function validateMiddleware(schema, source = 'body') {
  return (req, res, next) => {
    try {
      const target = source === 'params' ? req.params : source === 'query' ? req.query : req.body;
      const validated = validate(target, schema);
      if (source === 'params') req.validatedParams = validated;
      else if (source === 'query') req.validatedQuery = validated;
      else req.validatedBody = validated;
      next();
    } catch (error) {
      next(error);
    }
  };
}

// UUID形式チェック
function isUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return typeof str === 'string' && uuidRegex.test(str);
}

// Joi用UUID拡張（既存の Joi を拡張版へ差し替え）
Joi = require('joi').extend((joi) => ({
  type: 'uuid',
  base: joi.string(),
  messages: {
    'uuid.base': '{{#label}} must be a valid UUID',
  },
  validate(value, helpers) {
    if (!isUUID(value)) {
      return { value, errors: helpers.error('uuid.base') };
    }
  }
}));

module.exports = {
  schemas,
  validate,
  validateMiddleware,
  isUUID,
  Joi
};
