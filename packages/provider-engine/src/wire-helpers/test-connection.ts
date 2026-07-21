import type { ProviderSpec, ProviderDefinition } from '@mcp/provider-sdk';
import { openaiAuthHeaders, CHATGPT_CODEX_BASE_URL } from '@mcp/services/services/oauth/openai.js';
import { fetchClaudeCodeModels } from '@mcp/services/services/oauth/claude-code.js';
import { fetchKimiCodeModels } from '@mcp/services/services/kimi-code.js';
import { requestFetchHeaders } from './request.js';

type TestConnection = NonNullable<ProviderDefinition['testConnection']>;

/**
 * Build the admin "Test" connectivity check from `spec.test`. Lift of the
 * per-definition `testConnection` (added in the earlier `/test` refactor),
 * keyed by `spec.test.from`. Returns undefined when no `test` is declared —
 * the route then treats it as a no-op pass (matching deepseek/zai/cloudflare/
 * moonshot, which never had a check). Creds arrive already resolved.
 */
export function buildTestConnection(spec: ProviderSpec): TestConnection | undefined {
  const t = spec.test;
  if (!t) return undefined;

  switch (t.from) {
    case 'openai-models':
      return async ({ creds }) => {
        const base = creds.baseURL ?? t.fallbackBaseURL ?? spec.defaultBaseURL ?? 'https://api.openai.com/v1';
        const url = base.endsWith('/') ? `${base}models` : `${base}/models`;
        // Byte-identical (native Bearer + extraHeaders) when no `request` set.
        const headers = requestFetchHeaders(
          spec,
          { apiKey: creds.apiKey, baseURL: base, creds },
          { Authorization: `Bearer ${creds.apiKey ?? ''}`, ...creds.extraHeaders },
          'Authorization',
        );
        const r = await fetch(url, { headers });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      };

    case 'anthropic-models':
      return async ({ creds }) => {
        const base = (creds.baseURL ?? t.fallbackBaseURL ?? 'https://api.anthropic.com').replace(/\/$/, '');
        const r = await fetch(`${base}/v1/models`, {
          headers: { 'x-api-key': creds.apiKey ?? '', 'anthropic-version': '2023-06-01' },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      };

    case 'gemini-key':
      return async ({ creds }) => {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(creds.apiKey ?? '')}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      };

    case 'gemini-oauth':
      return async ({ creds }) => {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { Authorization: `Bearer ${creds.apiKey ?? ''}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      };

    case 'unsupported':
      return async () => {
        throw new Error(t.message ?? 'test not implemented');
      };

    case 'codex-health':
      // chatgpt: the Codex backend has no public /models; accept any non-auth
      // response from /health.
      return async ({ creds }) => {
        if (!creds.apiKey) throw new Error('no access token stored — re-connect');
        const base = (creds.baseURL ?? t.fallbackBaseURL ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');
        const r = await fetch(`${base}/health`, {
          method: 'GET',
          headers: openaiAuthHeaders(creds.apiKey),
        }).catch(() => null);
        if (r && (r.status === 401 || r.status === 403)) throw new Error(`HTTP ${r.status}`);
      };

    case 'sdk:claude-code':
      // claude-code: creds already refreshed/selected by resolveClaudeCodeCreds.
      return async ({ creds, config }) => {
        await fetchClaudeCodeModels({
          baseURL: creds.baseURL ?? config.base_url,
          apiKey: creds.apiKey,
          authToken: creds.authToken,
          headers: creds.extraHeaders,
          fetch: creds.fetch,
        });
      };

    case 'sdk:kimi-code':
      return async ({ creds, config }) => {
        await fetchKimiCodeModels({
          baseURL: creds.baseURL ?? config.base_url,
          apiKey: creds.apiKey,
          headers: creds.extraHeaders,
        });
      };

    default:
      return undefined;
  }
}
