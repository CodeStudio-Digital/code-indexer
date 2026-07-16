import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateSessionProvider: vi.fn(),
  setLastResponseState: vi.fn(),
  close: vi.fn(),
  appendEvent: vi.fn(),
}));

vi.mock('@mcp/code-agent/sessions/store.js', () => ({
  SessionStore: class {
    updateSessionProvider = mocks.updateSessionProvider;
    setLastResponseState = mocks.setLastResponseState;
    close = mocks.close;
  },
}));
vi.mock('@mcp/shared/utils/config.js', () => ({
  loadConfig: () => ({ dbPath: ':memory:' }),
}));
vi.mock('@mcp/company/tools/app-studio/store-binding.js', () => ({
  getAppStudioStore: () => ({ appendEvent: mocks.appendEvent }),
}));

import {
  applyExplicitMasterFallback,
  runWithExplicitMasterFallback,
  selectNextExplicitMasterFallback,
} from '../fallback.js';

function deps(runtimeKind: 'app_studio' | 'company' = 'app_studio') {
  const companyStore = {
    getAgentRun: vi.fn(() => ({
      id: 7,
      company_session_id: 42,
      role: 'master',
      coder_session_id: 99,
      provider: 'premium-provider',
      model: 'premium-model',
      configured_provider: 'premium-provider',
      configured_model: 'premium-model',
    })),
    updateAgentRunProvider: vi.fn(),
  };
  const board = { post: vi.fn() };
  return {
    companyStore,
    board,
    value: {
      ctx: {
        runtimeKind,
        companySessionId: 42,
        appStudioSessionId: 12,
        companyStore,
        db: { raw: () => ({}) },
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

  it('persists effective provider/model and fallback reason before retry', () => {
    const fixture = deps();
    const result = applyExplicitMasterFallback(
      7,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      'provider returned HTTP 429',
      fixture.value,
    );

    expect(result?.to).toEqual({ provider: 'fallback-provider', model: 'fallback-model' });
    expect(mocks.updateSessionProvider).toHaveBeenCalledWith(
      99,
      'fallback-provider',
      'fallback-model',
    );
    expect(fixture.companyStore.updateAgentRunProvider).toHaveBeenCalledWith(
      7,
      'fallback-provider',
      'fallback-model',
      expect.stringContaining('master_fallback_models'),
    );
    expect(fixture.board.post).toHaveBeenCalledWith(
      'system',
      7,
      'message',
      expect.stringContaining('explicit App role fallback'),
    );
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      12,
      'agents.model_fallback',
      'company_agent_run',
      '7',
      expect.any(String),
      'app-master-fallback:7:fallback-provider:fallback-model',
    );
  });

  it('does not consume the chain for a permanent error or generic Company', () => {
    const app = deps();
    expect(applyExplicitMasterFallback(
      7,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      'max_turns',
      app.value,
    )).toBeNull();

    const company = deps('company');
    expect(applyExplicitMasterFallback(
      7,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      'provider returned HTTP 429',
      company.value,
    )).toBeNull();
    expect(app.companyStore.updateAgentRunProvider).not.toHaveBeenCalled();
    expect(company.companyStore.updateAgentRunProvider).not.toHaveBeenCalled();
  });

  it('retries a bootstrap failure only after provenance is updated', async () => {
    const fixture = deps();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('provider returned HTTP 503'))
      .mockResolvedValueOnce('started');

    await expect(runWithExplicitMasterFallback(
      run,
      7,
      [{ provider: 'fallback-provider', model: 'fallback-model' }],
      fixture.value,
    )).resolves.toBe('started');
    expect(run).toHaveBeenCalledTimes(2);
    expect(fixture.companyStore.updateAgentRunProvider).toHaveBeenCalledTimes(1);
  });
});
