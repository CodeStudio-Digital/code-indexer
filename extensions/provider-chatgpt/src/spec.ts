import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * ChatGPT (Codex PKCE OAuth) — the `codex` wire (OpenAI Responses API). The
 * access token + chatgpt_account_id are produced by this plugin's runtime
 * adapter. Per-instance reasoning capability + apply_patch tool type
 * are read live from `provider_models` inside the wire (see wires/codex.ts).
 *
 * `test: codex-health` stays bridged for compatibility; live discovery
 * (`chatgpt-models`, ETag) is implemented by this plugin.
 */
export const chatgptSpec: ProviderSpec = {
  kind: 'chatgpt',
  displayName: 'ChatGPT (Codex OAuth)',
  visual: { icon: 'MessagesSquare', fg: 'text-emerald-400', bg: 'bg-emerald-400/15' },
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.3-codex', 'gpt-5-codex', 'gpt-4o'],
  pricing: {
    // Codex OAuth models are subscription-billed → 0 marginal token cost.
    'gpt-5.6-sol': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gpt-5.6-terra': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gpt-5.6-luna': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gpt-5.3-codex': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gpt-5-codex': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
  },
  wire: 'codex',
  discovery: { from: 'chatgpt-models' },
  test: { from: 'codex-health' },
  // Declarative OAuth (authorization-code + loopback :1455 + PKCE). The
  // 3 authorizeParams are Codex-specific + REQUIRED — without them the id_token
  // lacks the chatgpt_account_id claim. The 'chatgpt' hook owns account-id-from-JWT.
  auth: {
    mode: 'oauth',
    flavor: 'authorization-code',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    refreshThresholdSec: 60,
    needs: { loopback: true, openBrowser: true },
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirect: { port: 1455, path: '/auth/callback' },
    authorizeParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
    hooks: 'chatgpt',
  },
};

export const CHATGPT_SPECS: ProviderSpec[] = [chatgptSpec];
