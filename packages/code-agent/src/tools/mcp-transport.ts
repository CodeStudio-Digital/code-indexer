import { createHash } from 'node:crypto';
import { fetchWithMcpDispatch, McpDispatchRejected, withMcpWireDispatch } from './mcp-wire-dispatch.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
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
 * Returns empty object when auth_type=none OR when OAuth has no tokens
 * yet — connection then proceeds unauthenticated and the server's 401
 * prompts the user to connect via the dashboard.
 */
export async function buildAuthHeaders(
  config: McpServerConfig,
  resolver: ResolveMcpBearer | null,
): Promise<Record<string, string>> {
  if (config.auth_type === 'oauth2') {
    if (!resolver) return {};
    const result = await resolver.execute(config.id);
    if (!result.ok) {
      console.warn(
        `[mcp-ext] OAuth bearer unavailable for "${config.id}": ${mcpAuthClientErrorMessage(result.error)}`,
      );
      return {};
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
      const authHeaders = await buildAuthHeaders(config, resolver);
      const extraHeaders = (config.config as Record<string, unknown>).headers as
        | Record<string, string>
        | undefined ?? {};
      const headers = { ...extraHeaders, ...authHeaders };
      const hasHeaders = Object.keys(headers).length > 0;
      // SSE transport needs headers on both the EventSource (GET) and POST requests.
      // eventSourceInit.fetch wraps the SSE GET; requestInit covers recurring POSTs.
      const opts: Record<string, unknown> = { fetch: fetchWithMcpDispatch };
      if (hasHeaders) {
        opts.requestInit = { headers };
        opts.eventSourceInit = {
          fetch: (url: string | URL, init: Record<string, unknown>) =>
            globalThis.fetch(url, {
              ...(init as RequestInit),
              headers: { ...(init?.headers as Record<string, string> ?? {}), ...headers },
            }),
        };
      }
      return new SSEClientTransport(new URL(config.url), opts as never);
    }
    case 'streamable_http': {
      if (!config.url) throw new Error(`streamable_http server "${config.id}" requires a url`);
      const authHeaders = await buildAuthHeaders(config, resolver);
      const extraHeaders = (config.config as Record<string, unknown>).headers as
        | Record<string, string>
        | undefined ?? {};
      const headers = { ...extraHeaders, ...authHeaders };
      const hasHeaders = Object.keys(headers).length > 0;
      return new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: fetchWithMcpDispatch,
        requestInit: hasHeaders ? { headers } : undefined,
      });
    }
    default:
      throw new Error(`Unsupported transport "${config.transport}" for server "${config.id}"`);
  }
}

export function mcpServerConfigurationKey(config: McpServerConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
