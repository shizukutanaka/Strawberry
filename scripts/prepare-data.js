// Strawberry OSS用サンプルデータ自動生成スクリプト
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const files = [
  {
    name: 'users.json',
    sample: [
      { id: 'user01', name: 'Demo User', role: 'user', email: 'demo@example.com' },
      { id: 'admin01', name: 'Admin User', role: 'admin', email: 'admin@example.com' }
    ]
  },
  {
    name: 'orders.json',
    sample: [
      { id: 'order01', userId: 'user01', gpuId: 'gpu01', status: 'pending', price: 1000, currency: 'BTC' }
    ]
  },
  {
    name: 'gpus.json',
    sample: [
      { id: 'gpu01', name: 'RTX4090', provider: 'user01', price: 1000, status: 'available' }
    ]
  }
];

for (const f of files) {
  const filePath = path.join(dataDir, f.name);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(f.sample, null, 2));
    console.log(`Created sample: ${f.name}`);
  } else {
    console.log(`Exists: ${f.name}`);
  }
}
