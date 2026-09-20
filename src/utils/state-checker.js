// src/utils/state-checker.js - 状態遷移チェックヘルパー
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

module.exports = {
  isValidOrderTransition
};
