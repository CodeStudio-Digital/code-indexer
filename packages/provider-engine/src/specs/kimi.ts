import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative spec for the Kimi Code (OAuth) built-in. The inline
 * `readKimiCodeThinkingMode` logic is represented as `wireOpts.thinkingMode`
 * data the engine interprets.
 *
 * `KIMI_CODE_BASE_URL` (`'https://api.kimi.com/coding/v1'`) and the seed model
 * ids are inlined here rather than imported from `@mcp/services` — the spec
 * lives in `@mcp/provider-engine`, which `@mcp/services` depends on, so a
 * runtime import would close a dependency cycle.
 */

// = KIMI_CODE_BASE_URL from @mcp/services/services/oauth/kimi-code.ts
const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

// = KIMI_CODE_SEED_MODELS.map((m) => m.model_id)
const KIMI_CODE_SEED_MODEL_IDS = [
  'k3',
  'kimi-k2.6',
  'kimi-k2.5',
  'kimi-k2-thinking',
  'kimi-k2-thinking-turbo',
  'kimi-k2-turbo-preview',
];

export const kimiCodeSpec: ProviderSpec = {
  kind: 'kimi-code',
  displayName: 'Kimi Code (OAuth)',
  visual: { icon: 'Bot', fg: 'text-cyan-500', bg: 'bg-cyan-500/15' },
  credKind: 'oauth',
  envVars: [],
  defaultBaseURL: KIMI_CODE_BASE_URL,
  defaultModel: 'kimi-k2.6',
  defaultModels: KIMI_CODE_SEED_MODEL_IDS,
  pricing: {
    'k3': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2.6': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2.5': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2-thinking': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2-thinking-turbo': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2-turbo-preview': { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  // Wins the cross-provider duplicate-id collision with moonshot (default 0) for
  // the shared `kimi-k2-turbo-preview` / `kimi-k2-thinking-turbo` ids: kimi-code
  // is the $0 OAuth plan, moonshot is metered. Deterministic once BOTH are
  // plugins (load order no longer fixes the winner).
  pricingPriority: -10,
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
  },
  wire: 'kimi',
  wireOpts: {
    thinkingMode: { from: 'extra', key: 'thinkingMode', default: 'auto' },
  },
  discovery: { from: 'sdk:kimi-code' },
  test: { from: 'sdk:kimi-code' },
  // Declarative OAuth (RFC-8628 device-code). Values inlined from
  // services/oauth/kimi-code.ts (parity-tested). refreshThresholdSec is OMITTED
  // — the threshold is adaptive (max(5min, expires_in*0.5)); the 'kimi-code' hook
  // owns it plus the refresh-token tombstone + rotation-race recovery. No scopes
  // (device_authorization sends only client_id).
  auth: {
    mode: 'oauth',
    flavor: 'device-code',
    needs: { deviceCode: true },
    clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
    deviceAuthUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
    tokenUrl: 'https://auth.kimi.com/api/oauth/token',
    hooks: 'kimi-code',
  },
  // The thinking-mode key matches wireOpts.thinkingMode.key ('thinkingMode').
  config: {
    fields: [
      {
        key: 'thinkingMode',
        type: 'select',
        label: 'Thinking mode',
        storeIn: 'extra',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'enabled', label: 'Enabled' },
          { value: 'disabled', label: 'Disabled' },
        ],
        default: 'auto',
      },
    ],
  },
};

export const KIMI_SPECS: ProviderSpec[] = [kimiCodeSpec];
