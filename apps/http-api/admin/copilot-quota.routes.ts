import { Hono } from 'hono';
import type { CopilotQuotaCategory, CopilotQuotaReport, CopilotQuotaSnapshot } from '@mcp/api-bus';
import { startCopilotClient, stopCopilotClient } from '@mcp/code-agent/providers/copilot-sdk-client.js';
import { abortableRead } from '@mcp/shared/utils/abortable.js';
import { matchesCopilotAccount } from '@mcp/code-agent/providers/copilot-account.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';

type Account = Awaited<ReturnType<typeof startCopilotClient>>['rpc']['account'];
type QuotaMap = Awaited<ReturnType<Account['getQuota']>>['quotaSnapshots'];
type AuthInfo = NonNullable<Awaited<ReturnType<Account['getCurrentAuth']>>['authInfo']>;
type AccountDetails = NonNullable<Extract<AuthInfo, { copilotUser?: unknown }>['copilotUser']>;

const categories: CopilotQuotaCategory[] = ['premium_interactions', 'chat', 'completions'];

function amount(input: unknown): number | null {
  const value = typeof input === 'string' && input.trim() ? Number(input) : input;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resetDate(input: string | number | undefined, now: number): string | null {
  const time = typeof input === 'number' ? input * 1000 : Date.parse(input ?? '');
  return Number.isFinite(time) && time > now && time <= 8.64e15 ? new Date(time).toISOString() : null;
}

function summarizeQuota(snapshots: QuotaMap, user?: AccountDetails): CopilotQuotaReport {
  const now = Date.now();
  const quotas: CopilotQuotaSnapshot[] = [];
  for (const category of categories) {
    const row = snapshots[category];
    const raw = user?.quota_snapshots?.[category];
    if (!row && !raw) continue;
    const credits = (raw?.token_based_billing ?? user?.token_based_billing) === true;
    const entitlement = amount(raw?.entitlement) ?? (credits ? null : amount(row?.entitlementRequests));
    const unlimited = (raw?.unlimited ?? row?.isUnlimitedEntitlement) === true;
    const limit = !unlimited && entitlement !== null && entitlement > 0 ? entitlement : null;
    const usedFromSdk = credits ? null : amount(row?.usedRequests);
    // A zero entitlement is also used for unallocated quota categories.
    const hasAllocation = !unlimited && entitlement !== 0;
    const reportedBalance = hasAllocation ? amount(raw?.quota_remaining) ?? amount(raw?.remaining) : null;
    const remaining = reportedBalance ?? (limit !== null && usedFromSdk !== null ? Math.max(0, limit - usedFromSdk) : null);
    const reportedUsage = credits && raw && 'credits_used' in raw ? amount(raw.credits_used) : usedFromSdk;
    const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : reportedUsage;
    const percent = amount(raw?.percent_remaining) ?? amount(row?.remainingPercentage);
    const remainingPercent = limit !== null && remaining !== null ? Math.min(100, remaining / limit * 100)
      : hasAllocation && percent !== null ? Math.min(100, percent) : null;
    if ((used === null || used === 0) && limit === null && remaining === null && remainingPercent === null) continue;
    quotas.push({
      category, unit: credits ? 'credits' : 'requests', limit, used, remaining, remainingPercent,
      resetAt: resetDate(raw?.quota_reset_at, now) ?? resetDate(user?.quota_reset_date_utc, now)
        ?? resetDate(user?.quota_reset_date, now) ?? resetDate(row?.resetDate, now),
    });
  }
  return { checkedAt: new Date(now).toISOString(), quotas };
}

export function copilotQuotaRouter(store: ProviderStore): Hono {
  const app = new Hono();
  app.get('/providers/:id/copilot-quota', async c => {
    c.header('Cache-Control', 'no-store');
    const provider = store.getProvider(c.req.param('id'));
    if (provider?.kind !== 'copilot') return c.json({ code: 'provider_missing' }, 404);
    const { githubLogin, githubHost } = provider.extra;
    if (!githubLogin) return c.json({ code: 'reconnect' }, 409);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(25_000)]);
    let client: Awaited<ReturnType<typeof startCopilotClient>> | undefined;
    try {
      signal.throwIfAborted();
      client = await startCopilotClient(provider.id);
      const runtime = client;
      const status = await abortableRead(() => runtime.getAuthStatus(), signal);
      if (!matchesCopilotAccount(provider.extra, status)) return c.json({ code: 'reconnect' }, 409);

      const account = runtime.rpc.account;
      const quota = await abortableRead(() => account.getQuota({}), signal).catch(() => null);
      // Read the SDK's plan metadata for units and fractional credits. Only
      // normalized numbers are sent to the renderer.
      const auth = await abortableRead(() => account.getCurrentAuth(), signal).catch(() => null);
      signal.throwIfAborted();
      const details = auth?.authInfo && 'copilotUser' in auth.authInfo ? auth.authInfo.copilotUser : undefined;
      if (details?.login && status.login && details.login.toLowerCase() !== status.login.toLowerCase()) {
        return c.json({ code: 'reconnect' }, 409);
      }
      const current = store.getProvider(provider.id);
      if (current?.kind !== 'copilot' || current.extra.githubLogin !== githubLogin || current.extra.githubHost !== githubHost) {
        return c.json({ code: 'reconnect' }, 409);
      }
      const report = summarizeQuota(quota?.quotaSnapshots ?? {}, details);
      if (!quota && report.quotas.length === 0) return c.json({ code: 'quota_unavailable' }, 502);
      return c.json(report);
    } catch {
      return c.json({ code: signal.aborted ? 'quota_timeout' : 'quota_unavailable' }, signal.aborted ? 504 : 502);
    } finally {
      if (client) await stopCopilotClient(client);
    }
  });
  return app;
}
