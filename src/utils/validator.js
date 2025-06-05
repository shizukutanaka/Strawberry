// src/utils/validator.js - 入力バリデーションユーティリティ
const Joi = require('joi');
const { APIError, ErrorTypes } = require('./error-handler');

// 共通バリデーションスキーマ
const schemas = {
  // GPU関連
  gpu: {
    // GPU登録用スキーマ
    register: Joi.object({
      id: Joi.string().required(),
      name: Joi.string().required(),
      vendor: Joi.string().required(),
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
        directXSupport: Joi.boolean(),
        tensorCores: Joi.boolean(),
        rayTracingCores: Joi.boolean()
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
      })
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
    create: Joi.object({
      userId: Joi.string().required(),
      gpuRequirements: Joi.object({
        minMemoryGB: Joi.number().min(1).required(),
        minClockMHz: Joi.number().min(100),
        features: Joi.object({
          cudaSupport: Joi.boolean(),
          openCLSupport: Joi.boolean(),
          directXSupport: Joi.boolean(),
          tensorCores: Joi.boolean(),
          rayTracingCores: Joi.boolean()
        })
      }).required(),
      duration: Joi.object({
        hours: Joi.number().min(1).required(),
        startTime: Joi.date().iso(),
        endTime: Joi.date().iso()
      }).required(),
      maxPricePerHour: Joi.number().min(0.00001).required(),
      paymentMethod: Joi.string().valid('lightning', 'onchain').required(),
      location: Joi.object({
        preferredCountry: Joi.string(),
        maxDistance: Joi.number().min(0),
        latitude: Joi.number().min(-90).max(90),
        longitude: Joi.number().min(-180).max(180)
      }),
      priority: Joi.string().valid('price', 'performance', 'availability', 'distance').default('price')
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
      role: Joi.string().valid('user', 'provider', 'admin').optional()
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
function validateMiddleware(schema) {
  return (req, res, next) => {
    try {
      // リクエストボディをバリデーション
      const validated = validate(req.body, schema);
      req.validatedBody = validated;
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

// Joi用UUID拡張
const Joi = require('joi').extend((joi) => ({
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
