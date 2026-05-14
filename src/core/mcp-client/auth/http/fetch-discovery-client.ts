import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from '../domain/authorization-server.js';
import type { DiscoveryClient } from '../ports/discovery-client.js';

/**
 * Thin wrapper around globalThis.fetch that understands RFC 8414/9728
 * JSON shapes. Throws on non-200 or parse error — the use-case catches.
 *
 * Per RFC 9728 §3.1 and RFC 8414 §3.1, the well-known segment is
 * inserted *between the host and the path component*, not appended
 * after the path. For a resource `https://host.example/foo`, the
 * canonical PR metadata URL is
 * `https://host.example/.well-known/oauth-protected-resource/foo`,
 * not `https://host.example/foo/.well-known/oauth-protected-resource`.
 *
 * Many real servers also publish at the origin root (with no path
 * suffix) regardless of the resource path, so we try the path-aware
 * variant first and fall back to origin-rooted if it 404s.
 */
export class FetchDiscoveryClient implements DiscoveryClient {
  async fetchProtectedResourceMetadata(
    resourceUrl: string,
  ): Promise<ProtectedResourceMetadata> {
    const candidates = buildWellKnownCandidates(
      resourceUrl,
      'oauth-protected-resource',
    );
    const body = await fetchFirstJson(candidates);
    return {
      resource: stringField(body, 'resource'),
      authorizationServers: stringArray(body, 'authorization_servers'),
      scopesSupported: stringArray(body, 'scopes_supported'),
      bearerMethodsSupported: stringArray(body, 'bearer_methods_supported'),
    };
  }

  async fetchAuthorizationServerMetadata(
    issuer: string,
  ): Promise<AuthorizationServerMetadata> {
    const candidates = buildWellKnownCandidates(
      issuer,
      'oauth-authorization-server',
    );
    const body = await fetchFirstJson(candidates);
    return {
      issuer: stringField(body, 'issuer'),
      authorizationEndpoint: stringField(body, 'authorization_endpoint'),
      tokenEndpoint: stringField(body, 'token_endpoint'),
      registrationEndpoint: optionalString(body, 'registration_endpoint'),
      revocationEndpoint: optionalString(body, 'revocation_endpoint'),
      scopesSupported: stringArray(body, 'scopes_supported'),
      codeChallengeMethodsSupported: stringArray(body, 'code_challenge_methods_supported'),
      grantTypesSupported: stringArray(body, 'grant_types_supported'),
      tokenEndpointAuthMethodsSupported: stringArray(
        body,
        'token_endpoint_auth_methods_supported',
      ),
    };
  }
}

/**
 * Build the ordered list of URLs to probe for a well-known metadata
 * document. `suffix` is the last segment, e.g.
 * `oauth-protected-resource` or `oauth-authorization-server`.
 *
 * Returns:
 *   - [input] when the caller already passed a fully-formed
 *     well-known URL (we detect the segment and pass it through).
 *   - [path-aware, origin-rooted] when the input has a non-trivial
 *     path. Path-aware first because RFC 9728/8414 designate it as
 *     canonical.
 *   - [origin-rooted] when the input is a bare origin (or trailing
 *     slash). Both candidates would coincide so we deduplicate.
 */
export function buildWellKnownCandidates(input: string, suffix: string): string[] {
  const trimmed = input.replace(/\/+$/, '');
  if (trimmed.includes('/.well-known/')) return [trimmed];

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Fallback for callers that pass something that isn't a valid URL
    // (shouldn't happen in production paths). Preserve old behavior so
    // the caller still gets a meaningful error from fetch().
    return [`${trimmed}/.well-known/${suffix}`];
  }

  const wellKnown = `/.well-known/${suffix}`;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const pathAware = `${url.origin}${wellKnown}${path}`;
  const originRooted = `${url.origin}${wellKnown}`;
  return pathAware === originRooted ? [originRooted] : [pathAware, originRooted];
}

interface AttemptFailure {
  url: string;
  status: number;
  body: string;
}

/**
 * Try each candidate URL in order. Return the parsed JSON body of the
 * first 2xx response. If every candidate fails, throw with a message
 * that lists each URL and its status so the caller (and end user) can
 * see what was attempted.
 */
async function fetchFirstJson(urls: string[]): Promise<Record<string, unknown>> {
  const failures: AttemptFailure[] = [];
  for (const url of urls) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e) {
      failures.push({ url, status: 0, body: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (res.ok) {
      return (await res.json()) as Record<string, unknown>;
    }
    failures.push({ url, status: res.status, body: await res.text() });
  }
  const summary = failures
    .map((f) => `${f.url} → HTTP ${f.status}: ${truncate(f.body, 200)}`)
    .join(' | ');
  throw new Error(summary || 'no candidate URLs to try');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return [];
}
