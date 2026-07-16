import { describe, it, expect, vi } from 'vitest';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { modelsRouter } from '../models.routes.js';

/** Minimal fake store — only the methods the subagent-model route touches. */
function fakeStore() {
  const setSubagentTarget = vi.fn();
  const setSubagentProfileTarget = vi.fn();
  const setSubagentEffort = vi.fn();
  const setSubagentProfileEffort = vi.fn();
  const store = {
    getProvider: (id: string) => ({ id, enabled: true, use_for_coder: true }),
    setSubagentTarget,
    setSubagentProfileTarget,
    setSubagentEffort,
    setSubagentProfileEffort,
  } as unknown as ProviderStore;
  return { store, setSubagentTarget, setSubagentProfileTarget, setSubagentEffort, setSubagentProfileEffort };
}

function patch(app: ReturnType<typeof modelsRouter>, id: string, body: unknown) {
  return app.request(`/providers/${id}/subagent-model`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /providers/:id/subagent-model', () => {
  it('routes a valid profile to setSubagentProfileTarget', async () => {
    const { store, setSubagentProfileTarget, setSubagentTarget } = fakeStore();
    const res = await patch(modelsRouter(store), 'openai', {
      profile: 'implement',
      provider_id: 'anthropic',
      model_id: 'opus',
    });
    expect(res.status).toBe(200);
    expect(setSubagentProfileTarget).toHaveBeenCalledWith('openai', 'implement', 'anthropic', 'opus');
    expect(setSubagentTarget).not.toHaveBeenCalled();
  });

  it('rejects an unknown profile with 400', async () => {
    const { store, setSubagentProfileTarget } = fakeStore();
    const res = await patch(modelsRouter(store), 'openai', {
      profile: 'nonsense',
      provider_id: 'anthropic',
    });
    expect(res.status).toBe(400);
    expect(setSubagentProfileTarget).not.toHaveBeenCalled();
  });

  it('falls back to the default target when no profile is given', async () => {
    const { store, setSubagentTarget, setSubagentProfileTarget } = fakeStore();
    const res = await patch(modelsRouter(store), 'openai', {
      provider_id: 'anthropic',
      model_id: 'sonnet',
    });
    expect(res.status).toBe(200);
    expect(setSubagentTarget).toHaveBeenCalledWith('openai', 'anthropic', 'sonnet');
    expect(setSubagentProfileTarget).not.toHaveBeenCalled();
  });

  it('routes a per-profile effort update to setSubagentProfileEffort', async () => {
    const { store, setSubagentProfileEffort, setSubagentProfileTarget } = fakeStore();
    const res = await patch(modelsRouter(store), 'openai', { profile: 'implement', effort: 'xhigh' });
    expect(res.status).toBe(200);
    expect(setSubagentProfileEffort).toHaveBeenCalledWith('openai', 'implement', 'xhigh');
    expect(setSubagentProfileTarget).not.toHaveBeenCalled();
  });

  it('routes a default effort update (including clear) to setSubagentEffort', async () => {
    const { store, setSubagentEffort } = fakeStore();
    const res = await patch(modelsRouter(store), 'openai', { effort: null });
    expect(res.status).toBe(200);
    expect(setSubagentEffort).toHaveBeenCalledWith('openai', null);
  });
});
