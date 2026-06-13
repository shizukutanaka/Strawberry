// src/utils/state-checker.js - 状態遷移チェックヘルパー
const ORDER_STATES = ['pending', 'matched', 'active', 'completed', 'cancelled', 'disputed'];
const GPU_STATES = ['available', 'allocated', 'maintenance', 'offline'];

function isValidOrderTransition(from, to) {
  const allowed = {
    pending: ['matched', 'cancelled'],
    matched: ['active', 'cancelled', 'disputed'],
    active: ['completed', 'cancelled', 'disputed'],
    disputed: ['completed', 'cancelled'],
    completed: [],
    cancelled: []
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
