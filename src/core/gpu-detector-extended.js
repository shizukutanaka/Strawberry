// src/core/gpu-detector-extended.js - Extended GPU Detection for AMD/Intel
const { exec } = require('child_process').promises;
const fs = require('fs').promises;
const path = require('path');
const { logger } = require('../utils/logger');

class ExtendedGPUDetector {
    constructor() {
        this.platform = process.platform;
        this.amdGPUs = new Map();
        this.intelGPUs = new Map();
    }

    // ===== AMD GPU検出 =====
    async detectAMDGPUsAdvanced() {
        const gpus = [];
        
        try {
            if (this.platform === 'linux') {
                // ROCm検出
                const hasROCm = await this.checkROCmInstallation();
                if (hasROCm) {
                    gpus.push(...await this.detectROCmGPUs());
                }
                
                // AMDGPUドライバー経由の検出
                gpus.push(...await this.detectAMDGPUDriver());
            } else if (this.platform === 'win32') {
                // Windows WMI経由
                gpus.push(...await this.detectAMDGPUsWindows());
            }
            
            // GPU情報の詳細取得
            for (const gpu of gpus) {
                gpu.details = await this.getAMDGPUDetails(gpu);
                gpu.performance = await this.benchmarkAMDGPU(gpu);
                this.amdGPUs.set(gpu.uuid, gpu);
            }
            
            logger.info(`Detected ${gpus.length} AMD GPUs`);
            return gpus;
            
        } catch (error) {
            logger.error('AMD GPU detection failed:', error);
            return [];
        }
    }

    async checkROCmInstallation() {
        try {
            const { stdout } = await exec('rocm-smi --version');
            return stdout.includes('ROCm');
        } catch {
            return false;
        }
    }

    async detectROCmGPUs() {
        const gpus = [];
        
        try {
            // ROCm-SMI JSON出力
            const { stdout } = await exec('rocm-smi --showallinfo --json');
            const rocmData = JSON.parse(stdout);
            
            for (const [cardId, cardInfo] of Object.entries(rocmData)) {
                if (cardInfo.hasOwnProperty('Card series')) {
                    const gpu = {
                        uuid: `AMD-ROCm-${cardId}`,
                        vendor: 'AMD',
                        name: cardInfo['Card model'] || cardInfo['Card series'],
                        model: this.parseAMDModelAdvanced(cardInfo['Card model']),
                        vram: parseInt(cardInfo['VRAM Total Memory (B)'] || 0) / (1024 * 1024),
                        vramFree: parseInt(cardInfo['VRAM Free Memory (B)'] || 0) / (1024 * 1024),
                        vramUsed: parseInt(cardInfo['VRAM Used Memory (B)'] || 0) / (1024 * 1024),
                        temperature: parseFloat(cardInfo['Temperature (Sensor edge) (C)'] || 0),
                        utilization: parseFloat(cardInfo['GPU use (%)'] || 0),
                        powerDraw: parseFloat(cardInfo['Average Graphics Package Power (W)'] || 0),
                        clockSpeed: parseInt(cardInfo['sclk clock speed:'] || 0),
                        memoryClockSpeed: parseInt(cardInfo['mclk clock speed:'] || 0),
                        fanSpeed: parseFloat(cardInfo['Fan speed (%)'] || 0),
                        busId: cardInfo['PCI Bus'] || '',
                        driver: {
                            version: await this.getAMDDriverVersion(),
                            rocmVersion: await this.getROCmVersion()
                        },
                        capabilities: {
                            opencl: true,
                            vulkan: true,
                            rocm: true,
                            hip: true,
                            cuda: false,
                            tensorCores: false,
                            matrixCores: this.hasAMDMatrixCores(cardInfo['Card model']),
                            rayAccelerators: this.hasAMDRayAccelerators(cardInfo['Card model'])
                        }
                    };
                    
                    gpus.push(gpu);
                }
            }
        } catch (error) {
            logger.error('ROCm GPU detection error:', error);
        }
        
        return gpus;
    }

    async detectAMDGPUDriver() {
        const gpus = [];
        
        try {
            // /sys/class/drm 経由の検出
            const drmPath = '/sys/class/drm';
            const entries = await fs.readdir(drmPath);
            
            for (const entry of entries) {
                if (entry.includes('card') && !entry.includes('render')) {
                    const devicePath = path.join(drmPath, entry, 'device');
                    
                    try {
                        const vendor = await fs.readFile(path.join(devicePath, 'vendor'), 'utf8');
                        if (vendor.trim() === '0x1002') { // AMD vendor ID
                            const device = await fs.readFile(path.join(devicePath, 'device'), 'utf8');
                            const gpu = await this.parseAMDGPUFromSysfs(devicePath, entry);
                            if (gpu) gpus.push(gpu);
                        }
                    } catch {}
                }
            }
        } catch (error) {
            logger.debug('sysfs AMD GPU detection error:', error);
        }
        
        return gpus;
    }

    async detectAMDGPUsWindows() {
        const gpus = [];
        
        try {
            // WMI クエリ
            const { stdout } = await exec(
                'wmic path Win32_VideoController where "AdapterCompatibility like \'%AMD%\' or AdapterCompatibility like \'%ATI%\'" get * /format:csv'
            );
            
            const lines = stdout.split('\n').filter(line => line.trim());
            if (lines.length > 2) {
                const headers = lines[1].split(',');
                
                for (let i = 2; i < lines.length; i++) {
                    const values = lines[i].split(',');
                    const gpu = {};
                    
                    headers.forEach((header, index) => {
                        gpu[header] = values[index];
                    });
                    
                    if (gpu.Name) {
                        gpus.push({
                            uuid: `AMD-Win-${gpu.DeviceID}`,
                            vendor: 'AMD',
                            name: gpu.Name,
                            model: this.parseAMDModelAdvanced(gpu.Name),
                            vram: parseInt(gpu.AdapterRAM || 0) / (1024 * 1024),
                            driver: {
                                version: gpu.DriverVersion,
                                date: gpu.DriverDate
                            },
                            capabilities: {
                                opencl: true,
                                vulkan: true,
                                directx: true
                            }
                        });
                    }
                }
            }
        } catch (error) {
            logger.error('Windows AMD GPU detection error:', error);
        }
        
        return gpus;
    }

    // ===== Intel GPU検出 =====
    async detectIntelGPUsAdvanced() {
        const gpus = [];
        
        try {
            if (this.platform === 'linux') {
                // Intel GPU Tools検出
                gpus.push(...await this.detectIntelGPUTools());
                
                // sysfs経由の検出
                gpus.push(...await this.detectIntelSysfs());
            } else if (this.platform === 'win32') {
                // Windows WMI経由
                gpus.push(...await this.detectIntelGPUsWindows());
            }
            
            // GPU情報の詳細取得
            for (const gpu of gpus) {
                gpu.details = await this.getIntelGPUDetails(gpu);
                gpu.performance = await this.benchmarkIntelGPU(gpu);
                this.intelGPUs.set(gpu.uuid, gpu);
            }
            
            logger.info(`Detected ${gpus.length} Intel GPUs`);
            return gpus;
            
        } catch (error) {
            logger.error('Intel GPU detection failed:', error);
            return [];
        }
    }

    async detectIntelGPUTools() {
        const gpus = [];
        
        try {
            // intel_gpu_top コマンドで情報取得
            const { stdout } = await exec('timeout 1 intel_gpu_top -J -o -');
            const data = JSON.parse(stdout);
            
            if (data.engines) {
                const gpu = {
                    uuid: `Intel-GPU-${data.card || '0'}`,
                    vendor: 'Intel',
                    name: data.name || 'Intel Graphics',
                    model: this.parseIntelModelAdvanced(data.name),
                    utilization: this.calculateIntelUtilization(data.engines),
                    frequency: data.frequency || {},
                    power: data.power || {},
                    capabilities: {
                        opencl: true,
                        vulkan: true,
                        levelZero: await this.checkLevelZero(),
                        quickSync: true,
                        avCodec: true
                    }
                };
                
                // Intel GPU メモリ情報取得
                gpu.vram = await this.getIntelGPUMemory();
                
                gpus.push(gpu);
            }
        } catch (error) {
            logger.debug('intel_gpu_top not available:', error.message);
        }
        
        return gpus;
    }

    async detectIntelSysfs() {
        const gpus = [];
        
        try {
            const drmPath = '/sys/class/drm';
            const entries = await fs.readdir(drmPath);
            
            for (const entry of entries) {
                if (entry.includes('card') && !entry.includes('render')) {
                    const devicePath = path.join(drmPath, entry, 'device');
                    
                    try {
                        const vendor = await fs.readFile(path.join(devicePath, 'vendor'), 'utf8');
                        if (vendor.trim() === '0x8086') { // Intel vendor ID
                            const device = await fs.readFile(path.join(devicePath, 'device'), 'utf8');
                            const gpu = await this.parseIntelGPUFromSysfs(devicePath, entry);
                            if (gpu) gpus.push(gpu);
                        }
                    } catch {}
                }
            }
        } catch (error) {
            logger.debug('sysfs Intel GPU detection error:', error);
        }
        
        return gpus;
    }

    async detectIntelGPUsWindows() {
        const gpus = [];
        
        try {
            const { stdout } = await exec(
                'wmic path Win32_VideoController where "AdapterCompatibility like \'%Intel%\'" get * /format:csv'
            );
            
            const lines = stdout.split('\n').filter(line => line.trim());
            if (lines.length > 2) {
                const headers = lines[1].split(',');
                
                for (let i = 2; i < lines.length; i++) {
                    const values = lines[i].split(',');
                    const gpu = {};
                    
                    headers.forEach((header, index) => {
                        gpu[header] = values[index];
                    });
                    
                    if (gpu.Name && this.isDiscreteIntelGPU(gpu.Name)) {
                        gpus.push({
                            uuid: `Intel-Win-${gpu.DeviceID}`,
                            vendor: 'Intel',
                            name: gpu.Name,
                            model: this.parseIntelModelAdvanced(gpu.Name),
                            vram: parseInt(gpu.AdapterRAM || 0) / (1024 * 1024),
                            driver: {
                                version: gpu.DriverVersion,
                                date: gpu.DriverDate
                            },
                            capabilities: {
                                opencl: true,
                                vulkan: true,
                                directx: true,
                                quickSync: true
                            }
                        });
                    }
                }
            }
        } catch (error) {
            logger.error('Windows Intel GPU detection error:', error);
        }
        
        return gpus;
    }

    // ===== ヘルパーメソッド =====
    
    parseAMDModelAdvanced(name) {
        const models = {
            'RX 7900 XTX': { series: 'RX 7000', architecture: 'RDNA 3', compute: 61.4 },
            'RX 7900 XT': { series: 'RX 7000', architecture: 'RDNA 3', compute: 51.6 },
            'RX 7800 XT': { series: 'RX 7000', architecture: 'RDNA 3', compute: 37.3 },
            'RX 7700 XT': { series: 'RX 7000', architecture: 'RDNA 3', compute: 35.2 },
            'RX 7600': { series: 'RX 7000', architecture: 'RDNA 3', compute: 21.8 },
            'RX 6950 XT': { series: 'RX 6000', architecture: 'RDNA 2', compute: 23.8 },
            'RX 6900 XT': { series: 'RX 6000', architecture: 'RDNA 2', compute: 23.0 },
            'RX 6800 XT': { series: 'RX 6000', architecture: 'RDNA 2', compute: 20.7 },
            'RX 6800': { series: 'RX 6000', architecture: 'RDNA 2', compute: 16.2 },
            'RX 6700 XT': { series: 'RX 6000', architecture: 'RDNA 2', compute: 13.2 },
            'RX 6600 XT': { series: 'RX 6000', architecture: 'RDNA 2', compute: 10.6 }
        };
        
        for (const [model, specs] of Object.entries(models)) {
            if (name && name.includes(model)) {
                return specs;
            }
        }
        
        return { series: 'Unknown', architecture: 'Unknown', compute: 0 };
    }

    parseIntelModelAdvanced(name) {
        const models = {
            'Arc A770': { series: 'Arc', architecture: 'Xe-HPG', xeCores: 32 },
            'Arc A750': { series: 'Arc', architecture: 'Xe-HPG', xeCores: 28 },
            'Arc A580': { series: 'Arc', architecture: 'Xe-HPG', xeCores: 24 },
            'Arc A380': { series: 'Arc', architecture: 'Xe-HPG', xeCores: 8 },
            'Arc A310': { series: 'Arc', architecture: 'Xe-HPG', xeCores: 6 },
            'Iris Xe MAX': { series: 'Xe', architecture: 'Xe-LP', euCount: 96 }
        };
        
        for (const [model, specs] of Object.entries(models)) {
            if (name && name.includes(model)) {
                return specs;
            }
        }
        
        return { series: 'Unknown', architecture: 'Unknown', xeCores: 0 };
    }

    hasAMDMatrixCores(model) {
        // RDNA 3 以降はMatrix Coresを搭載
        return model && (model.includes('RX 7') || model.includes('MI300'));
    }

    hasAMDRayAccelerators(model) {
        // RDNA 2 以降はRay Acceleratorsを搭載
        return model && (model.includes('RX 6') || model.includes('RX 7'));
    }

    isDiscreteIntelGPU(name) {
        // 統合グラフィックスを除外
        const discrete = ['Arc', 'Xe MAX', 'DG1', 'DG2'];
        return discrete.some(d => name.includes(d));
    }

    calculateIntelUtilization(engines) {
        if (!engines) return 0;
        
        let totalBusy = 0;
        let count = 0;
        
        Object.values(engines).forEach(engine => {
            if (engine.busy !== undefined) {
                totalBusy += engine.busy;
                count++;
            }
        });
        
        return count > 0 ? totalBusy / count : 0;
    }

    async getAMDDriverVersion() {
        try {
            if (this.platform === 'linux') {
                const { stdout } = await exec('modinfo amdgpu | grep version:');
                const match = stdout.match(/version:\s+(.+)/);
                return match ? match[1].trim() : 'Unknown';
            }
            return 'Unknown';
        } catch {
            return 'Unknown';
        }
    }

    async getROCmVersion() {
        try {
            const { stdout } = await exec('rocm-smi --version');
            const match = stdout.match(/ROCm version:\s+(\d+\.\d+\.\d+)/);
            return match ? match[1] : 'Unknown';
        } catch {
            return 'Unknown';
        }
    }

    async checkLevelZero() {
        try {
            await exec('level-zero-info');
            return true;
        } catch {
            return false;
        }
    }

    async getIntelGPUMemory() {
        try {
            // Intel GPU メモリ情報取得（実装は環境依存）
            const { stdout } = await exec('clinfo | grep "Global memory size"');
            const match = stdout.match(/(\d+)/);
            return match ? parseInt(match[1]) / (1024 * 1024) : 0;
        } catch {
            return 0;
        }
    }

    async getAMDGPUDetails(gpu) {
        const details = {
            computeUnits: 0,
            streamProcessors: 0,
            roPs: 0,
            tmus: 0,
            l2Cache: 0,
            infinityCache: 0
        };
        
        try {
            // ROCm経由で詳細情報取得
            if (gpu.capabilities.rocm) {
                const { stdout } = await exec(`rocm-smi -d ${gpu.uuid.split('-').pop()} --showproductname`);
                // 詳細解析
            }
        } catch {}
        
        return details;
    }

    async getIntelGPUDetails(gpu) {
        const details = {
            euCount: 0,
            sliceCount: 0,
            subsliceCount: 0,
            threadsPerEu: 0,
            l3Cache: 0
        };
        
        try {
            // Level Zero経由で詳細情報取得
            if (gpu.capabilities.levelZero) {
                const { stdout } = await exec('level-zero-info');
                // 詳細解析
            }
        } catch {}
        
        return details;
    }

    async benchmarkAMDGPU(gpu) {
        const benchmark = {
            computeScore: 0,
            memoryBandwidth: 0,
            powerEfficiency: 0
        };
        
        try {
            // 簡易ベンチマーク実行
            if (gpu.capabilities.rocm) {
                // rocm-bandwidth-test
                const { stdout } = await exec('rocm-bandwidth-test --quick');
                // 結果解析
            }
        } catch {}
        
        return benchmark;
    }

    async benchmarkIntelGPU(gpu) {
        const benchmark = {
            computeScore: 0,
            memoryBandwidth: 0,
            quickSyncScore: 0
        };
        
        try {
            // 簡易ベンチマーク実行
            if (gpu.capabilities.levelZero) {
                // ze_peak benchmark
                const { stdout } = await exec('ze_peak');
                // 結果解析
            }
        } catch {}
        
        return benchmark;
    }

    async parseAMDGPUFromSysfs(devicePath, cardName) {
        try {
            const gpu = {
                uuid: `AMD-${cardName}`,
                vendor: 'AMD',
                name: 'AMD GPU',
                busId: await fs.readFile(path.join(devicePath, 'uevent'), 'utf8').then(
                    content => content.match(/PCI_SLOT_NAME=(.+)/)?.[1] || ''
                )
            };
            
            // hwmon経由で温度取得
            const hwmonPath = path.join(devicePath, 'hwmon');
            const hwmonDirs = await fs.readdir(hwmonPath).catch(() => []);
            if (hwmonDirs.length > 0) {
                const tempPath = path.join(hwmonPath, hwmonDirs[0], 'temp1_input');
                gpu.temperature = await fs.readFile(tempPath, 'utf8').then(
                    temp => parseInt(temp) / 1000
                ).catch(() => 0);
            }
            
            return gpu;
        } catch {
            return null;
        }
    }

    async parseIntelGPUFromSysfs(devicePath, cardName) {
        try {
            const gpu = {
                uuid: `Intel-${cardName}`,
                vendor: 'Intel',
                name: 'Intel Graphics',
                busId: await fs.readFile(path.join(devicePath, 'uevent'), 'utf8').then(
                    content => content.match(/PCI_SLOT_NAME=(.+)/)?.[1] || ''
                )
            };
            
            return gpu;
        } catch {
            return null;
        }
    }
}

module.exports = { ExtendedGPUDetector };