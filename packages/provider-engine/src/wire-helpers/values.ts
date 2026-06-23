import type { ResolvedCreds, TemplateVar, ValueSource } from '@mcp/provider-sdk';

/** Read one source: env var, or a string in `creds.extra`. Empty → undefined. */
export function readSource(src: ValueSource, creds: ResolvedCreds): string | undefined {
  if (src.from === 'env') {
    const v = process.env[src.key];
    return v && v.length > 0 ? v : undefined;
  }
  const v = creds.extra?.[src.key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** First non-empty source; throws `errorMessage` when required and none resolve. */
export function resolveTemplateVar(v: TemplateVar, creds: ResolvedCreds): string | undefined {
  for (const src of v.sources) {
    const got = readSource(src, creds);
    if (got !== undefined) return got;
  }
  if (v.required) throw new Error(v.errorMessage ?? 'required value missing');
  return undefined;
}
