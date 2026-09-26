// §7: テナントコンテナの既定ハードニング（CIS Docker / k8s PSS restricted）。
const { VirtualGPUManager } = require('../../virtual-gpu-manager');

// /var/lib/strawberry への実 mkdir を防ぐ（テスト環境は権限なし）。
jest.spyOn(require('fs').promises, 'mkdir').mockResolvedValue(undefined);

function makeManager() {
  const m = Object.create(VirtualGPUManager.prototype);
  m.containers = new Map();
  const calls = { createContainer: [], createNamespacedPod: [] };
  m.docker = {
    createContainer: async (cfg) => {
      calls.createContainer.push(cfg);
      return { id: 'cid123', start: async () => {} };
    },
  };
  m.k8sApi = {
    createNamespacedConfigMap: async () => ({}),
    createNamespacedPod: async (ns, manifest) => {
      calls.createNamespacedPod.push(manifest);
      return { body: { metadata: { name: 'pod-x', namespace: ns } } };
    },
  };
  m.getGPUIndex = () => 0;
  m.calculateGPUFraction = () => 1;
  return { m, calls };
}

const physicalGPU = { id: 'gpu1', name: 'RTX 4090', model: { series: 'RTX 40' } };

describe('vgpu container hardening (§7)', () => {
  it('docker: hardened by default', async () => {
    const { m, calls } = makeManager();
    await m.createDockerVirtualGPU(physicalGPU, {}, 'v1');
    const hc = calls.createContainer[0].HostConfig;
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.SecurityOpt).toContain('no-new-privileges:true');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.PidsLimit).toBe(512);
    expect(hc.Tmpfs['/tmp']).toContain('noexec');
    expect(hc.Privileged).toBe(false);
  });

  it('docker: config.hardening=false opts out', async () => {
    const { m, calls } = makeManager();
    await m.createDockerVirtualGPU(physicalGPU, { hardening: false }, 'v2');
    const hc = calls.createContainer[0].HostConfig;
    expect(hc.CapDrop).toBeUndefined();
    expect(hc.ReadonlyRootfs).toBeUndefined();
  });

  it('k8s: restricted securityContext + emptyDir /tmp + no SA token', async () => {
    const { m, calls } = makeManager();
    await m.createK8sVirtualGPU(physicalGPU, {}, 'v3');
    const pod = calls.createNamespacedPod[0];
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.securityContext.seccompProfile.type).toBe('RuntimeDefault');
    const sc = pod.spec.containers[0].securityContext;
    expect(sc.allowPrivilegeEscalation).toBe(false);
    expect(sc.readOnlyRootFilesystem).toBe(true);
    expect(sc.capabilities.drop).toContain('ALL');
    expect(pod.spec.volumes.map((v) => v.name)).toContain('tmp');
  });
});
