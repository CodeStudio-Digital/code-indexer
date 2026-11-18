import { createHash } from 'node:crypto';
import { fetchWithMcpDispatch, McpDispatchRejected } from './mcp-wire-dispatch.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import type { McpRuntimeConfig } from './mcp-connection-types.js';
import type { ResolveMcpBearer } from '@mcp/services/mcp-client/auth/use-cases/resolve-mcp-bearer.js';
import { mcpAuthClientErrorMessage } from '@mcp/services/mcp-client/auth/domain/errors.js';
/** Upper bound for the DELETE that ends a streamable HTTP session; cleanup never waits longer. */
export const TERMINATE_SESSION_TIMEOUT_MS = 2_000;


/**
 * The SDK's close() only aborts requests. Without the DELETE the server keeps the
 * session until its own idle timeout, so frequent reconnects fill its session limit
 * (the Unity broker answered 503 for hours on 2026-10-08).
 */
export async function terminateSession(transport: Transport): Promise<void> {
  if (!(transport instanceof StreamableHTTPClientTransport)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>(resolve => {
    timer = setTimeout(resolve, TERMINATE_SESSION_TIMEOUT_MS);
    timer.unref();
  });
  try { await Promise.race([transport.terminateSession(), elapsed]); }
  catch { /* Best effort: an unreachable server reclaims the session by its idle timeout. */ }
  finally { clearTimeout(timer); }
}


/**
 * Build auth headers from config. Async because OAuth requires a resolver
 * that may refresh the access token from a remote AS.
 *
 * OAuth failures are explicit; an authenticated integration must never be
 * silently downgraded to an anonymous connection.
 */
export async function buildAuthHeaders(
  config: McpServerConfig,
  resolver: ResolveMcpBearer | null,
): Promise<Record<string, string>> {
  if (config.auth_type === 'oauth2') {
    if (!resolver) throw new Error(`OAuth is not configured for "${config.id}". Connect this server in MCP settings.`);
    const result = await resolver.execute(config.id);
    if (!result.ok) {
      throw new Error(`OAuth for "${config.id}": ${mcpAuthClientErrorMessage(result.error)}`);
    }
    return { Authorization: `Bearer ${result.value}` };
  }

  if (!config.auth_token) return {};
  switch (config.auth_type) {
    case 'bearer':
      return { Authorization: `Bearer ${config.auth_token}` };
    case 'api_key': {
      // Default header name is X-API-Key, but can be overridden via config.headers
      const headerName =
        (config.config as Record<string, unknown>).api_key_header_name as string | undefined ??
        'X-API-Key';
      return { [headerName]: config.auth_token };
    }
    default:
      return {};
  }
}


/**
 * Create the appropriate transport for a server config. Async because
 * auth header resolution (OAuth) may require remote calls.
 */
export async function createTransport(config: McpServerConfig, resolver: ResolveMcpBearer | null): Promise<Transport> {
  switch (config.transport) {
    case 'stdio': {
      if (!config.command) throw new Error(`stdio server "${config.id}" requires a command`);
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
      });
    }
    case 'sse': {
      if (!config.url) throw new Error(`sse server "${config.id}" requires a url`);
      await buildAuthHeaders(config, resolver);
      const authenticatedFetch = authenticatedMcpFetch(config, resolver);
      return new SSEClientTransport(new URL(config.url), {
        fetch: authenticatedFetch,
        eventSourceInit: { fetch: authenticatedFetch as typeof fetch },
      });
    }
    case 'streamable_http': {
      if (!config.url) throw new Error(`streamable_http server "${config.id}" requires a url`);
      await buildAuthHeaders(config, resolver);
      return new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: authenticatedMcpFetch(config, resolver),
      });
    }
    default:
      throw new Error(`Unsupported transport "${config.transport}" for server "${config.id}"`);
  }
}

/** Resolve credentials before each request, including SSE reconnects.
 * Never replay a tools/call after a 401 or an ambiguous network failure. */
export function authenticatedMcpFetch(config: McpServerConfig, resolver: ResolveMcpBearer | null): typeof fetchWithMcpDispatch {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    const extra = (config.config.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    try {
      for (const [key, value] of Object.entries(await buildAuthHeaders(config, resolver))) headers.set(key, value);
      init?.signal?.throwIfAborted();
    } catch (e) {
      // No request has left the process; do not turn auth/network refresh
      // failures into an ambiguous tools/call outcome that blocks the chat.
      throw new McpDispatchRejected(e instanceof Error ? e.message : String(e));
    }
    const response = await fetchWithMcpDispatch(url, { ...init, headers, redirect: 'error' });
    if (response.status === 401 && config.auth_type === 'oauth2') {
      resolver?.rejectToken(config.id, (headers.get('authorization') ?? '').replace(/^Bearer /, ''));
    }
    return response;
  };
}

export function mcpServerConfigurationKey(config: McpRuntimeConfig): string {
  // Servers can register again after a reload without changing their connection settings.
  const { updated_at: _updatedAt, ...settings } = config;
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}
