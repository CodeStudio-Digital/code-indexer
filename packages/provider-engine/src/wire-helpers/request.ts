import type { ProviderSpec, ResolvedCreds } from '@mcp/provider-sdk';

/**
 * Consumes `spec.request` (the declarative request-customization descriptor).
 *
 * Every function is a NO-OP when the relevant `request` sub-field is absent —
 * it returns its input unchanged, so a spec without `request` (every built-in)
 * produces a byte-identical request to the wire's native path. Shared by the
 * openai-compat wire (chat), discovery (`/models`), and the connectivity test so
 * a vendor with a non-standard auth header passes all three.
 *
 * Template grammar (closed, no code): `{apiKey}` `{baseURL}` `{model}`
 * `{extra.KEY}` `{env.KEY}`. Unknown placeholders resolve to ''.
 */
export interface RequestTemplateCtx {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  creds: ResolvedCreds;
}

function resolveToken(token: string, ctx: RequestTemplateCtx): string {
  if (token === 'apiKey') return ctx.apiKey ?? '';
  if (token === 'baseURL') return ctx.baseURL ?? '';
  if (token === 'model') return ctx.model ?? '';
  if (token.startsWith('extra.')) {
    const v = ctx.creds.extra?.[token.slice('extra.'.length)];
    return typeof v === 'string' ? v : '';
  }
  if (token.startsWith('env.')) return process.env[token.slice('env.'.length)] ?? '';
  return '';
}

/** Resolve a value template against the fixed context. No code, no expressions. */
export function applyRequestTemplate(tpl: string, ctx: RequestTemplateCtx): string {
  return tpl.replace(/\{([^}]+)\}/g, (_m, t: string) => resolveToken(t.trim(), ctx));
}

/**
 * Merge `request.headers` (static/templated) onto `base`. Returns `base`
 * unchanged when no static headers are declared.
 */
export function requestStaticHeaders(
  spec: ProviderSpec,
  ctx: RequestTemplateCtx,
  base: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const hs = spec.request?.headers;
  if (!hs || hs.length === 0) return base;
  const out: Record<string, string> = { ...(base ?? {}) };
  for (const h of hs) out[h.header] = applyRequestTemplate(h.value, ctx);
  return out;
}

/** The auth header override from `request.auth`, or undefined (use wire native). */
export function requestAuthHeader(
  spec: ProviderSpec,
  ctx: RequestTemplateCtx,
): { name: string; value: string } | undefined {
  const a = spec.request?.auth;
  if (!a) return undefined;
  return { name: a.header, value: applyRequestTemplate(a.valueTemplate, ctx) };
}

/** Apply `request.model` rewriting (stripSuffix → map → template). Identity when absent. */
export function rewriteModelId(spec: ProviderSpec, model: string): string {
  const m = spec.request?.model;
  if (!m) return model;
  let id = model;
  for (const suf of m.stripSuffix ?? []) if (suf && id.endsWith(suf)) id = id.slice(0, -suf.length);
  if (m.map && Object.prototype.hasOwnProperty.call(m.map, id)) id = m.map[id];
  if (m.template) id = m.template.replace(/\{model\}/g, id);
  return id;
}

/** The fetch query params from `request.query` (resolved), or undefined. */
export function requestQuery(
  spec: ProviderSpec,
  ctx: RequestTemplateCtx,
): Record<string, string> | undefined {
  const q = spec.request?.query;
  if (!q || Object.keys(q).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) out[k] = applyRequestTemplate(v, ctx);
  return out;
}

/**
 * Build the auth/static headers for a raw-fetch caller (discovery/test). When
 * `request.auth` is set, the descriptor's header REPLACES the wire-native auth
 * header (`nativeAuthHeader`, e.g. 'Authorization'); other native headers are
 * preserved. With no `request`, returns `native` unchanged (byte-identical).
 */
export function requestFetchHeaders(
  spec: ProviderSpec,
  ctx: RequestTemplateCtx,
  native: Record<string, string>,
  nativeAuthHeader: string,
): Record<string, string> {
  if (!spec.request?.auth && !(spec.request?.headers && spec.request.headers.length > 0)) {
    return native;
  }
  const out: Record<string, string> = { ...native };
  const auth = requestAuthHeader(spec, ctx);
  if (auth) {
    delete out[nativeAuthHeader];
    out[auth.name] = auth.value;
  }
  return requestStaticHeaders(spec, ctx, out) ?? out;
}
