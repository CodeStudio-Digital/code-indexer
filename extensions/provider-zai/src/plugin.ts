/**
 * Z.AI / GLM as a DECLARATIVE provider plugin — the reference for adding a
 * provider as pure DATA through the plugin SDK (the same way Podman/Cloudflare
 * plugins declare tools).
 *
 * This file imports ONLY `@mcp/plugin-sdk` + `@mcp/provider-sdk` — NO adapter
 * classes, NO `@mcp/code-agent`/`@mcp/indexer`/`@mcp/services`. The CLI `build`
 * writes the `ProviderSpec` verbatim into `.app.json`; the host turns it into a
 * runtime definition via `buildProviderDefinition` (the engine), so NO plugin
 * code runs in-process. The wire (`openai-compat`) + `wireOpts.modelModes`
 * (`::coding`/`::general` baseURL routing + `ZAI_BASE_URL` env override) express
 * everything the old hand-written adapter did, as data.
 *
 * `displayName` is suffixed "(plugin)" so installing this plugin visibly
 * OVERRIDES the built-in `zai` provider in the admin picker — proof the
 * declarative registration took effect.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderSpec } from '@mcp/provider-sdk';

const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

const zai = defineProviderSpec({
  kind: 'zai',
  displayName: 'Z.AI / GLM (plugin)',
  visual: { icon: 'Sparkles', fg: 'text-violet-500', bg: 'bg-violet-500/15' },
  credKind: 'api-key',
  envVars: ['ZAI_API_KEY'],
  defaultBaseURL: 'https://api.z.ai/api/paas/v4',
  defaultModel: 'glm-5.1',
  defaultModels: [
    'glm-5.1',
    'glm-5-turbo',
    'glm-5',
    'glm-4.7',
    'glm-4.7-flash',
    'glm-4.6',
    'glm-4.5',
    'glm-4.5-air',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
  ],
  pricing: {
    'glm-5.1': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-5-turbo': { inputPer1M: 1.2, outputPer1M: 4.0 },
    'glm-5': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.7': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.7-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'glm-4.6': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.5': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.5-air': { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4.5-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'glm-4-32b-0414-128k': { inputPer1M: 0.1, outputPer1M: 0.1 },
  },
  capabilities: { zaiCodingMode: true, supportsThinking: true },
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'zai',
    modelModes: {
      map: { coding: { baseURL: ZAI_CODING_URL }, general: { baseURL: ZAI_GENERAL_URL } },
      envOverride: 'ZAI_BASE_URL',
    },
  },
  discovery: {
    from: 'openai-models',
    modelsUrl: 'https://api.z.ai/api/paas/v4/models',
    supportsModes: ['normal', 'coding'],
  },
});

export default definePlugin({ providers: [zai] });
