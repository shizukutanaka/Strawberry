// GPU仮想化・リソース割当/解放・競合制御クラス雛形
class VirtualGPUManager {
  constructor() {
    this.gpus = []; // 物理GPU一覧 [{uuid, busy, assignedTo}]
  }

  registerPhysicalGPUs(gpuList) {
    this.gpus = gpuList.map(gpu => ({ ...gpu, busy: false, assignedTo: null }));
  }

  allocate(userId) {
    const free = this.gpus.find(g => !g.busy);
    if (!free) return null;
    free.busy = true;
    free.assignedTo = userId;
    return free;
  }

  release(gpuUuid) {
    const gpu = this.gpus.find(g => g.uuid === gpuUuid);
    if (gpu) {
      gpu.busy = false;
      gpu.assignedTo = null;
      return true;
    }
    return false;
  }

  getAssigned(userId) {
    return this.gpus.filter(g => g.assignedTo === userId);
  }

  getStatus() {
    return this.gpus.map(g => ({ uuid: g.uuid, busy: g.busy, assignedTo: g.assignedTo }));
  }
}

module.exports = { VirtualGPUManager };
