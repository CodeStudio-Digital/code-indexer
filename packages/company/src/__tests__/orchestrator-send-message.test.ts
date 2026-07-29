import { describe, expect, it, vi } from 'vitest';

vi.mock('@mcp/docs-agent/bridges/docs-bridge.js', () => ({
  installDocsDeepResearch: vi.fn(),
}));

import { CompanyOrchestrator } from '../orchestrator.js';

const COMPANY_SESSION_ID = 'c0000000-0000-4000-8000-000000000007';

function fakeOrchestrator(overrides: {
  start?: () => Promise<unknown>;
  resumeExisting?: () => Promise<unknown>;
  persistedMaster?: boolean;
  isAlive?: boolean;
}) {
  return {
    companySessionId: COMPANY_SESSION_ID,
    ctx: {
      companyFiles: {
        getSession: () => ({
          id: COMPANY_SESSION_ID,
          config_json: '{}',
          runtime_kind: 'company',
        }),
        listAgentRunsSync: () => overrides.persistedMaster ? [{ role: 'master' }] : [],
      },
    },
    master: {
      isAlive: overrides.isAlive ?? false,
      agentRunId: null,
      start: overrides.start ?? vi.fn(async () => ({ ok: true })),
      resumeExisting: overrides.resumeExisting ?? vi.fn(async () => ({ ok: true })),
      sendUserMessage: vi.fn(() => ({ ok: true })),
    },
  };
}

describe('CompanyOrchestrator.sendMessageToMaster', () => {
  it('propagates a dormant lazy-start rejection instead of acknowledging delivery', async () => {
    const launchError = new Error('provider boot failed');
    const orchestrator = fakeOrchestrator({
      start: vi.fn(async () => {
        throw launchError;
      }),
    });

    await expect(
      CompanyOrchestrator.prototype.sendMessageToMaster.call(
        orchestrator as unknown as CompanyOrchestrator,
        'continue',
      ),
    ).rejects.toBe(launchError);
  });

  it('waits for a persisted-master resume acknowledgement', async () => {
    let acknowledge!: () => void;
    const resume = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const orchestrator = fakeOrchestrator({
      persistedMaster: true,
      resumeExisting: vi.fn(() => resume),
    });

    const result = CompanyOrchestrator.prototype.sendMessageToMaster.call(
      orchestrator as unknown as CompanyOrchestrator,
      'continue',
    );
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledge();
    await expect(result).resolves.toEqual({ ok: true });
  });
});

describe('CompanyOrchestrator sandbox RPC facade', () => {
  it('projects a live SandboxBinding to a structured-clone-safe DTO', async () => {
    const addService = vi.fn(async () => ({
      driver: { exec: vi.fn() },
      containerId: 'container-123',
      workdir: '/app',
      previewUrl: 'http://127.0.0.1:4173',
    }));
    const orchestrator = {
      sandboxService: { addService },
    };

    const result = await CompanyOrchestrator.prototype.addSandboxService.call(
      orchestrator as unknown as CompanyOrchestrator,
      { serviceId: 'web', stack: 'react-ts' },
    );

    expect(addService).toHaveBeenCalledWith({ serviceId: 'web', stack: 'react-ts' });
    expect(result).toEqual({
      containerId: 'container-123',
      previewUrl: 'http://127.0.0.1:4173',
    });
    expect(() => structuredClone(result)).not.toThrow();
    expect(result).not.toHaveProperty('driver');
  });
});
