// gpu_lending_setup_auto_register.js
// クロスベンダー対応 Strawberry GPU自動登録スクリプト例（Node.js）
// Windows/Linux/Mac対応
//
// 使い方:
//   STRAWBERRY_API_URL=http://localhost:3000 STRAWBERRY_TOKEN=<JWT> node gpu_lending_setup_auto_register.js
// STRAWBERRY_TOKEN は /api/v1/users/login で取得したアクセストークン。
// 登録エンドポイントは POST /api/v1/gpus（schemas.gpu.register の Joi 検証を通る
// フィールドのみ送信すること。unknown キーは 400 で拒否される）。

const os = require('os');
const axios = require('axios');
const { execSync } = require('child_process');

function detectPlatform() {
  const platform = os.platform();
  const arch = os.arch();
  let osName = 'Unknown';
  if (platform === 'win32') osName = 'Windows';
  else if (platform === 'linux') osName = 'Linux';
  else if (platform === 'darwin') osName = 'macOS';
  return { os: osName, arch };
}

// Node の os.arch() 値 → スキーマ許容値 ('x86_64'|'arm64'|'aarch64'|'x86'|'arm')
function mapArch(arch) {
  return { x64: 'x86_64', ia32: 'x86', arm: 'arm', arm64: 'arm64', aarch64: 'aarch64' }[arch] || 'x86_64';
}

function detectGPU() {
  // シンプルなクロスベンダーGPU検出例
  let vendor = 'Unknown', model = 'Unknown', apiType = 'OpenCL', driverVersion = 'Unknown';
  try {
    const platform = os.platform();
    if (platform === 'win32') {
      const wmic = execSync('wmic path win32_VideoController get Name,DriverVersion /format:csv').toString();
      if (wmic.match(/NVIDIA/i)) {
        vendor = 'NVIDIA';
        apiType = 'CUDA';
      } else if (wmic.match(/AMD|Radeon/i)) {
        vendor = 'AMD';
        apiType = 'ROCm';
      } else if (wmic.match(/Intel/i)) {
        vendor = 'Intel';
        apiType = 'oneAPI';
      }
      const lines = wmic.split('\n').filter(x => x.trim());
      if (lines.length > 1) {
        const parts = lines[1].split(',');
        model = (parts[1] || 'Unknown').trim();
        driverVersion = (parts[2] || 'Unknown').trim();
      }
    } else if (platform === 'linux') {
      const lspci = execSync('lspci | grep VGA').toString();
      if (lspci.match(/NVIDIA/i)) {
        vendor = 'NVIDIA';
        apiType = 'CUDA';
      } else if (lspci.match(/AMD|Radeon/i)) {
        vendor = 'AMD';
        apiType = 'ROCm';
      } else if (lspci.match(/Intel/i)) {
        vendor = 'Intel';
        apiType = 'oneAPI';
      }
      model = (lspci.split(':')[2] || 'Unknown').trim();
      // ドライババージョンは省略可（Unknown でもスキーマ上 valid）
    }
  } catch (e) {}
  return { vendor, model, apiType, driverVersion };
}

async function autoRegisterGPU() {
  const { os: osName, arch } = detectPlatform();
  const gpu = detectGPU();
  if (!['NVIDIA', 'AMD', 'Intel'].includes(gpu.vendor)) {
    console.error('[ERROR] 対応 GPU を検出できませんでした（NVIDIA/AMD/Intel のみ登録可）:', gpu.vendor);
    return;
  }
  // schemas.gpu.register に合わせる。id はサーバーが UUID v4 を生成するため送信しない。
  // memoryGB/clockMHz/powerWatt/pricePerHour は必須 — 実値は環境変数で上書き推奨。
  const gpuInfo = {
    name: `${gpu.vendor} ${gpu.model}`.slice(0, 128),
    vendor: gpu.vendor,
    model: gpu.model.slice(0, 128),
    apiType: gpu.apiType,
    driverVersion: String(gpu.driverVersion).slice(0, 64),
    os: osName,
    arch: mapArch(arch),
    memoryGB: Number(process.env.GPU_MEMORY_GB) || 8,
    clockMHz: Number(process.env.GPU_CLOCK_MHZ) || 1500,
    powerWatt: Number(process.env.GPU_POWER_WATT) || 120,
    pricePerHour: Number(process.env.GPU_PRICE_PER_HOUR) || 0.10,
    availability: { hoursPerDay: 24, daysAvailable: [0,1,2,3,4,5,6] },
    features: { cudaSupport: gpu.apiType==='CUDA', openCLSupport: true, rocmSupport: gpu.apiType==='ROCm', oneAPISupport: gpu.apiType==='oneAPI' },
    capabilities: { cuda: gpu.apiType==='CUDA', opencl: true, rocm: gpu.apiType==='ROCm', oneapi: gpu.apiType==='oneAPI' },
    performance: { benchmarkScore: 0 }
  };
  const API_URL = process.env.STRAWBERRY_API_URL || 'http://localhost:3000';
  const TOKEN = process.env.STRAWBERRY_TOKEN;
  if (!TOKEN) {
    console.error('[ERROR] STRAWBERRY_TOKEN が未設定です（/api/v1/users/login で取得）');
    return;
  }
  try {
    const res = await axios.post(`${API_URL}/api/v1/gpus`, gpuInfo, { headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log('[SUCCESS] GPU登録:', res.data);
  } catch (e) {
    console.error('[ERROR] GPU登録失敗:', e.response?.data || e.message);
  }
}

if (require.main === module) {
  autoRegisterGPU();
}
