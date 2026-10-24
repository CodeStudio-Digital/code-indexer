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
import { AsyncLocalStorage } from 'node:async_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { normalizeMcpToolResult, mcpToolResultFields, type McpTool } from '../tool.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthContext } from '@mcp/services/auth/domain/auth-context.js';
import type { McpConnectionPolicy, McpTier } from '@mcp/services/auth/domain/api-token.js';
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
import { resourcePage } from '../resources/page.js';
import { coerceArgs } from '../utils.js';
import { SessionManager } from './session-manager.js';

/**
 * Numeric rank for tier comparison. A token at tier N can see tools at
 * any tier ≤ N. Order mirrors the agent's expand_toolset promotion
 * sequence: bootstrap is the minimal read/search set, navigate adds
 * write/git read, admin adds mutations.
 *
 * Unknown tool tiers (from the catch-all fallback in `getToolTier`)
 * default to bootstrap, which is the most permissive — same policy as
 * the agent uses for its own catalog.
 */
const TIER_RANK: Record<string, number> = {
  bootstrap: 0,
  navigate: 1,
  admin: 2,
};

function tierRank(tier: McpTier): number {
  return TIER_RANK[tier];
}

/**
 * Returns true when `tool` is at or below the caller's tier. When
 * the caller has no tier (legacy scope-only tokens, or unauthenticated
 * requests in dev), tier filtering is skipped — scope enforcement still
 * applies further down.
 */
export function isToolAllowedForTier(tool: McpTool, callerTier: McpTier | null | undefined): boolean {
  if (!callerTier) return true; // no tier binding → no tier filter
  return tierRank(tool.tier) <= tierRank(callerTier);
}

export function isToolAllowedForPolicy(tool: McpTool, policy: McpConnectionPolicy | null | undefined): boolean {
  if (!policy) return true;
  if (policy.toolAllowlist.length > 0 && !policy.toolAllowlist.includes(tool.name)) return false;
  if (policy.approvalMode === 'read_only') return tool.annotations.readOnlyHint;
  if (policy.approvalMode === 'controlled') {
    return tool.scope !== 'mcp:admin' && !tool.annotations.destructiveHint;
  }
  return true;
}

function applyProjectPolicy(
  tool: McpTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
  policy: McpConnectionPolicy | null | undefined,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!policy || policy.projectIds.length === 0) return { ok: true, args };
  if (tool.name === 'index_project') {
    return { ok: false, error: 'Project-scoped profiles cannot register arbitrary filesystem paths' };
  }

  const properties = tool.inputSchema.properties ?? {};
  if (!Object.prototype.hasOwnProperty.call(properties, 'project_name')) return { ok: true, args };

  const allowed = ctx.db.listProjects().filter((project) => policy.projectIds.includes(project.id));
  if (allowed.length === 0) return { ok: false, error: 'This profile has no accessible projects' };

  const requested = typeof args.project_name === 'string' ? args.project_name.trim() : '';
  if (!requested && allowed.length === 1) {
    return { ok: true, args: { ...args, project_name: allowed[0].name } };
  }
  if (!requested) {
    return { ok: false, error: 'project_name is required because this profile grants multiple projects' };
  }
  const selected = allowed.find((project) => project.name === requested || String(project.id) === requested);
  if (!selected) return { ok: false, error: `Project '${requested}' is outside this profile` };
  return { ok: true, args: { ...args, project_name: selected.name } };
}

function isResourceAllowedForPolicy(
  uri: string,
  ctx: ToolContext,
  policy: McpConnectionPolicy | null | undefined,
): boolean {
  if (!policy || policy.projectIds.length === 0) return true;
  const match = /^mcp:\/\/(?:project|snapshot)\/([^/]+)/.exec(uri);
  if (!match) return true;
  let projectName = match[1];
  try { projectName = decodeURIComponent(projectName); } catch { /* keep raw segment */ }
  const project = ctx.db.listProjects().find((candidate) => candidate.name === projectName);
  return Boolean(project && policy.projectIds.includes(project.id));
}

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
  const authContexts = new AsyncLocalStorage<AuthContext | undefined>();
  const currentAuthCtx = () => authContexts.getStore();
  const handleStatelessRequest = async (request: Request) => {
    // SDK stateless transports have one request lifetime. Reusing one after
    // initialize makes every subsequent tools/list or tools/call fail.
    const server = buildServer(ctx, registry, currentAuthCtx, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    // JSON mode resolves only after the complete response has been produced.
    try { return await transport.handleRequest(request); }
    finally { await server.close(); }
  };

  const app = new Hono();

  if (deps.beforeTransport) app.use('*', deps.beforeTransport);

  // All MCP traffic (POST/GET/DELETE) lands on the root of this sub-app.
  app.all('/', async (c) => {
    const authCtx = deps.resolveAuthContext?.(c);
    // AsyncLocalStorage binds authentication to the complete asynchronous
    // request chain. Concurrent MCP calls cannot overwrite each other's
    // principal, tier or scopes.
    return authContexts.run(authCtx, async () => {
      if (!config.mcp.http.stateful) {
        if (c.req.method === 'GET') return c.json({ error: 'Stateless MCP uses JSON POST responses' }, 405, { Allow: 'POST' });
        return handleStatelessRequest(c.req.raw);
      }
      const transport = await resolveStatefulTransport(c.req.raw, sessions, ctx, registry, currentAuthCtx, deps);
      return transport.handleRequest(c.req.raw);
    });
  });

  return app;
}

// ── Stateful: per-session transport, looked up by Mcp-Session-Id header. ──

async function resolveStatefulTransport(
  req: Request,
  sessions: SessionManager,
  ctx: ToolContext,
  registry: Map<string, McpTool>,
  currentAuthCtx: () => AuthContext | undefined,
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
  const server = buildServer(ctx, registry, currentAuthCtx, deps);
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
  registry: Map<string, McpTool>,
  currentAuthCtx: () => AuthContext | undefined,
  deps: McpHttpDeps,
): Server {
  const server = new Server(
    { name: PACKAGE_NAME, version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'CodeStudio exposes project-aware code navigation, documentation, memory and controlled agent execution. ' +
        'Start with read-only bootstrap tools, pass project_name when requested, and use write/admin tools only when the task requires mutation.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const authCtx = currentAuthCtx();
    const callerTier = authCtx?.tier ?? null;
    // Tier filtering happens here (not in CallTool) so the listing the
    // client sees matches what it can actually invoke — prevents the
    // "tool advertised but rejected" UX problem in MCP clients.
    const visible = allTools.filter((tool) =>
      isToolAllowedForTier(tool, callerTier)
      && isToolAllowedForPolicy(tool, authCtx?.policy)
      && (!authCtx || !deps.enforceScope || authCtx.scopes.grants(tool.scope)),
    );
    return {
      tools: visible.map(({ name, description, inputSchema, annotations }) => ({
        name, description, inputSchema, annotations,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = registry.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const authCtx = currentAuthCtx();

    // Tier gate runs BEFORE scope enforcement so the audit log carries
    // a tier-specific reason ("Tool 'x' requires tier 'navigate', token
    // has 'bootstrap'") rather than a generic scope_denied.
    const callerTier = authCtx?.tier ?? null;
    if (callerTier && !isToolAllowedForTier(tool, callerTier)) {
      const required = tool.tier;
      deps.audit?.execute({
        principal: authCtx?.principal ?? null,
        tokenType: authCtx?.tokenType ?? null,
        event: 'scope_denied',
        status: 403,
        toolName: name,
        meta: { tierRequired: required, tierGranted: callerTier },
      });
      return {
        content: [
          {
            type: 'text',
            text: `Tool '${name}' requires tier '${required}', token has '${callerTier}'. Issue a higher-tier token or expand the tier in admin.`,
          },
        ],
        isError: true,
      };
    }

    if (!isToolAllowedForPolicy(tool, authCtx?.policy)) {
      deps.audit?.execute({
        principal: authCtx?.principal ?? null,
        tokenType: authCtx?.tokenType ?? null,
        event: 'scope_denied',
        status: 403,
        toolName: name,
        meta: { profileId: authCtx?.policy?.id ?? null, reason: 'profile_policy' },
      });
      return {
        content: [{ type: 'text', text: `Tool '${name}' is not allowed by connection profile '${authCtx?.policy?.name ?? ''}'.` }],
        isError: true,
      };
    }

    // Scope enforcement — only applies when auth is enabled (authCtx defined)
    // AND the deployment wired an EnforceScope use-case. Fail-safe default
    // is declared explicitly by every tool in the registry.
    if (authCtx && deps.enforceScope) {
      const required = tool.scope;
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
      const projectGate = applyProjectPolicy(tool, args, ctx, authCtx?.policy);
      if (!projectGate.ok) {
        deps.audit?.execute({
          principal: authCtx?.principal ?? null,
          tokenType: authCtx?.tokenType ?? null,
          event: 'scope_denied',
          status: 403,
          toolName: name,
          meta: { profileId: authCtx?.policy?.id ?? null, reason: projectGate.error },
        });
        return { content: [{ type: 'text', text: projectGate.error }], isError: true };
      }
      extra.signal.throwIfAborted();
      const result = normalizeMcpToolResult(await tool.handler(projectGate.args, { ...ctx, signal: extra.signal }, authCtx));
      extra.signal.throwIfAborted();
      deps.audit?.execute({
        principal: authCtx?.principal ?? null,
        tokenType: authCtx?.tokenType ?? null,
        event: result.effectOutcome ? 'tool_call_error' : 'tool_call_ok',
        status: result.effectOutcome ? 500 : 200,
        toolName: name,
        meta: result.effectOutcome ? { effectOutcome: result.effectOutcome } : {},
      });
      return {
        content: [{ type: 'text', text: result.text }],
        ...mcpToolResultFields(result),
      };
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

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
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
    const resources = await collectListedResources(ctx, authCtx);
    const page = resourcePage(resources.filter((resource) =>
        isResourceAllowedForPolicy(resource.uri, ctx, authCtx?.policy),
      ), 'resources', request.params?.cursor);
    return { resources: page.items, nextCursor: page.nextCursor };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    const page = resourcePage(allResources.map((r) => ({
      uriTemplate: r.uriTemplate,
      name: r.name,
      description: r.description,
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    })), 'templates', request.params?.cursor);
    return { resourceTemplates: page.items, nextCursor: page.nextCursor };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const authCtx = currentAuthCtx();
    if (!isResourceAllowedForPolicy(uri, ctx, authCtx?.policy)) {
      throw new Error('Resource is outside this connection profile');
    }
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
