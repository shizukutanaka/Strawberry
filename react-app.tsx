import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Zap, Cpu, DollarSign, Activity, Settings, Bell, 
  Monitor, TrendingUp, Shield, Network, Database,
  Power, Thermometer, Clock, AlertCircle, CheckCircle,
  ChevronRight, RefreshCw, PlayCircle, StopCircle,
  Download, Upload, Bitcoin, CreditCard, Wallet
} from 'lucide-react';

// メインアプリケーションコンポーネント
const App = () => {
  // 状態管理
  const [activeTab, setActiveTab] = useState('dashboard');
  const [localGPUs, setLocalGPUs] = useState([]);
  const [availableGPUs, setAvailableGPUs] = useState([]);
  const [activeRentals, setActiveRentals] = useState([]);
  const [systemStats, setSystemStats] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [settings, setSettings] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Strawberry API (Electronで提供)
  const api = window.strawberryAPI;

  // 初期化
  useEffect(() => {
    const initialize = async () => {
      try {
        setIsLoading(true);
        
        // データ取得
        const [gpus, stats, userSettings, notifs] = await Promise.all([
          api.gpu.getLocalGPUs(),
          api.data.getSystemStats(),
          api.user.getSettings(),
          api.notification.getNotifications()
        ]);

        setLocalGPUs(gpus);
        setSystemStats(stats);
        setSettings(userSettings);
        setNotifications(notifs);

        // 利用可能なGPU取得
        const available = await api.gpu.getAvailableGPUs({});
        setAvailableGPUs(available);

      } catch (error) {
        console.error('Initialization error:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initialize();

    // イベントリスナー設定
    const unsubscribers = [];

    unsubscribers.push(
      api.on('gpu:status:changed', (data) => {
        setLocalGPUs(prev => 
          prev.map(gpu => gpu.id === data.gpuId ? { ...gpu, status: data.status } : gpu)
        );
      })
    );

    unsubscribers.push(
      api.on('payment:received', (payment) => {
        setNotifications(prev => [{
          id: Date.now(),
          type: 'payment',
          title: 'Payment Received',
          message: `Received ${payment.amount} sats`,
          timestamp: new Date()
        }, ...prev]);
      })
    );

    // クリーンアップ
    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, []);

  // 定期的な更新
  useEffect(() => {
    const interval = setInterval(async () => {
      if (!refreshing) {
        const stats = await api.data.getSystemStats();
        setSystemStats(stats);
        
        // GPUステータス更新
        for (const gpu of localGPUs) {
          const status = await api.gpu.getGPUStatus(gpu.id);
          setLocalGPUs(prev => 
            prev.map(g => g.id === gpu.id ? { ...g, ...status } : g)
          );
        }
      }
    }, 30000); // 30秒ごと

    return () => clearInterval(interval);
  }, [localGPUs, refreshing]);

  // リフレッシュ処理
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [gpus, available, stats] = await Promise.all([
        api.gpu.refreshGPUs(),
        api.gpu.getAvailableGPUs({}),
        api.data.getSystemStats()
      ]);
      
      setLocalGPUs(gpus);
      setAvailableGPUs(available);
      setSystemStats(stats);
    } catch (error) {
      console.error('Refresh error:', error);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // GPU貸出開始
  const startGPULending = useCallback(async (gpuId, pricing) => {
    try {
      const result = await api.gpu.startLending(gpuId, pricing);
      if (result.success) {
        await handleRefresh();
      }
      return result;
    } catch (error) {
      console.error('Start lending error:', error);
      return { success: false, error: error.message };
    }
  }, [handleRefresh]);

  // GPU貸出停止
  const stopGPULending = useCallback(async (gpuId) => {
    try {
      const result = await api.gpu.stopLending(gpuId);
      if (result.success) {
        await handleRefresh();
      }
      return result;
    } catch (error) {
      console.error('Stop lending error:', error);
      return { success: false, error: error.message };
    }
  }, [handleRefresh]);

  // GPU借用
  const rentGPU = useCallback(async (gpuId, duration) => {
    try {
      const result = await api.gpu.rentGPU(gpuId, duration);
      if (result.success) {
        setActiveRentals(prev => [...prev, result.rental]);
      }
      return result;
    } catch (error) {
      console.error('Rent GPU error:', error);
      return { success: false, error: error.message };
    }
  }, []);

  // ナビゲーション
  const navigation = [
    { id: 'dashboard', label: 'Dashboard', icon: Activity },
    { id: 'my-gpus', label: 'My GPUs', icon: Cpu },
    { id: 'marketplace', label: 'Marketplace', icon: Monitor },
    { id: 'rentals', label: 'Rentals', icon: Clock },
    { id: 'earnings', label: 'Earnings', icon: TrendingUp },
    { id: 'wallet', label: 'Wallet', icon: Wallet },
    { id: 'settings', label: 'Settings', icon: Settings }
  ];

  // ローディング表示
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-pink-500 mx-auto mb-4"></div>
          <p className="text-gray-400">Loading Strawberry GPU Marketplace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      {/* サイドバー */}
      <div className="w-64 bg-gray-800 border-r border-gray-700">
        <div className="p-6">
          <div className="flex items-center space-x-3 mb-8">
            <div className="w-10 h-10 bg-gradient-to-br from-pink-500 to-red-600 rounded-lg flex items-center justify-center">
              <Zap className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Strawberry</h1>
              <p className="text-xs text-gray-400">GPU Marketplace</p>
            </div>
          </div>

          <nav className="space-y-2">
            {navigation.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
                  activeTab === id
                    ? 'bg-gray-700 text-white'
                    : 'text-gray-400 hover:bg-gray-700/50 hover:text-white'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gray-400">Network Status</span>
            <div className="flex items-center space-x-1">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <span className="text-xs text-green-500">Online</span>
            </div>
          </div>
          <div className="text-xs text-gray-500">
            {systemStats?.network?.connectedPeers || 0} peers connected
          </div>
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-hidden">
        {/* ヘッダー */}
        <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <h2 className="text-2xl font-bold">
                {navigation.find(n => n.id === activeTab)?.label}
              </h2>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="p-2 rounded-lg hover:bg-gray-700 transition-colors"
              >
                <RefreshCw className={`w-5 h-5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex items-center space-x-4">
              {/* 通知 */}
              <button className="relative p-2 rounded-lg hover:bg-gray-700 transition-colors">
                <Bell className="w-5 h-5" />
                {notifications.length > 0 && (
                  <span className="absolute top-0 right-0 w-2 h-2 bg-pink-500 rounded-full"></span>
                )}
              </button>

              {/* ウォレット残高 */}
              <div className="flex items-center space-x-2 px-4 py-2 bg-gray-700 rounded-lg">
                <Bitcoin className="w-4 h-4 text-yellow-500" />
                <span className="text-sm font-mono">
                  {systemStats?.lightning?.channelBalance?.balance || 0} sats
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* コンテンツエリア */}
        <main className="flex-1 overflow-y-auto p-6">
          {activeTab === 'dashboard' && (
            <Dashboard 
              systemStats={systemStats}
              localGPUs={localGPUs}
              activeRentals={activeRentals}
            />
          )}
          
          {activeTab === 'my-gpus' && (
            <MyGPUs 
              gpus={localGPUs}
              onStartLending={startGPULending}
              onStopLending={stopGPULending}
            />
          )}
          
          {activeTab === 'marketplace' && (
            <Marketplace 
              availableGPUs={availableGPUs}
              onRentGPU={rentGPU}
            />
          )}
          
          {activeTab === 'rentals' && (
            <Rentals 
              activeRentals={activeRentals}
              api={api}
            />
          )}
          
          {activeTab === 'earnings' && (
            <Earnings 
              api={api}
            />
          )}
          
          {activeTab === 'wallet' && (
            <Wallet 
              api={api}
            />
          )}
          
          {activeTab === 'settings' && (
            <Settings 
              settings={settings}
              onSave={async (newSettings) => {
                await api.user.saveSettings(newSettings);
                setSettings(newSettings);
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
};

// ダッシュボードコンポーネント
const Dashboard = ({ systemStats, localGPUs, activeRentals }) => {
  const stats = useMemo(() => {
    if (!systemStats) return null;
    
    return {
      totalGPUs: localGPUs.length,
      activeGPUs: localGPUs.filter(g => g.status === 'lending').length,
      activeRentals: activeRentals.length,
      todayEarnings: systemStats.todayEarnings || 0,
      totalEarnings: systemStats.totalEarnings || 0,
      avgGPUTemp: localGPUs.reduce((acc, gpu) => acc + (gpu.temperature || 0), 0) / localGPUs.length || 0,
      avgGPUUtil: localGPUs.reduce((acc, gpu) => acc + (gpu.utilization || 0), 0) / localGPUs.length || 0
    };
  }, [systemStats, localGPUs, activeRentals]);

  if (!stats) return null;

  return (
    <div className="space-y-6">
      {/* 統計カード */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard
          title="Total GPUs"
          value={stats.totalGPUs}
          icon={Cpu}
          color="blue"
          subtitle={`${stats.activeGPUs} active`}
        />
        <StatCard
          title="Active Rentals"
          value={stats.activeRentals}
          icon={Clock}
          color="green"
        />
        <StatCard
          title="Today's Earnings"
          value={`$${stats.todayEarnings.toFixed(2)}`}
          icon={DollarSign}
          color="yellow"
        />
        <StatCard
          title="Total Earnings"
          value={`$${stats.totalEarnings.toFixed(2)}`}
          icon={TrendingUp}
          color="purple"
        />
      </div>

      {/* GPU状態 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">GPU Performance</h3>
          <div className="space-y-4">
            <MetricBar
              label="Average Temperature"
              value={stats.avgGPUTemp}
              max={100}
              unit="°C"
              color={stats.avgGPUTemp > 80 ? 'red' : stats.avgGPUTemp > 70 ? 'yellow' : 'green'}
            />
            <MetricBar
              label="Average Utilization"
              value={stats.avgGPUUtil}
              max={100}
              unit="%"
              color="blue"
            />
          </div>
        </div>

        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-lg font-semibold mb-4">Recent Activity</h3>
          <div className="space-y-3">
            {activeRentals.slice(0, 5).map((rental, index) => (
              <div key={index} className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <div>
                    <p className="text-sm">{rental.gpu.name}</p>
                    <p className="text-xs text-gray-400">Started {new Date(rental.startTime).toLocaleTimeString()}</p>
                  </div>
                </div>
                <span className="text-sm font-mono">${rental.hourlyRate}/hr</span>
              </div>
            ))}
            {activeRentals.length === 0 && (
              <p className="text-gray-400 text-center py-4">No active rentals</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// My GPUs コンポーネント
const MyGPUs = ({ gpus, onStartLending, onStopLending }) => {
  const [selectedGPU, setSelectedGPU] = useState(null);
  const [pricingModal, setPricingModal] = useState(false);
  const [pricing, setPricing] = useState({ hourlyRate: 0.5, minimumDuration: 1 });

  const handleStartLending = async () => {
    if (selectedGPU) {
      const result = await onStartLending(selectedGPU.id, pricing);
      if (result.success) {
        setPricingModal(false);
        setSelectedGPU(null);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {gpus.map((gpu) => (
          <div key={gpu.id} className="bg-gray-800 rounded-lg p-6 border border-gray-700">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold">{gpu.name}</h3>
                <p className="text-sm text-gray-400">{gpu.vram} MB VRAM</p>
              </div>
              <StatusBadge status={gpu.status} />
            </div>

            <div className="space-y-3 mb-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Temperature</span>
                <span className={gpu.temperature > 80 ? 'text-red-500' : 'text-white'}>
                  {gpu.temperature || 0}°C
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Utilization</span>
                <span>{gpu.utilization || 0}%</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Power Draw</span>
                <span>{gpu.powerDraw || 0}W</span>
              </div>
            </div>

            {gpu.status === 'available' ? (
              <button
                onClick={() => {
                  setSelectedGPU(gpu);
                  setPricingModal(true);
                }}
                className="w-full bg-green-600 hover:bg-green-700 text-white py-2 px-4 rounded-lg transition-colors flex items-center justify-center space-x-2"
              >
                <PlayCircle className="w-4 h-4" />
                <span>Start Lending</span>
              </button>
            ) : gpu.status === 'lending' ? (
              <button
                onClick={() => onStopLending(gpu.id)}
                className="w-full bg-red-600 hover:bg-red-700 text-white py-2 px-4 rounded-lg transition-colors flex items-center justify-center space-x-2"
              >
                <StopCircle className="w-4 h-4" />
                <span>Stop Lending</span>
              </button>
            ) : (
              <button
                disabled
                className="w-full bg-gray-700 text-gray-400 py-2 px-4 rounded-lg cursor-not-allowed"
              >
                {gpu.status}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 価格設定モーダル */}
      {pricingModal && selectedGPU && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-96 border border-gray-700">
            <h3 className="text-xl font-semibold mb-4">Set Lending Price</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-2">Hourly Rate (USD)</label>
                <input
                  type="number"
                  value={pricing.hourlyRate}
                  onChange={(e) => setPricing({ ...pricing, hourlyRate: parseFloat(e.target.value) })}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  min="0.1"
                  step="0.1"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-2">Minimum Duration (hours)</label>
                <input
                  type="number"
                  value={pricing.minimumDuration}
                  onChange={(e) => setPricing({ ...pricing, minimumDuration: parseInt(e.target.value) })}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  min="1"
                  step="1"
                />
              </div>
            </div>
            <div className="flex space-x-3 mt-6">
              <button
                onClick={handleStartLending}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white py-2 px-4 rounded-lg transition-colors"
              >
                Start Lending
              </button>
              <button
                onClick={() => {
                  setPricingModal(false);
                  setSelectedGPU(null);
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// マーケットプレイスコンポーネント
const Marketplace = ({ availableGPUs, onRentGPU }) => {
  const [filters, setFilters] = useState({
    minVRAM: 0,
    maxPrice: 100,
    gpuModel: ''
  });
  const [selectedGPU, setSelectedGPU] = useState(null);
  const [rentalDuration, setRentalDuration] = useState(1);

  const filteredGPUs = useMemo(() => {
    return availableGPUs.filter(gpu => {
      if (filters.minVRAM && gpu.vram < filters.minVRAM) return false;
      if (filters.maxPrice && gpu.pricing?.hourlyRate > filters.maxPrice) return false;
      if (filters.gpuModel && !gpu.name.toLowerCase().includes(filters.gpuModel.toLowerCase())) return false;
      return true;
    });
  }, [availableGPUs, filters]);

  const handleRent = async () => {
    if (selectedGPU) {
      const result = await onRentGPU(selectedGPU.id, rentalDuration);
      if (result.success) {
        setSelectedGPU(null);
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* フィルター */}
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Minimum VRAM (GB)</label>
            <input
              type="number"
              value={filters.minVRAM / 1024}
              onChange={(e) => setFilters({ ...filters, minVRAM: parseFloat(e.target.value) * 1024 })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
              min="0"
              step="1"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">Max Price ($/hr)</label>
            <input
              type="number"
              value={filters.maxPrice}
              onChange={(e) => setFilters({ ...filters, maxPrice: parseFloat(e.target.value) })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
              min="0"
              step="0.1"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">GPU Model</label>
            <input
              type="text"
              value={filters.gpuModel}
              onChange={(e) => setFilters({ ...filters, gpuModel: e.target.value })}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
              placeholder="e.g. RTX 4090"
            />
          </div>
        </div>
      </div>

      {/* GPU リスト */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
        {filteredGPUs.map((gpu) => (
          <div key={gpu.id} className="bg-gray-800 rounded-lg p-6 border border-gray-700 hover:border-pink-500 transition-colors">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold">{gpu.name}</h3>
                <p className="text-sm text-gray-400">{(gpu.vram / 1024).toFixed(0)} GB VRAM</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold text-green-500">
                  ${gpu.pricing?.hourlyRate || 0}/hr
                </p>
                <p className="text-xs text-gray-400">Min {gpu.pricing?.minimumDuration || 1}h</p>
              </div>
            </div>

            <div className="space-y-2 mb-4">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Performance</span>
                <div className="flex items-center space-x-1">
                  {[...Array(5)].map((_, i) => (
                    <div
                      key={i}
                      className={`w-2 h-2 rounded-full ${
                        i < Math.floor((gpu.performance?.score || 0) / 20)
                          ? 'bg-green-500'
                          : 'bg-gray-600'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Region</span>
                <span>{gpu.region || 'Unknown'}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-400">Latency</span>
                <span className={gpu.latency < 50 ? 'text-green-500' : gpu.latency < 100 ? 'text-yellow-500' : 'text-red-500'}>
                  {gpu.latency || 0}ms
                </span>
              </div>
            </div>

            <button
              onClick={() => setSelectedGPU(gpu)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg transition-colors"
            >
              Rent GPU
            </button>
          </div>
        ))}
      </div>

      {/* レンタルモーダル */}
      {selectedGPU && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 w-96 border border-gray-700">
            <h3 className="text-xl font-semibold mb-4">Rent GPU</h3>
            <div className="space-y-4">
              <div>
                <p className="text-sm text-gray-400">GPU</p>
                <p className="font-semibold">{selectedGPU.name}</p>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-2">Duration (hours)</label>
                <input
                  type="number"
                  value={rentalDuration}
                  onChange={(e) => setRentalDuration(parseInt(e.target.value))}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                  min={selectedGPU.pricing?.minimumDuration || 1}
                  step="1"
                />
              </div>
              <div className="bg-gray-700 rounded-lg p-4">
                <div className="flex justify-between mb-2">
                  <span className="text-gray-400">Rate</span>
                  <span>${selectedGPU.pricing?.hourlyRate}/hr</span>
                </div>
                <div className="flex justify-between mb-2">
                  <span className="text-gray-400">Duration</span>
                  <span>{rentalDuration} hours</span>
                </div>
                <div className="border-t border-gray-600 pt-2 mt-2">
                  <div className="flex justify-between font-semibold">
                    <span>Total</span>
                    <span className="text-green-500">
                      ${(selectedGPU.pricing?.hourlyRate * rentalDuration).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex space-x-3 mt-6">
              <button
                onClick={handleRent}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg transition-colors"
              >
                Confirm Rental
              </button>
              <button
                onClick={() => setSelectedGPU(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Rentals コンポーネント
const Rentals = ({ activeRentals, api }) => {
  const [rentalHistory, setRentalHistory] = useState([]);

  useEffect(() => {
    const fetchHistory = async () => {
      const history = await api.data.getRentalHistory({ limit: 50 });
      setRentalHistory(history);
    };
    fetchHistory();
  }, [api]);

  const stopRental = async (rentalId) => {
    const result = await api.gpu.stopRental(rentalId);
    if (result.success) {
      // 更新処理
    }
  };

  return (
    <div className="space-y-6">
      {/* アクティブレンタル */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Active Rentals</h3>
        <div className="bg-gray-800 rounded-lg border border-gray-700">
          {activeRentals.length > 0 ? (
            <div className="divide-y divide-gray-700">
              {activeRentals.map((rental) => (
                <div key={rental.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold">{rental.gpu.name}</h4>
                      <p className="text-sm text-gray-400">
                        Started: {new Date(rental.startTime).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center space-x-4">
                      <div className="text-right">
                        <p className="text-lg font-semibold">${rental.hourlyRate}/hr</p>
                        <p className="text-sm text-gray-400">
                          {Math.floor((Date.now() - rental.startTime) / (1000 * 60 * 60))}h used
                        </p>
                      </div>
                      <button
                        onClick={() => stopRental(rental.id)}
                        className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors"
                      >
                        Stop
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-gray-400">
              No active rentals
            </div>
          )}
        </div>
      </div>

      {/* レンタル履歴 */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Rental History</h3>
        <div className="bg-gray-800 rounded-lg border border-gray-700">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-gray-700">
                <tr className="text-left">
                  <th className="px-4 py-3 text-sm text-gray-400">GPU</th>
                  <th className="px-4 py-3 text-sm text-gray-400">Duration</th>
                  <th className="px-4 py-3 text-sm text-gray-400">Cost</th>
                  <th className="px-4 py-3 text-sm text-gray-400">Date</th>
                  <th className="px-4 py-3 text-sm text-gray-400">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {rentalHistory.map((rental, index) => (
                  <tr key={index}>
                    <td className="px-4 py-3">{rental.gpu_name}</td>
                    <td className="px-4 py-3">{rental.duration}h</td>
                    <td className="px-4 py-3">${rental.total_cost}</td>
                    <td className="px-4 py-3">{new Date(rental.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={rental.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

// Earnings コンポーネント
const Earnings = ({ api }) => {
  const [earnings, setEarnings] = useState(null);
  const [timeRange, setTimeRange] = useState('week');

  useEffect(() => {
    const fetchEarnings = async () => {
      const report = await api.data.getEarningsReport(timeRange);
      setEarnings(report);
    };
    fetchEarnings();
  }, [api, timeRange]);

  return (
    <div className="space-y-6">
      {/* 時間範囲選択 */}
      <div className="flex space-x-2">
        {['day', 'week', 'month', 'year'].map((range) => (
          <button
            key={range}
            onClick={() => setTimeRange(range)}
            className={`px-4 py-2 rounded-lg transition-colors ${
              timeRange === range
                ? 'bg-pink-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {range.charAt(0).toUpperCase() + range.slice(1)}
          </button>
        ))}
      </div>

      {/* 収益サマリー */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <h3 className="text-sm text-gray-400 mb-2">Total Revenue</h3>
          <p className="text-3xl font-bold">${earnings?.totalRevenue || 0}</p>
          <p className="text-sm text-green-500 mt-2">
            +{earnings?.revenueGrowth || 0}% from previous period
          </p>
        </div>
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <h3 className="text-sm text-gray-400 mb-2">Active Hours</h3>
          <p className="text-3xl font-bold">{earnings?.activeHours || 0}h</p>
          <p className="text-sm text-gray-400 mt-2">
            {earnings?.utilizationRate || 0}% utilization
          </p>
        </div>
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <h3 className="text-sm text-gray-400 mb-2">Avg Rate</h3>
          <p className="text-3xl font-bold">${earnings?.avgHourlyRate || 0}/hr</p>
          <p className="text-sm text-gray-400 mt-2">
            {earnings?.totalRentals || 0} rentals
          </p>
        </div>
      </div>

      {/* 収益チャート（プレースホルダー） */}
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-4">Revenue Over Time</h3>
        <div className="h-64 flex items-center justify-center text-gray-400">
          Chart visualization would go here
        </div>
      </div>
    </div>
  );
};

// Wallet コンポーネント
const Wallet = ({ api }) => {
  const [balance, setBalance] = useState(null);
  const [channels, setChannels] = useState([]);
  const [invoiceAmount, setInvoiceAmount] = useState('');
  const [paymentRequest, setPaymentRequest] = useState('');

  useEffect(() => {
    const fetchWalletData = async () => {
      const [bal, chans] = await Promise.all([
        api.payment.getBalance(),
        api.payment.getChannels()
      ]);
      setBalance(bal);
      setChannels(chans);
    };
    fetchWalletData();
  }, [api]);

  const createInvoice = async () => {
    const result = await api.payment.createInvoice(parseFloat(invoiceAmount), 'Strawberry GPU Payment');
    if (result.paymentRequest) {
      // 請求書作成成功
    }
  };

  const payInvoice = async () => {
    const result = await api.payment.payInvoice(paymentRequest);
    if (result.success) {
      // 支払い成功
    }
  };

  return (
    <div className="space-y-6">
      {/* 残高 */}
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-4">Lightning Wallet</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <p className="text-sm text-gray-400">Total Balance</p>
            <p className="text-2xl font-bold">{balance?.total || 0} sats</p>
          </div>
          <div>
            <p className="text-sm text-gray-400">Can Send</p>
            <p className="text-2xl font-bold text-green-500">{balance?.canSend || 0} sats</p>
          </div>
          <div>
            <p className="text-sm text-gray-400">Can Receive</p>
            <p className="text-2xl font-bold text-blue-500">{balance?.canReceive || 0} sats</p>
          </div>
        </div>
      </div>

      {/* アクション */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 請求書作成 */}
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <h3 className="text-lg font-semibold mb-4">Create Invoice</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Amount (USD)</label>
              <input
                type="number"
                value={invoiceAmount}
                onChange={(e) => setInvoiceAmount(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white"
                placeholder="0.00"
              />
            </div>
            <button
              onClick={createInvoice}
              className="w-full bg-green-600 hover:bg-green-700 text-white py-2 px-4 rounded-lg transition-colors"
            >
              Create Invoice
            </button>
          </div>
        </div>

        {/* 支払い */}
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <h3 className="text-lg font-semibold mb-4">Send Payment</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Lightning Invoice</label>
              <textarea
                value={paymentRequest}
                onChange={(e) => setPaymentRequest(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white font-mono text-xs"
                rows="3"
                placeholder="lnbc..."
              />
            </div>
            <button
              onClick={payInvoice}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded-lg transition-colors"
            >
              Send Payment
            </button>
          </div>
        </div>
      </div>

      {/* チャネル */}
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-4">Lightning Channels</h3>
        <div className="space-y-3">
          {channels.map((channel, index) => (
            <div key={index} className="flex items-center justify-between py-3 border-b border-gray-700 last:border-0">
              <div>
                <p className="text-sm font-mono">{channel.remotePubkey?.substring(0, 16)}...</p>
                <p className="text-xs text-gray-400">Capacity: {channel.capacity} sats</p>
              </div>
              <div className="text-right">
                <p className="text-sm">Local: {channel.localBalance} sats</p>
                <p className="text-sm text-gray-400">Remote: {channel.remoteBalance} sats</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Settings コンポーネント
const Settings = ({ settings, onSave }) => {
  const [localSettings, setLocalSettings] = useState(settings);

  const handleSave = () => {
    onSave(localSettings);
  };

  return (
    <div className="space-y-6">
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <h3 className="text-lg font-semibold mb-4">General Settings</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Minimize to Tray</p>
              <p className="text-sm text-gray-400">Keep app running in system tray when closed</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={localSettings.minimizeToTray}
                onChange={(e) => setLocalSettings({ ...localSettings, minimizeToTray: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-600"></div>
            </label>
          </div>
          
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Auto Start</p>
              <p className="text-sm text-gray-400">Start Strawberry when system boots</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={localSettings.autoStart}
                onChange={(e) => setLocalSettings({ ...localSettings, autoStart: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-600"></div>
            </label>
          </div>
          
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Notifications</p>
              <p className="text-sm text-gray-400">Show desktop notifications</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={localSettings.notifications}
                onChange={(e) => setLocalSettings({ ...localSettings, notifications: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-600"></div>
            </label>
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        className="bg-pink-600 hover:bg-pink-700 text-white px-6 py-3 rounded-lg transition-colors"
      >
        Save Settings
      </button>
    </div>
  );
};

// ユーティリティコンポーネント
const StatCard = ({ title, value, icon: Icon, color, subtitle }) => {
  const colorClasses = {
    blue: 'bg-blue-500/10 text-blue-500',
    green: 'bg-green-500/10 text-green-500',
    yellow: 'bg-yellow-500/10 text-yellow-500',
    purple: 'bg-purple-500/10 text-purple-500'
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <div className={`p-3 rounded-lg ${colorClasses[color]}`}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
      <p className="text-3xl font-bold mb-1">{value}</p>
      <p className="text-sm text-gray-400">{title}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
};

const StatusBadge = ({ status }) => {
  const statusConfig = {
    available: { color: 'bg-green-500/10 text-green-500', label: 'Available' },
    lending: { color: 'bg-blue-500/10 text-blue-500', label: 'Lending' },
    rented: { color: 'bg-yellow-500/10 text-yellow-500', label: 'Rented' },
    offline: { color: 'bg-gray-500/10 text-gray-500', label: 'Offline' },
    active: { color: 'bg-green-500/10 text-green-500', label: 'Active' },
    completed: { color: 'bg-gray-500/10 text-gray-500', label: 'Completed' }
  };

  const config = statusConfig[status] || statusConfig.offline;

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
      {config.label}
    </span>
  );
};

const MetricBar = ({ label, value, max, unit, color }) => {
  const percentage = (value / max) * 100;
  
  const colorClasses = {
    green: 'bg-green-500',
    yellow: 'bg-yellow-500',
    red: 'bg-red-500',
    blue: 'bg-blue-500'
  };

  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-gray-400">{label}</span>
        <span>{value}{unit}</span>
      </div>
      <div className="w-full bg-gray-700 rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all ${colorClasses[color]}`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  );
};

export default App;