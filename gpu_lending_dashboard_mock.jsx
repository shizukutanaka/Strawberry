// gpu_lending_dashboard_mock.jsx
// Strawberry GPU貸出ダッシュボードUI（Reactコンポーネント雛形・クロスベンダー対応）

import React, { useEffect, useState } from 'react';
import axios from 'axios';

export default function GpuLendingDashboard() {
  const [gpus, setGpus] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchGPUs() {
      try {
        setLoading(true);
        const res = await axios.get('/api/gpu?owner=me'); // 自分の貸出GPU一覧取得API（要認証）
        setGpus(res.data.gpus || []);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    fetchGPUs();
  }, []);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>GPU貸出ダッシュボード</h1>
      <p>NVIDIA/AMD/Intel すべて対応・収益状況も一目で分かる！</p>
      {loading && <div>読み込み中...</div>}
      {error && <div style={{ color: 'red' }}>エラー: {error}</div>}
      <table border="1" cellPadding="8" cellSpacing="0" style={{ width: '100%', marginTop: 16 }}>
        <thead>
          <tr>
            <th>GPU名</th>
            <th>ベンダー</th>
            <th>モデル</th>
            <th>API種別</th>
            <th>稼働状況</th>
            <th>貸出収益</th>
            <th>詳細</th>
          </tr>
        </thead>
        <tbody>
          {gpus.map(gpu => (
            <tr key={gpu.id}>
              <td>{gpu.name}</td>
              <td>{gpu.vendor}</td>
              <td>{gpu.model}</td>
              <td>{gpu.apiType}</td>
              <td>{gpu.status || '不明'}</td>
              <td>{gpu.earningJPY ? `¥${gpu.earningJPY}` : '-'}<br/>{gpu.earningBTC ? `${gpu.earningBTC} BTC` : ''}</td>
              <td><button onClick={() => alert(JSON.stringify(gpu, null, 2))}>詳細</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 32 }}>
        <h2>収益グラフ（例）</h2>
        <img src="/mock/earnings_graph.png" alt="収益グラフ" width="500" />
      </div>
      <div style={{ marginTop: 32 }}>
        <h2>通知設定</h2>
        <button>Slack連携</button>
        <button>LINE連携</button>
        <button>メール通知</button>
      </div>
    </div>
  );
}
