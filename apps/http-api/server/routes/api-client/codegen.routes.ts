import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { requestInProject, resolveScopedEnv } from './_ownership.js';
import { parseEnvVariables } from '@mcp/services/api-client/request-builder.js';
import { buildCodegenRequest, generate, isCodegenTarget, languageFor, type CodegenRequest } from '@mcp/services/api-client/codegen/index.js';

/**
 * Code generation for a request — curl/powershell/httpie/js/python. Runs
 * server-side so it reuses request-builder + apply-auth (single source of truth)
 * and can optionally resolve env vars (secrets stay server-side; the client gets
 * a `containsSecrets` flag to warn before copying).
 */
export function mountApiCodegenRoute(app: HttpRouter, deps: ServerDeps): void {
  // R1 — `store` is resolved per-request via deps.apiClientFor(projectId).
  const base = '/api/projects/:projectId/api-client';

  app.post(`${base}/requests/:rid/codegen`, async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    // Ownership guard: a stale rid/envId from a previous project must not let
    // codegen embed another project's request — and with resolve=true, its
    // resolved SECRET env values (cross-project secret exfiltration).
    const req = requestInProject(store, projectId, rid);
    if (!req) return notFound(c, `Request ${rid} not found`);

    const body = await parseJsonBody<{ target?: string; resolve?: boolean; envId?: number }>(c);
    const target = String(body.target ?? 'curl-bash');
    if (!isCodegenTarget(target)) return c.json({ error: `unknown target '${target}'` }, 400);

    const resolve = !!body.resolve;
    const env = resolveScopedEnv(store, projectId, body.envId);
    const variables = parseEnvVariables(env?.variables_json);
    const baseUrl = env?.base_url ?? '';

    const cg = buildCodegenRequest({ request: req, baseUrl, variables, resolve });
    const code = generate(target, cg);
    // Check the resolved request (pre shell/JSON escaping) so an escaped secret
    // value (e.g. a quote/backslash mangled by the generator) isn't missed.
    const containsSecrets = resolve && hasSecret(cg, env?.variables_json);

    return c.json({ target, language: languageFor(target), code, containsSecrets });
  });
}

/** True when the resolved request embeds a value from a `secret:true` env var. */
function hasSecret(cg: CodegenRequest, variablesJson: string | null | undefined): boolean {
  if (!variablesJson) return false;
  let secrets: string[] = [];
  try {
    const vars = JSON.parse(variablesJson) as Record<string, { value?: string; secret?: boolean } | string>;
    secrets = Object.values(vars)
      .filter((v): v is { value?: string; secret?: boolean } => !!v && typeof v === 'object' && !!v.secret && !!v.value)
      .map((v) => v.value as string);
  } catch { return false; }
  if (!secrets.length) return false;
  const hay = [cg.url, ...cg.headers.map((h) => h.value), codegenBodyText(cg.body)].join('\n');
  // Match the raw value AND its URL-encoded form: query params are
  // encodeURIComponent'd into cg.url, so a secret containing +, /, = (JWTs,
  // base64 keys, apikey-in-query) would otherwise evade detection and the user
  // would be told the snippet is clean while it embeds a live credential.
  return secrets.some((s) => hay.includes(s) || hay.includes(encodeURIComponent(s)));
}

function codegenBodyText(b: CodegenRequest['body']): string {
  switch (b.kind) {
    case 'json': case 'raw': return b.content;
    case 'graphql': return `${b.query}\n${b.variables ?? ''}`;
    case 'urlencoded': return b.fields.map(([k, v]) => `${k}${v}`).join('\n');
    case 'form-data': return b.fields.map((f) => `${f.name}${f.value}${f.filename ?? ''}`).join('\n');
    default: return '';
  }
}
