// src/utils/state-checker.js - 状態遷移チェックヘルパー
const ORDER_STATES = ['pending', 'matched', 'active', 'completed', 'cancelled', 'disputed', 'preempted'];
const GPU_STATES = ['available', 'allocated', 'maintenance', 'offline'];

function isValidOrderTransition(from, to) {
  const allowed = {
    pending: ['matched', 'cancelled'],
    matched: ['active', 'cancelled', 'disputed'],
    active: ['completed', 'cancelled', 'disputed'],
    disputed: ['completed', 'cancelled'],
    // 'preempted' は専用ルート POST /:id/preempt のみが到達（spot 注文の中断）。
    // ここでは遷移先が無い終端として定義し、PUT 経由での操作を構造的に封じる。
    completed: [],
    cancelled: [],
    preempted: []
  };
  return allowed[from] && allowed[from].includes(to);
}

function isValidGPUTransition(from, to) {
  const allowed = {
    available: ['allocated', 'maintenance', 'offline'],
    allocated: ['available', 'maintenance', 'offline'],
    maintenance: ['available', 'offline'],
    offline: ['available']
  };
  return allowed[from] && allowed[from].includes(to);
}

module.exports = {
  ORDER_STATES,
  GPU_STATES,
  isValidOrderTransition,
  isValidGPUTransition
};
