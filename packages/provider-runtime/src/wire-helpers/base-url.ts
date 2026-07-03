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
    // Per-request override: the `::mode` suffix on the model id wins.
    if (mode && mm.map[mode]) return mm.map[mode].baseURL;
    // Provider-level default mode (the "plan mode" select, e.g. extra.zai_mode).
    const defMode = mm.defaultModeKey
      ? (creds.extra?.[mm.defaultModeKey] as string | undefined)
      : undefined;
    if (defMode && mm.map[defMode]) return mm.map[defMode].baseURL;
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
