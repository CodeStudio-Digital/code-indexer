/**
 * Admin route exposing the runtime status of the MCP HTTP endpoint —
 * what URL clients should hit, how many tools each tier sees, whether
 * auth is on, etc. The admin panel polls this so we don't hard-code
 * any of those answers in the dashboard bundle (they're config-driven
 * on the server).
 */
import { Hono } from 'hono';
import { allTools } from '@apps/mcp-server/tools/index.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { McpTool } from '@apps/mcp-server/tool.js';
import { McpConnectionProfileStore } from '@mcp/store/mcp-connection-profile-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { listCustomAgents, resolveAgentSelection } from '../custom-agents.js';
import { getGlobalMcpExternalPool } from '../sse/McpExternalPool.js';
import { AGENTS } from '@mcp/code-agent/agents/index.js';

interface ToolSummary {
  name: string;
  tier: string;
  scope: string;
  readOnly: boolean;
  description: string;
}

function safeAgentSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'codestudio-agent';
}

function quoteToml(value: string): string {
  return JSON.stringify(value);
}

export function createMcpHttpStatusRouter(
  config: IndexerConfig,
  db: CodeIndexDB,
  providerStore: ProviderStore,
): Hono {
  const app = new Hono();

  app.get('/mcp-http/agent-export', (c) => {
    const agentId = c.req.query('agent_id') ?? '';
    const target = c.req.query('target');
    if (target !== 'claude' && target !== 'codex') {
      return c.json({ error: 'target must be claude or codex' }, 400);
    }
    const resolved = resolveAgentSelection(providerStore, agentId, { includeDisabled: true });
    if (!resolved) return c.json({ error: 'Agent not found' }, 404);

    const slug = safeAgentSlug(resolved.custom?.name ?? resolved.base.label);
    const description = resolved.custom?.description || resolved.base.description;
    const instructions = [
      resolved.custom?.prompt || `Operate as CodeStudio's ${resolved.base.label} agent. ${resolved.base.description}`,
      '',
      'Use the globally configured CodeStudio MCP server for project context, documentation and memory.',
      'When delegating a longer task back to CodeStudio, call start_agent_run and poll get_agent_result instead of blocking the client.',
      `Preferred CodeStudio agent id: ${resolved.selectionId}.`,
    ].join('\n');

    if (target === 'claude') {
      const content = [
        '---',
        `name: ${slug}`,
        `description: ${JSON.stringify(description)}`,
        ...(resolved.base.planMode ? ['permissionMode: plan'] : []),
        '---',
        '',
        instructions,
        '',
      ].join('\n');
      return c.json({
        target,
        fileName: `.claude/agents/${slug}.md`,
        content,
        mcpConfig: 'Use the Claude Code configuration shown on this page.',
      });
    }

    const content = [
      `name = ${quoteToml(resolved.custom?.name ?? resolved.base.label)}`,
      `description = ${quoteToml(description)}`,
      `developer_instructions = ${quoteToml(instructions)}`,
      `sandbox_mode = ${quoteToml(resolved.base.profile === 'bootstrap' ? 'read-only' : 'workspace-write')}`,
      '',
      '[mcp_servers.codestudio]',
      `url = ${quoteToml(`http://127.0.0.1:${config.dashboard.port}${config.mcp.http.path}`)}`,
      ...(config.mcp.auth.enabled ? ['bearer_token_env_var = "CODESTUDIO_MCP_TOKEN"'] : []),
      'tool_timeout_sec = 60',
      '',
    ].join('\n');
    return c.json({
      target,
      fileName: `.codex/agents/${slug}.toml`,
      content,
      mcpConfig: 'Use the Codex config.toml block shown on this page.',
    });
  });

  app.post('/mcp-http/codex-bridge', async (c) => {
    const store = new McpServerStore(config.dbPath);
    try {
      const server = store.upsertServer({
        id: 'codex-cli',
        name: 'Codex CLI',
        transport: 'stdio',
        enabled: true,
        command: 'codex',
        args: ['mcp-server'],
        env: {},
        auth_type: 'none',
        default_tier: 'navigate',
        config: { managedBy: 'mcp-http', purpose: 'codex-agent-bridge' },
      });
      const pool = getGlobalMcpExternalPool();
      if (pool) await pool.refresh();
      return c.json({
        server: { id: server.id, name: server.name, enabled: server.enabled },
        connected: Boolean(pool),
        note: pool
          ? 'Codex CLI MCP was registered and the external pool was refreshed.'
          : 'Codex CLI MCP was registered and will connect on the next server boot.',
      }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    } finally {
      store.close();
    }
  });

  app.get('/mcp-http/profiles', (c) => {
    const store = new McpConnectionProfileStore(config.dbPath);
    try {
      return c.json({ profiles: store.listProfiles() });
    } finally {
      store.close();
    }
  });

  app.post('/mcp-http/profiles', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const store = new McpConnectionProfileStore(config.dbPath);
    try {
      const profile = store.upsertProfile({
        id: typeof body.id === 'string' ? body.id : '',
        name: typeof body.name === 'string' ? body.name : '',
        description: typeof body.description === 'string' ? body.description : '',
        projectIds: Array.isArray(body.projectIds) ? body.projectIds.map(Number) : [],
        toolAllowlist: Array.isArray(body.toolAllowlist) ? body.toolAllowlist.map(String) : [],
        agentAllowlist: Array.isArray(body.agentAllowlist) ? body.agentAllowlist.map(String) : [],
        approvalMode: body.approvalMode as 'read_only' | 'controlled' | 'admin' | undefined,
        maxConcurrentRuns: body.maxConcurrentRuns === undefined ? undefined : Number(body.maxConcurrentRuns),
        maxRuntimeMs: body.maxRuntimeMs === undefined ? undefined : Number(body.maxRuntimeMs),
      });
      return c.json({ profile }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    } finally {
      store.close();
    }
  });

  app.delete('/mcp-http/profiles/:id', (c) => {
    const store = new McpConnectionProfileStore(config.dbPath);
    try {
      return store.deleteProfile(c.req.param('id'))
        ? c.body(null, 204)
        : c.json({ error: 'Profile not found' }, 404);
    } finally {
      store.close();
    }
  });

  app.get('/mcp-http/status', (c) => {
    // Compute on every request because the tool catalogue is static
    // per process and the cost is trivial (~150 lookups). Saves us
    // from invalidating a cache on hot-reload.
    const tools: ToolSummary[] = (allTools as readonly McpTool[]).map((t) => ({
      name: t.name,
      tier: t.tier,
      scope: t.scope,
      readOnly: t.annotations.readOnlyHint,
      description: t.description.split('\n')[0].slice(0, 160),
    }));

    const byTier = tools.reduce<Record<string, number>>((acc, t) => {
      acc[t.tier] = (acc[t.tier] ?? 0) + 1;
      return acc;
    }, {});

    // Dashboard host + port + mcp.http.path → the URL clients use.
    // We render localhost explicitly because the host may be 0.0.0.0
    // for the LAN bind, but the endpoint guard rejects non-loopback
    // peers anyway — showing 127.0.0.1 here is the truthful answer.
    const port = config.dashboard.port;
    const endpoint = `http://127.0.0.1:${port}${config.mcp.http.path}`;

    return c.json({
      enabled: config.mcp.http.enabled,
      authEnabled: config.mcp.auth.enabled,
      stateful: config.mcp.http.stateful,
      endpoint,
      configs: {
        claudeCode: JSON.stringify(
          {
            mcpServers: {
              codestudio: {
                type: 'http',
                url: endpoint,
                ...(config.mcp.auth.enabled
                  ? { headers: { Authorization: 'Bearer <paste-your-token-here>' } }
                  : {}),
              },
            },
          },
          null,
          2,
        ),
        codex:
          `[mcp_servers.codestudio]\nurl = "${endpoint}"\n` +
          (config.mcp.auth.enabled
            ? 'bearer_token_env_var = "CODESTUDIO_MCP_TOKEN"\n'
            : '') +
          'tool_timeout_sec = 60',
      },
      port,
      path: config.mcp.http.path,
      projects: db.listProjects().map((project) => ({
        id: project.id,
        name: project.name,
        rootPath: project.root_path,
      })),
      agents: [
        ...Object.values(AGENTS).map((agent) => ({
          id: agent.id,
          name: agent.label,
          description: agent.description,
        })),
        ...listCustomAgents(providerStore).map((agent) => ({
          id: agent.selectionId,
          name: agent.name,
          description: agent.description,
        })),
      ],
      tools,
      counts: {
        total: tools.length,
        bootstrap: byTier.bootstrap ?? 0,
        navigate: byTier.navigate ?? 0,
        admin: byTier.admin ?? 0,
      },
    });
  });

  return app;
}
