// Strawberry OSS用サンプルデータ自動生成スクリプト
//
// 注意: スキーマ非適合なレコードを data/ に置くと実害がある。
//   - GPU: vendor/apiType/pricePerHour/providerId 欠落の `available` なレコードは
//     GET /api/v1/gpus?vendor=… で `gpu.vendor.toLowerCase()` の TypeError(500)を起こし、
//     一覧にも価格計算不能な出品として現れる。→ 実スキーマ準拠 + status:'maintenance'
//     （レンタル導線・占有判定に入らない）で種入れする。
//   - Order: status:'pending' で createdAt 欠落のレコードは失効スイープや
//     admin/stats の分母を歪める。→ status:'cancelled'（終端状態）で種入れする。
//   - User: passwordHash なしはログイン不可（安全）。username/email/role のみの
//     デモ表示用レコードに留める。
// すべてのレコードに demo:true を付与し、本番データとの識別を容易にする。
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');

const NOW = '2026-01-01T00:00:00.000Z';

const files = [
  {
    name: 'users.json',
    sample: [
      {
        id: 'demo-user-01',
        username: 'demo-user',
        email: 'demo@example.com',
        role: 'user',
        status: 'active',
        demo: true,
        createdAt: NOW,
      },
      {
        id: 'demo-admin-01',
        username: 'demo-admin',
        email: 'admin@example.com',
        role: 'admin',
        status: 'active',
        demo: true,
        createdAt: NOW,
      },
    ],
  },
  {
    name: 'gpus.json',
    sample: [
      {
        id: 'demo-gpu-01',
        name: 'Demo RTX 4090',
        model: 'RTX 4090',
        vendor: 'NVIDIA',
        apiType: 'CUDA',
        driverVersion: '535.0',
        os: 'linux',
        arch: 'x86_64',
        memoryGB: 24,
        clockMHz: 2520,
        powerWatt: 450,
        pricePerHour: 1200,
        providerId: 'demo-admin-01',
        status: 'maintenance',
        features: {},
        demo: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  },
  {
    name: 'orders.json',
    sample: [
      {
        id: 'demo-order-01',
        userId: 'demo-user-01',
        providerId: 'demo-admin-01',
        gpuId: 'demo-gpu-01',
        pricePerHour: 1200,
        durationMinutes: 60,
        totalPrice: 1200,
        status: 'cancelled',
        cancelReason: 'demo_seed',
        cancelledAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        demo: true,
      },
    ],
  },
];

function main() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  for (const f of files) {
    const filePath = path.join(dataDir, f.name);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(f.sample, null, 2));
      console.log(`Created sample: ${f.name}`);
    } else {
      console.log(`Exists: ${f.name}`);
    }
  }
  console.log('Done. Seeded records are schema-conformant but inert (gpu=maintenance, order=cancelled, users have no passwordHash).');
}

if (require.main === module) main();

module.exports = { files };
