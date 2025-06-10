// gpu_lending_setup_auto_register.js
// クロスベンダー対応 Strawberry GPU自動登録スクリプト例（Node.js）
// Windows/Linux/Mac対応

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
        model = parts[1] || 'Unknown';
        driverVersion = parts[2] || 'Unknown';
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
      model = lspci.split(':')[2] || 'Unknown';
      // ドライババージョンは省略可
    }
  } catch (e) {}
  return { vendor, model, apiType, driverVersion };
}

async function autoRegisterGPU() {
  const { os: osName, arch } = detectPlatform();
  const gpu = detectGPU();
  // サンプル値（実際は自動検出/ユーザー入力で拡張）
  const gpuInfo = {
    id: 'auto-' + Math.random().toString(36).slice(2),
    name: `${gpu.vendor} ${gpu.model}`,
    vendor: gpu.vendor,
    model: gpu.model,
    apiType: gpu.apiType,
    driverVersion: gpu.driverVersion,
    os: osName,
    arch,
    memoryGB: 8, // 仮値: 実際は検出
    clockMHz: 1500, // 仮値
    powerWatt: 120, // 仮値
    pricePerHour: 0.10, // 仮値
    availability: { hoursPerDay: 24, daysAvailable: [0,1,2,3,4,5,6] },
    features: { cudaSupport: gpu.apiType==='CUDA', openCLSupport: true, rocmSupport: gpu.apiType==='ROCm', oneAPISupport: gpu.apiType==='oneAPI' },
    capabilities: { cuda: gpu.apiType==='CUDA', opencl: true, rocm: gpu.apiType==='ROCm', oneapi: gpu.apiType==='oneAPI' },
    location: { country: '', region: '', city: '' },
    performance: { benchmarkScore: 0 }
  };
  // 実際のAPIエンドポイント・認証トークンに置換
  const API_URL = 'http://localhost:3000/api/gpu';
  const TOKEN = 'YOUR_JWT_TOKEN';
  try {
    const res = await axios.post(API_URL, gpuInfo, { headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log('[SUCCESS] GPU登録:', res.data);
  } catch (e) {
    console.error('[ERROR] GPU登録失敗:', e.response?.data || e.message);
  }
}

if (require.main === module) {
  autoRegisterGPU();
}
