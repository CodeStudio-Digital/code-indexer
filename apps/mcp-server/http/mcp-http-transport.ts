/**
 * MCP HTTP transport — exposes the same tool registry as the stdio entry
 * point over the Streamable HTTP transport (MCP spec 2025-03-26).
 *
 * Kept in its own module so the stdio entry point (src/apps/mcp-server/index.ts)
 * does not need to import any HTTP dependencies. This file is only loaded
 * when MCP_HTTP_ENABLED=true.
 *
 * Auth is intentionally NOT part of this phase — the middleware and routes
 * that add API token / OAuth protection layer on top without changing
 * anything here.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { EnforceScope } from '@mcp/services/auth/use-cases/enforce-scope.js';
import type { RecordAudit } from '@mcp/services/auth/use-cases/record-audit.js';
import { PACKAGE_NAME, VERSION } from '@mcp/shared/version.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { buildContext, type ToolContext } from '../context.js';
import { allTools, buildToolRegistry } from '../tools/index.js';
import {
  allResources,
  collectListedResources,
  readResource,
  DEFAULT_RESOURCE_SCOPE,
} from '../resources/index.js';
import { coerceArgs } from '../utils.js';
import { SessionManager } from './session-manager.js';

const DEFAULT_TOOL_SCOPE = 'mcp:write';

export interface McpHttpDeps {
  /** Resolves a request-bound AuthContext from Hono's variable bag. */
  resolveAuthContext?: (c: import('hono').Context) => AuthContext | undefined;
  /** Middleware to run before the transport handler (auth, rate limit, ...). */
  beforeTransport?: import('hono').MiddlewareHandler;
  /** Policy check invoked before a tool handler runs. */
  enforceScope?: EnforceScope;
  /** Audit sink — receives tool_call_ok / tool_call_error / scope_denied. */
  audit?: RecordAudit;
}

/**
 * Build the Hono sub-app that serves the MCP endpoint. Stateless by default.
 * Stateful mode opts-in via config.mcp.http.stateful.
 */
export function createMcpHttpApp(
  config: IndexerConfig,
  deps: McpHttpDeps = {},
): Hono {
  const ctx = buildContext();
  const registry = buildToolRegistry();
  const sessions = new SessionManager();

  const app = new Hono();

  if (deps.beforeTransport) app.use('*', deps.beforeTransport);

  // All MCP traffic (POST/GET/DELETE) lands on the root of this sub-app.
  app.all('/', async (c) => {
    const authCtx = deps.resolveAuthContext?.(c);

    const transport = config.mcp.http.stateful
      ? await resolveStatefulTransport(c.req.raw, sessions, ctx, registry, authCtx, deps)
      : await ensureStatelessTransport(ctx, registry, authCtx, deps);

    return transport.handleRequest(c.req.raw);
  });

  return app;
}

// ── Stateless: one transport reused across all requests. ──

let statelessTransport: WebStandardStreamableHTTPServerTransport | null = null;
let statelessAuthCtx: AuthContext | undefined;

async function ensureStatelessTransport(
  ctx: ToolContext,
  registry: Map<string, import('../tool.js').McpTool>,
  authCtx: AuthContext | undefined,
  deps: McpHttpDeps,
): Promise<WebStandardStreamableHTTPServerTransport> {
  // Per-request authCtx update — handlers read a closure variable that is
  // set right before handleRequest runs. This works because Node processes
  // one handler at a time per event-loop tick; the closure sees the latest
  // value for the current in-flight request.
  statelessAuthCtx = authCtx;

  if (statelessTransport) return statelessTransport;

  const server = buildServer(ctx, registry, () => statelessAuthCtx, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  statelessTransport = transport;
  return transport;
}

// ── Stateful: per-session transport, looked up by Mcp-Session-Id header. ──

async function resolveStatefulTransport(
  req: Request,
  sessions: SessionManager,
  ctx: ToolContext,
  registry: Map<string, import('../tool.js').McpTool>,
  authCtx: AuthContext | undefined,
  deps: McpHttpDeps,
): Promise<WebStandardStreamableHTTPServerTransport> {
  const sessionId = req.headers.get('mcp-session-id') ?? undefined;
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
  }

  // Either there's no session header (initialize request) or the header
  // is unknown — create a fresh transport. Invalid session IDs are rejected
  // downstream by the SDK's validateSession.
  const server = buildServer(ctx, registry, () => authCtx, deps);
  const transport: WebStandardStreamableHTTPServerTransport =
    new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => sessions.add(id, transport),
      onsessionclosed: (id: string) => sessions.delete(id),
      enableJsonResponse: false,
    });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await server.connect(transport);
  return transport;
}

// ── Shared: MCP server wiring (tool list + call). ──

function buildServer(
  ctx: ToolContext,
  registry: Map<string, import('../tool.js').McpTool>,
  currentAuthCtx: () => AuthContext | undefined,
  deps: McpHttpDeps,
): Server {
  const server = new Server(
    { name: PACKAGE_NAME, version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = registry.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const authCtx = currentAuthCtx();

    // Scope enforcement — only applies when auth is enabled (authCtx defined)
    // AND the deployment wired an EnforceScope use-case. Fail-safe default
    // is 'mcp:write' when the tool omits the `scope` field.
    if (authCtx && deps.enforceScope) {
      const required = tool.scope ?? DEFAULT_TOOL_SCOPE;
      const gate = deps.enforceScope.execute(authCtx, required);
      if (!gate.ok) {
        deps.audit?.execute({
          principal: authCtx.principal,
          tokenType: authCtx.tokenType,
          event: 'scope_denied',
          status: 403,
          toolName: name,
          meta: { required, granted: authCtx.scopes.values() },
        });
        return {
          content: [{ type: 'text', text: `Scope '${required}' required for tool '${name}'` }],
          isError: true,
        };
      }
    }

    try {
      const args = coerceArgs((rawArgs ?? {}) as Record<string, unknown>);
      const result = await tool.handler(args, ctx, authCtx);
      deps.audit?.execute({
        principal: authCtx?.principal ?? null,
        tokenType: authCtx?.tokenType ?? null,
        event: 'tool_call_ok',
        status: 200,
        toolName: name,
        meta: {},
      });
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      deps.audit?.execute({
        principal: authCtx?.principal ?? null,
        tokenType: authCtx?.tokenType ?? null,
        event: 'tool_call_error',
        status: 500,
        toolName: name,
        meta: { error: msg },
      });
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  // ── MCP resources ─────────────────────────────────────────────────
  // Scope enforcement: all resources default to DEFAULT_RESOURCE_SCOPE
  // ('mcp:read'). Listing requires the same scope as reading — a
  // principal that cannot read individual resources should not enumerate
  // them either.

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const authCtx = currentAuthCtx();
    if (authCtx && deps.enforceScope) {
      const gate = deps.enforceScope.execute(authCtx, DEFAULT_RESOURCE_SCOPE);
      if (!gate.ok) {
        deps.audit?.execute({
          principal: authCtx.principal,
          tokenType: authCtx.tokenType,
          event: 'scope_denied',
          status: 403,
          toolName: 'resources/list',
          meta: { required: DEFAULT_RESOURCE_SCOPE, granted: [...authCtx.scopes.values()] },
        });
        return { resources: [] };
      }
    }
    return { resources: await collectListedResources(ctx, authCtx) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: allResources.map((r) => ({
      uriTemplate: r.uriTemplate,
      name: r.name,
      description: r.description,
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const authCtx = currentAuthCtx();
    if (authCtx && deps.enforceScope) {
      const gate = deps.enforceScope.execute(authCtx, DEFAULT_RESOURCE_SCOPE);
      if (!gate.ok) {
        deps.audit?.execute({
          principal: authCtx.principal,
          tokenType: authCtx.tokenType,
          event: 'scope_denied',
          status: 403,
          toolName: 'resources/read',
          meta: { uri, required: DEFAULT_RESOURCE_SCOPE, granted: [...authCtx.scopes.values()] },
        });
        throw new Error(`Scope '${DEFAULT_RESOURCE_SCOPE}' required to read resource`);
      }
    }
    try {
      const result = await readResource(uri, ctx, authCtx);
      if (!result) {
        deps.audit?.execute({
          principal: authCtx?.principal ?? null,
          tokenType: authCtx?.tokenType ?? null,
          event: 'resource_read_error',
          status: 404,
          toolName: null,
          meta: { uri, error: 'not_found' },
        });
        throw new Error(`Resource not found: ${uri}`);
      }
      deps.audit?.execute({
        principal: authCtx?.principal ?? null,
        tokenType: authCtx?.tokenType ?? null,
        event: 'resource_read_ok',
        status: 200,
        toolName: null,
        meta: { uri, resource: result.resource.name },
      });
      return {
        contents: result.contents.map((c) =>
          c.type === 'text'
            ? { uri, mimeType: c.mimeType ?? result.resource.mimeType ?? 'text/plain', text: c.text }
            : { uri, mimeType: c.mimeType ?? result.resource.mimeType ?? 'application/octet-stream', blob: c.blob },
        ),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 404 already audited above; other errors get a separate record so
      // the not_found path isn't double-counted.
      if (!msg.startsWith('Resource not found:')) {
        deps.audit?.execute({
          principal: authCtx?.principal ?? null,
          tokenType: authCtx?.tokenType ?? null,
          event: 'resource_read_error',
          status: 500,
          toolName: null,
          meta: { uri, error: msg },
        });
      }
      throw error;
    }
  });

  return server;
}
