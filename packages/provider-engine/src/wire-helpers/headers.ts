import type { ProviderSpec, ResolvedCreds } from '@mcp/provider-sdk';
import { readSource } from './values.js';

/**
 * Default request headers. When `headerSources` is set (openrouter attribution),
 * build each header from the first non-empty of its sources (extra/env), then
 * use its declared default when none resolve.
 * Otherwise pass through `creds.extraHeaders` (copilot editor headers; undefined
 * for plain api-key shapes).
 */
export function resolveHeaders(
  spec: ProviderSpec,
  creds: ResolvedCreds,
): Record<string, string> | undefined {
  const sources = spec.wireOpts?.headerSources;
  if (!sources || sources.length === 0) return creds.extraHeaders;

  const out: Record<string, string> = {};
  for (const hs of sources) {
    let resolved = false;
    for (const src of hs.sources) {
      const got = readSource(src, creds);
      if (got !== undefined) {
        out[hs.header] = got;
        resolved = true;
        break;
      }
    }
    if (!resolved && hs.defaultValue !== undefined) {
      out[hs.header] = hs.defaultValue;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
