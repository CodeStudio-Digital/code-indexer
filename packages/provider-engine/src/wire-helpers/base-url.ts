import type { ProviderSpec, ResolvedCreds } from '@mcp/provider-sdk';
import { resolveTemplateVar } from './values.js';

/**
 * Resolve the coder/indexer base URL from the spec's declarative knobs,
 * reproducing each built-in's logic exactly:
 *  - `modelModes` (zai): env override → per-mode URL → admin baseURL → general.
 *  - `baseUrlTemplate` (cloudflare): `{var}` substitution (ignores admin baseURL).
 *  - else: `creds.baseURL ?? spec.defaultBaseURL` (openai/deepseek/openrouter/copilot).
 */
export function resolveBaseURL(
  spec: ProviderSpec,
  creds: ResolvedCreds,
  mode: string | undefined,
): string | undefined {
  const wo = spec.wireOpts;

  if (wo?.modelModes) {
    const mm = wo.modelModes;
    if (mm.envOverride && process.env[mm.envOverride]) return process.env[mm.envOverride];
    if (mode && mm.map[mode]) return mm.map[mode].baseURL;
    if (creds.baseURL && creds.baseURL.trim()) return creds.baseURL;
    return mm.map.general?.baseURL ?? spec.defaultBaseURL;
  }

  if (wo?.baseUrlTemplate) {
    let url = wo.baseUrlTemplate;
    for (const [name, v] of Object.entries(wo.baseUrlVars ?? {})) {
      url = url.replace(`{${name}}`, resolveTemplateVar(v, creds) ?? '');
    }
    return url;
  }

  return creds.baseURL ?? spec.defaultBaseURL;
}
