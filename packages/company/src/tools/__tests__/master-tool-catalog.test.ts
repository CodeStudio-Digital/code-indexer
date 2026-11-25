import { expect, it, vi } from 'vitest';
import type { CompanyOrchestratorPort } from '../../orchestrator-port.js';
import type { SandboxBinding } from '../../types.js';
import { buildMasterTools } from '../master-tools.js';

const driver = {
  inspectContainer: vi.fn(async () => ({ exists: true, running: false, paused: false })),
  getContainerState: vi.fn(async () => ({ exitCode: 1 })),
  getContainerLogs: vi.fn(async () => 'last diagnostic'),
};
const binding = (serviceId: string) => ({ serviceId, containerId: serviceId, driver }) as unknown as SandboxBinding;

function catalog(primary: SandboxBinding | null, services: Array<{ serviceId: string; binding: SandboxBinding }> = []) {
  const orch = {
    getSandboxBinding: () => primary,
    getSandboxServiceBinding: (id: string) => services.find(service => service.serviceId === id)?.binding,
    sandboxService: { listServiceBindings: () => services },
  } as unknown as CompanyOrchestratorPort;
  return buildMasterTools(orch);
}

it('advertises event-driven delegation without a fleet wait or container tools on a local project', () => {
  const tools = catalog(null);
  expect(tools.find(tool => tool.name === 'spawn_subordinate_agent')?.description).toContain('wakes you');
  for (const name of ['wait_for_subordinates', 'list_containers', 'read_container_logs']) {
    expect(tools.some(tool => tool.name === name)).toBe(false);
  }
});

it.each(['primary', 'secondary'])('can diagnose a stopped %s container by the ID returned in the listing', async (kind: string) => {
  const service = binding('backend');
  const tools = kind === 'primary' ? catalog(service) : catalog(null, [{ serviceId: 'backend', binding: service }]);
  const listing = await tools.find(tool => tool.name === 'list_containers')!.handler({}, {} as never);
  expect(listing.content).toMatch(/backend\s+stopped/);
  const logs = await tools.find(tool => tool.name === 'read_container_logs')!.handler({ service_id: 'backend' }, {} as never);
  expect(logs.content).toBe('last diagnostic');
});
