// gpu_lending_dashboard_mock.jsx
// Strawberry GPU貸出ダッシュボードUI（Reactコンポーネント雛形・クロスベンダー対応）
//
// 実API契約（main 実装準拠）:
//   - GET /api/v1/gpus/my                … 自分の貸出GPU一覧（JWT必須。apiKey は返さない）
//       → { total, limit, offset, gpus: [{ id, name, vendor, model, apiType, pricePerHour, available, ... }] }
//   - GET /api/v1/orders/provider/earnings … プロバイダ収益サマリ（JWT + provider/admin ロール）
//       → { earnings: { completedCount, completedSats, completedJPY, activeCount, activeSats,
//                       cancelledCount, byGpu: [{ gpuId, gpuName, completedSats, completedJPY }] } }
//   認証: Authorization: Bearer <accessToken>（POST /api/v1/users/login で取得）

import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API_BASE = '/api/v1';

export default function GpuLendingDashboard({ accessToken }) {
  const [gpus, setGpus] = useState([]);
  const [earnings, setEarnings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!accessToken) return;
    const headers = { Authorization: `Bearer ${accessToken}` };
    async function fetchAll() {
      try {
        setLoading(true);
        const [gpuRes, earnRes] = await Promise.all([
          axios.get(`${API_BASE}/gpus/my`, { headers }),
          axios.get(`${API_BASE}/orders/provider/earnings`, { headers }),
        ]);
        setGpus(gpuRes.data.gpus || []);
        setEarnings(earnRes.data.earnings || null);
      } catch (e) {
        setError(e.response?.data?.error || e.message);
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, [accessToken]);

  // GPU ごとの完了収益（sats）を earnings.byGpu から引く
  const earningsByGpu = new Map(
    (earnings?.byGpu || []).map((e) => [e.gpuId, e]),
  );

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1>GPU貸出ダッシュボード</h1>
      <p>NVIDIA/AMD/Intel すべて対応・収益状況も一目で分かる！</p>

      {loading && <div>読み込み中...</div>}
      {error && <div style={{ color: 'red' }}>エラー: {error}</div>}

      {earnings && (
        <div style={{ display: 'flex', gap: 24, margin: '16px 0' }}>
          <div>完了: {earnings.completedCount} 件 / {earnings.completedSats} sats（¥{earnings.completedJPY}）</div>
          <div>進行中: {earnings.activeCount} 件（見込 {earnings.activeSats} sats）</div>
        </div>
      )}

      <table border="1" cellPadding="8" cellSpacing="0" style={{ width: '100%', marginTop: 16 }}>
        <thead>
          <tr>
            <th>GPU名</th>
            <th>ベンダー</th>
            <th>モデル</th>
            <th>API種別</th>
            <th>時給 (sats)</th>
            <th>稼働状況</th>
            <th>完了収益</th>
          </tr>
        </thead>
        <tbody>
          {gpus.map(gpu => {
            const e = earningsByGpu.get(gpu.id);
            return (
              <tr key={gpu.id}>
                <td>{gpu.name}</td>
                <td>{gpu.vendor}</td>
                <td>{gpu.model}</td>
                <td>{gpu.apiType}</td>
                <td>{gpu.pricePerHour}</td>
                <td>{gpu.available === false ? 'オフライン' : '貸出中'}</td>
                <td>{e ? `${e.completedSats} sats（¥${e.completedJPY}）` : '-'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 32 }}>
        <h2>通知設定</h2>
        {/* 実経路: GET/POST /api/v1/notification-settings/:userId（JWT・本人のみ）。
            Slack/LINE/Discord/Telegram/Email/イベント別 Webhook を enabled マップで切替 */}
        <button>Slack連携</button>
        <button>LINE連携</button>
        <button>メール通知</button>
      </div>
    </div>
  );
}
