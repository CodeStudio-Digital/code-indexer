import { describe, expect, it, vi } from 'vitest';
import { SandboxRegistry } from '../../state/registry.js';
import { WorkspaceIO } from '../workspace-io.js';
import type { Sandbox } from '../../../types.js';
import type { ISandboxDriver } from '../../../ports/sandbox-driver.js';

describe('WorkspaceIO unprovisioned sessions', () => {
  it('reports no sandbox before inspecting the driver for primary and service operations', async () => {
    const getDriver = vi.fn(() => null);
    const io = new WorkspaceIO(new SandboxRegistry(), getDriver);
    await expect(io.readText('session', 'tests/e2e/TEST_PLAN.md')).rejects.toThrow('No sandbox for session session');
    await expect(io.readTextOnService('session', 'api', 'tests/e2e/TEST_PLAN.md')).rejects.toThrow('No sandbox for session session service api');
    await expect(io.writeText('session', 'plan.md', 'plan')).rejects.toThrow('No sandbox');
    await expect(io.writeTextOnService('session', 'api', 'plan.md', 'plan')).rejects.toThrow('No sandbox');
    await expect(io.readBuffer('session', 'result.png')).rejects.toThrow('No sandbox');
    expect(getDriver).not.toHaveBeenCalled();
  });
  it('retains driver failure when a registered sandbox is inconsistent', async () => {
    const registry = new SandboxRegistry();
    registry.primary.set('session', { containerId: 'primary', workdir: '/app' } as Sandbox);
    await expect(new WorkspaceIO(registry, () => null).readText('session', 'plan.md')).rejects.toThrow('has no driver wired');
  });
  it('routes secondary writes to their own container and rejects traversal', async () => {
    const registry = new SandboxRegistry();
    registry.primary.set('session', { containerId: 'primary', workdir: '/app' } as Sandbox);
    registry.setService('session', 'api', { containerId: 'secondary', workdir: '/backend' } as Sandbox);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const io = new WorkspaceIO(registry, () => ({ writeFile }) as unknown as ISandboxDriver);
    await io.writeTextOnService('session', 'api', 'tests/e2e/TEST_PLAN.md', 'API plan');
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('secondary', '/backend/tests/e2e/TEST_PLAN.md', 'API plan', { recursive: true });
    await expect(io.writeTextOnService('session', 'api', '../outside', 'bad')).rejects.toThrow();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});
