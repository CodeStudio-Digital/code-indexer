import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateSessionProvider: vi.fn(),
  setLastResponseState: vi.fn(),
  createLog: vi.fn(async () => ({})),
}));

import {
  applyExplicitMasterFallback,
  runWithExplicitMasterFallback,
  selectNextExplicitMasterFallback,
} from '../fallback.js';

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000042';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000007';
const CODER_SESSION_ID = '00000000-0000-4000-8000-000000000099';

function deps(runtimeKind: 'app_studio' | 'company' = 'app_studio') {
  const companyFiles = {
    getAgentRun: vi.fn(async () => ({
      id: AGENT_RUN_ID,
      company_session_id: COMPANY_SESSION_ID,
      role: 'master',
      coder_session_id: CODER_SESSION_ID,
      provider: 'premium-provider',
      model: 'premium-model',
      configured_provider: 'premium-provider',
      configured_model: 'premium-model',
    })),
    updateAgentRunProvider: vi.fn(async () => undefined),
    sessionStore: {
      updateSessionProvider: mocks.updateSessionProvider,
      setLastResponseState: mocks.setLastResponseState,
    },
    entities: {
      create: mocks.createLog,
    },
  };
  const board = { post: vi.fn() };
  return {
    companyFiles,
    board,
    value: {
      ctx: {
        runtimeKind,
        companySessionId: COMPANY_SESSION_ID,
        appStudioSessionId: '00000000-0000-4000-8000-000000000012',
        companyFiles,
      },
      board,
    } as never,
  };
}

describe('explicit App Master fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('walks only the configured chain and never invents a global fallback', () => {
    const chain = [
      { provider: 'fallback-provider', model: 'fallback-model' },
      { provider: 'last-provider', model: 'last-model' },
    ];
    expect(selectNextExplicitMasterFallback({
      runtimeKind: 'app_studio',
      configured: { provider: 'premium-provider', model: 'premium-model' },
      current: { provider: 'premium-provider', model: 'premium-model' },
      fallbackModels: chain,
    })).toEqual(chain[0]);
    expect(selectNextExplicitMasterFallback({
      runtimeKind: 'app_studio',
      configured: { provider: 'premium-provider', model: 'premium-model' },
      current: chain[0],
      fallbackModels: chain,
    })).toEqual(chain[1]);
    expect(selectNextExplicitMasterFallback({
      runtimeKind: 'app_studio',
      configured: { provider: 'premium-provider', model: 'premium-model' },
      current: { provider: 'global', model: 'mini' },
      fallbackModels: chain,
    })).toBeNull();
    expect(selectNextExplicitMasterFallback({
      runtimeKind: 'company',
      configured: { provider: 'premium-provider', model: 'premium-model' },
      current: { provider: 'premium-provider', model: 'premium-model' },
      fallbackModels: chain,
    })).toBeNull();
  });

  it('persists effective provider/model and fallback reason before retry', async () => {
    const fixture = deps();
    const result = await applyExplicitMasterFallback(
      AGENT_RUN_ID,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      'provider returned HTTP 429',
      fixture.value,
    );

    expect(result?.to).toEqual({ provider: 'fallback-provider', model: 'fallback-model' });
    expect(mocks.updateSessionProvider).toHaveBeenCalledWith(
      CODER_SESSION_ID,
      'fallback-provider',
      'fallback-model',
    );
    expect(fixture.companyFiles.updateAgentRunProvider).toHaveBeenCalledWith(
      AGENT_RUN_ID,
      'fallback-provider',
      'fallback-model',
      expect.stringContaining('master_fallback_models'),
    );
    expect(fixture.board.post).toHaveBeenCalledWith(
      'system',
      AGENT_RUN_ID,
      'message',
      expect.stringContaining('explicit App role fallback'),
    );
    expect(mocks.createLog).toHaveBeenCalledWith(
      'log',
      expect.objectContaining({
        relations: { agent_run_id: AGENT_RUN_ID },
        data: expect.objectContaining({
          event: 'agents.model_fallback',
          entity_id: AGENT_RUN_ID,
        }),
      }),
    );
  });

  it('does not consume the chain for a permanent error or generic Company', async () => {
    const app = deps();
    await expect(applyExplicitMasterFallback(
      AGENT_RUN_ID,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      'max_turns',
      app.value,
    )).resolves.toBeNull();

    const company = deps('company');
    await expect(applyExplicitMasterFallback(
      AGENT_RUN_ID,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      'provider returned HTTP 429',
      company.value,
    )).resolves.toBeNull();
    expect(app.companyFiles.updateAgentRunProvider).not.toHaveBeenCalled();
    expect(company.companyFiles.updateAgentRunProvider).not.toHaveBeenCalled();
  });

  it('retries a bootstrap failure only after provenance is updated', async () => {
    const fixture = deps();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('provider returned HTTP 503'))
      .mockResolvedValueOnce('started');

    await expect(runWithExplicitMasterFallback(
      run,
      AGENT_RUN_ID,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      fixture.value,
    )).resolves.toBe('started');
    expect(run).toHaveBeenCalledTimes(2);
    expect(fixture.companyFiles.updateAgentRunProvider).toHaveBeenCalledTimes(1);
  });
});
