import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { copilotQuotaRouter } from '../copilot-quota.routes.js';

const sdk = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), status: vi.fn(), quota: vi.fn(), auth: vi.fn(),
}));
vi.mock('@mcp/code-agent/providers/copilot-sdk-client.js', () => ({
  startCopilotClient: sdk.start, stopCopilotClient: sdk.stop,
}));

const provider = { id: 'copilot', kind: 'copilot', extra: { githubLogin: 'fixture', githubHost: 'github.com' } };
const path = '/providers/copilot/copilot-quota';
const createApp = () => copilotQuotaRouter({ getProvider: () => provider } as unknown as ProviderStore);

beforeEach(() => {
  vi.resetAllMocks();
  sdk.start.mockResolvedValue({ getAuthStatus: sdk.status, rpc: { account: { getQuota: sdk.quota, getCurrentAuth: sdk.auth } } });
  sdk.stop.mockResolvedValue(undefined);
  sdk.status.mockResolvedValue({ isAuthenticated: true, login: 'Fixture', host: 'https://github.com' });
  sdk.quota.mockResolvedValue({ quotaSnapshots: {} });
  sdk.auth.mockResolvedValue({});
});

describe('Copilot quota panel data', () => {
  it('keeps fractional credits and sends no authentication data to the renderer', async () => {
    sdk.auth.mockResolvedValue({ authInfo: { type: 'user', token: 'fixture-secret', copilotUser: {
      token_based_billing: true, login: 'fixture',
      quota_snapshots: { premium_interactions: {
        entitlement: 1000, quota_remaining: 549.875, remaining: 550, quota_reset_at: 2208988800,
      } },
    } } });
    const reply = await createApp().request(path);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    const data = await reply.json();
    expect(data.quotas).toMatchObject([{
      category: 'premium_interactions', unit: 'credits', used: 450.125, limit: 1000, remaining: 549.875,
      resetAt: '2040-01-01T00:00:00.000Z',
    }]);
    expect(data.quotas[0].remainingPercent).toBeCloseTo(54.9875, 8);
    expect(JSON.stringify(data)).not.toContain('fixture-secret');
    expect(sdk.quota).toHaveBeenCalledWith({});
    expect(sdk.stop).toHaveBeenCalledTimes(1);
  });

  it('reports consumption alone for an account without a personal allocation', async () => {
    sdk.auth.mockResolvedValue({ authInfo: { copilotUser: {
      token_based_billing: true,
      quota_snapshots: { premium_interactions: { entitlement: 0, unlimited: true, credits_used: 87.25 } },
    } } });
    const reply = await createApp().request(path);
    expect((await reply.json()).quotas).toMatchObject([
      { unit: 'credits', used: 87.25, limit: null, remaining: null, remainingPercent: null },
    ]);
  });

  it('keeps request quotas in their original unit and skips unallocated buckets', async () => {
    sdk.quota.mockResolvedValue({ quotaSnapshots: {
      premium_interactions: { entitlementRequests: 50, usedRequests: 14, remainingPercentage: 72 },
      completions: { entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0 },
    } });
    const reply = await createApp().request(path);
    expect((await reply.json()).quotas).toMatchObject([
      { unit: 'requests', used: 14, limit: 50, remaining: 36, remainingPercent: 72 },
    ]);
  });

  it('asks for reconnection if the native runtime selected a different user', async () => {
    sdk.status.mockResolvedValue({ isAuthenticated: true, login: 'other-user', host: 'https://github.com' });
    const reply = await createApp().request(path);
    expect(reply.status).toBe(409);
    expect(await reply.json()).toEqual({ code: 'reconnect' });
    expect(sdk.quota).not.toHaveBeenCalled();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
  });

  it('does not read the OS account quota for a pre-SDK Cloud connection', async () => {
    const app = copilotQuotaRouter({ getProvider: () => ({ ...provider, extra: {} }) } as unknown as ProviderStore);
    const response = await app.request(path);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'reconnect' });
    expect(sdk.start).not.toHaveBeenCalled();
  });
});
