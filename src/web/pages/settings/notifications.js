import React, { useEffect, useState } from 'react';
import axios from 'axios';

const userId = typeof window !== 'undefined' ? localStorage.getItem('userId') : null;

const defaultSettings = {
  lineToken: '',
  discordWebhook: '',
  slackWebhook: '',
  telegramBotToken: '',
  telegramChatId: '',
  email: '',
  genericWebhook: '',
  enabled: {
    line: false,
    discord: false,
    slack: false,
    telegram: false,
    email: false,
    webhook: false,
  },
  webhooks: [],
};

const webhookEventOptions = [
  { value: 'order_created', label: '注文作成' },
  { value: 'order_paid', label: '決済完了' },
  { value: 'order_failed', label: '注文失敗' },
  { value: 'order_completed', label: '注文完了' },
  { value: 'gpu_lending', label: '貸出イベント' },
  { value: 'incident', label: '障害/異常' },
];

export default function NotificationSettings() {
  const [settings, setSettings] = useState(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [webhooks, setWebhooks] = useState([]);
  const [editingWebhook, setEditingWebhook] = useState(null);
  const [webhookForm, setWebhookForm] = useState({ event: '', url: '', enabled: true, payloadTemplate: '' });

  useEffect(() => {
    if (!userId) return;
    axios.get(`/api/notification-settings/${userId}`)
      .then(res => {
        setSettings({ ...defaultSettings, ...res.data });
        setWebhooks(res.data.webhooks || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleChange = (field, value) => {
    setSettings(prev => ({ ...prev, [field]: value }));
  };

  const handleWebhookFormChange = (field, value) => {
    setWebhookForm(prev => ({ ...prev, [field]: value }));
  };

  const handleEditWebhook = (idx) => {
    setEditingWebhook(idx);
    setWebhookForm(webhooks[idx]);
  };

  const handleDeleteWebhook = (idx) => {
    const next = webhooks.filter((_, i) => i !== idx);
    setWebhooks(next);
    setSettings(prev => ({ ...prev, webhooks: next }));
  };

  const handleAddOrUpdateWebhook = () => {
    let next;
    if (editingWebhook !== null) {
      next = webhooks.map((w, i) => i === editingWebhook ? webhookForm : w);
    } else {
      next = [...webhooks, webhookForm];
    }
    setWebhooks(next);
    setSettings(prev => ({ ...prev, webhooks: next }));
    setEditingWebhook(null);
    setWebhookForm({ event: '', url: '', enabled: true, payloadTemplate: '' });
  };

  const handleNewWebhook = () => {
    setEditingWebhook(null);
    setWebhookForm({ event: '', url: '', enabled: true, payloadTemplate: '' });
  };

  const handleEnabledChange = (channel, value) => {
    setSettings(prev => ({ ...prev, enabled: { ...prev.enabled, [channel]: value } }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      await axios.post(`/api/notification-settings/${userId}`, { ...settings, webhooks });
      setMessage('保存しました');
    } catch (err) {
      setMessage('保存に失敗しました');
    }
    setSaving(false);
  };

  if (loading) return <div>読み込み中...</div>;

  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      <h2>通知チャネル設定</h2>
      <form onSubmit={handleSubmit}>
        <label>
          <input type="checkbox" checked={settings.enabled.line} onChange={e => handleEnabledChange('line', e.target.checked)} /> LINE
        </label>
        {settings.enabled.line && (
          <input type="text" placeholder="LINEトークン" value={settings.lineToken} onChange={e => handleChange('lineToken', e.target.value)} />
        )}
        <br />
        <label>
          <input type="checkbox" checked={settings.enabled.discord} onChange={e => handleEnabledChange('discord', e.target.checked)} /> Discord
        </label>
        {settings.enabled.discord && (
          <input type="text" placeholder="Discord Webhook URL" value={settings.discordWebhook} onChange={e => handleChange('discordWebhook', e.target.value)} />
        )}
        <br />
        <label>
          <input type="checkbox" checked={settings.enabled.slack} onChange={e => handleEnabledChange('slack', e.target.checked)} /> Slack
        </label>
        {settings.enabled.slack && (
          <input type="text" placeholder="Slack Webhook URL" value={settings.slackWebhook} onChange={e => handleChange('slackWebhook', e.target.value)} />
        )}
        <br />
        <label>
          <input type="checkbox" checked={settings.enabled.telegram} onChange={e => handleEnabledChange('telegram', e.target.checked)} /> Telegram
        </label>
        {settings.enabled.telegram && (
          <>
            <input type="text" placeholder="Telegram Bot Token" value={settings.telegramBotToken} onChange={e => handleChange('telegramBotToken', e.target.value)} />
            <input type="text" placeholder="Telegram Chat ID" value={settings.telegramChatId} onChange={e => handleChange('telegramChatId', e.target.value)} />
          </>
        )}
        <br />
        <label>
          <input type="checkbox" checked={settings.enabled.email} onChange={e => handleEnabledChange('email', e.target.checked)} /> メール
        </label>
        {settings.enabled.email && (
          <input type="email" placeholder="メールアドレス" value={settings.email} onChange={e => handleChange('email', e.target.value)} />
        )}
        <br />
        <label>
          <input type="checkbox" checked={settings.enabled.webhook} onChange={e => handleEnabledChange('webhook', e.target.checked)} /> Webhook
        </label>
        {settings.enabled.webhook && (
          <input type="text" placeholder="Webhook URL" value={settings.genericWebhook} onChange={e => handleChange('genericWebhook', e.target.value)} />
        )}
        <br />
        <button type="submit" disabled={saving}>{saving ? '保存中...' : '保存'}</button>
        <div>{message}</div>
      </form>
    </div>
  );
}
