/**
 * Claude Code OAuth — /oauth/claude-code/start + /poll.
 *
 * Mirrors Claude Code's PKCE account auth. Claude.ai logins store a bearer
 * access token for inference; console-only logins store the managed API key
 * created by Claude Code's oauth API key endpoint.
 */
import { Hono } from 'hono';
import type { ProviderStore, UpsertModelInput } from '../../../store/provider-store.js';
import {
  startOAuthFlow as startClaudeCodeFlow,
  pollFlow as pollClaudeCodeFlow,
  submitManualClaudeCode,
  CLAUDE_CODE_BASE_URL,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_CONFIGURED_REDIRECT_PORT,
  fetchClaudeCodeUsageSnapshot,
} from '../../../core/services/oauth/claude-code.js';
import { CLAUDE_CODE_SEED_MODELS } from '../../../core/providers/definitions/claude-code.js';
import { discoverModels } from './model-discovery/index.js';

interface StartClaudeCodeBody {
  loginWithClaudeAi?: boolean;
  inferenceOnly?: boolean;
  orgUUID?: string;
  loginHint?: string;
  loginMethod?: string;
}

export function claudeCodeOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  app.post('/oauth/claude-code/start', async (c) => {
    try {
      const body = await c.req.json<StartClaudeCodeBody>().catch(() => ({} as StartClaudeCodeBody));
      const flow = await startClaudeCodeFlow({
        loginWithClaudeAi: body.loginWithClaudeAi ?? true,
        inferenceOnly: body.inferenceOnly,
        orgUUID: body.orgUUID,
        loginHint: body.loginHint,
        loginMethod: body.loginMethod,
      });
      return c.json(flow);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('EADDRINUSE')) {
        const portMessage =
          CLAUDE_CODE_CONFIGURED_REDIRECT_PORT !== null
            ? `Port ${CLAUDE_CODE_CONFIGURED_REDIRECT_PORT} already in use. `
            : 'Claude Code loopback port is already in use. ';
        return c.json(
          {
            error:
              portMessage +
              'Close any other Claude Code auth flow and retry.',
          },
          409,
        );
      }
      return c.json({ error: msg }, 502);
    }
  });

  app.post('/oauth/claude-code/manual', async (c) => {
    const body = await c.req.json<{ state: string; code: string }>().catch(() => ({
      state: '',
      code: '',
    }));
    if (!body.state) return c.json({ status: 'error', error: 'state required' }, 400);
    if (!body.code) return c.json({ status: 'error', error: 'code required' }, 400);

    const result = submitManualClaudeCode(body.state, body.code);
    if (result.status === 'ok') return c.json(result);
    return c.json(result, result.status === 'expired' ? 410 : 400);
  });

  app.post('/oauth/claude-code/poll', async (c) => {
    const body = await c.req.json<{ state: string; provider_id?: string }>();
    if (!body.state) return c.json({ error: 'state required' }, 400);
    const providerId = body.provider_id ?? 'claude-code';

    try {
      const result = await pollClaudeCodeFlow(body.state);
      if (result.status !== 'authorized') {
        return c.json(result);
      }

      const baseURL = CLAUDE_CODE_BASE_URL;
      const credentialMirror =
        result.auth_type === 'claude_ai' ? result.access_token : result.api_key;
      if (!credentialMirror) {
        return c.json({ status: 'error', error: 'Claude Code did not return usable credentials' }, 502);
      }

      const profile = result.profile;
      const org = profile?.organization;
      const profileInfo = result.profile_info;
      const extra = {
        auth_type: result.auth_type,
        client_id: CLAUDE_CODE_CLIENT_ID,
        scope: result.scope,
        account_uuid: profile?.account?.uuid ?? null,
        organization_uuid: profile?.organization?.uuid ?? null,
        profile,
        profile_info: profileInfo,
        roles: result.roles,
        subscription_type:
          profileInfo?.subscriptionType ?? org?.organization_type ?? null,
        rate_limit_tier: profileInfo?.rateLimitTier ?? org?.rate_limit_tier ?? null,
        seat_tier: profileInfo?.seatTier ?? org?.seat_tier ?? null,
        billing_type: profileInfo?.billingType ?? org?.billing_type ?? null,
        has_extra_usage_enabled:
          profileInfo?.hasExtraUsageEnabled ?? org?.has_extra_usage_enabled ?? null,
      };

      const existing = store.getProvider(providerId);
      if (!existing) {
        store.upsertProvider({
          id: providerId,
          name: 'Claude Code (OAuth)',
          kind: 'claude-code',
          base_url: baseURL,
          api_key: credentialMirror,
          auth_mode: 'oauth',
          enabled: true,
          use_for_coder: true,
          use_for_agent: false,
          use_for_general: false,
          extra,
        });
      } else {
        store.upsertProvider({
          ...existing,
          kind: 'claude-code',
          base_url: baseURL,
          api_key: credentialMirror,
          auth_mode: 'oauth',
          extra: {
            ...existing.extra,
            ...extra,
          },
        });
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        expires_at: result.expires_at,
        scope: result.scope,
        extra,
      });

      let models: UpsertModelInput[] = [];
      let etag: string | null = null;
      try {
        const discovered = await discoverModels(store, store.getProvider(providerId)!);
        if (!discovered.notModified) {
          models = discovered.models;
          etag = discovered.etag;
        }
      } catch {
        models = [];
      }
      if (models.length === 0) {
        models = CLAUDE_CODE_SEED_MODELS.map((m) => ({
          model_id: m.model_id,
          name: m.name,
          source: 'live' as const,
        }));
      }
      store.replaceModelsFromSource(providerId, 'live', models);
      store.setProviderCatalogEtag(providerId, etag);

      return c.json({
        status: 'authorized',
        provider_id: providerId,
        expires_at: result.expires_at,
        auth_type: result.auth_type,
        model_count: models.length,
      });
    } catch (e) {
      return c.json({ status: 'error', error: (e as Error).message }, 502);
    }
  });

  app.get('/oauth/claude-code/usage', async (c) => {
    const providerId = c.req.query('provider_id') ?? 'claude-code';
    const probeRateLimits = c.req.query('probe') === '1';
    try {
      const snapshot = await fetchClaudeCodeUsageSnapshot(store, providerId, {
        probeRateLimits,
      });
      return c.json(snapshot);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg === 'provider not found' ? 404 : 502);
    }
  });

  return app;
}
