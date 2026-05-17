/**
 * Parser for `.mcp.json` files bundled with Agent Skills repos.
 *
 * Shape follows the Claude Code / Cloudflare convention:
 *   {
 *     "mcpServers": {
 *       "key": { "type": "http" | "sse" | "stdio", "url"?: string,
 *                "command"?: string, "args"?: string[], "env"?: {} }
 *     }
 *   }
 *
 * Each entry is mapped to an `UpsertMcpServerInput` for our MCP server
 * store. The origin namespace is stored in `config.installed_by_namespace`
 * so the installer can list/uninstall entries it created.
 */
import type {
  UpsertMcpServerInput,
  McpTransport,
} from '@mcp/store/mcp-server-store.js';

interface RawMcpEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export function parseMcpJson(
  content: string,
  namespace: string,
): UpsertMcpServerInput[] {
  const json = JSON.parse(content) as {
    mcpServers?: Record<string, RawMcpEntry>;
  };
  const out: UpsertMcpServerInput[] = [];
  for (const [key, e] of Object.entries(json.mcpServers ?? {})) {
    const transport = inferTransport(e);
    out.push({
      id: makeId(namespace, key),
      name: `${namespace}:${key}`,
      transport,
      enabled: true,
      url: transport !== 'stdio' ? (e.url ?? null) : null,
      command: transport === 'stdio' ? (e.command ?? null) : null,
      args: e.args ?? [],
      env: e.env ?? {},
      auth_type: 'none',
      default_tier: namespace,
      config: { installed_by_namespace: namespace, raw: e },
    });
  }
  return out;
}

function inferTransport(e: RawMcpEntry): McpTransport {
  if (e.type === 'stdio' || e.command) return 'stdio';
  if (e.type === 'sse' || e.url?.endsWith('/sse')) return 'sse';
  return 'streamable_http';
}

/** Schema validates `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`, max 32 chars. */
function makeId(ns: string, key: string): string {
  const raw = `${ns}-${key}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = raw.slice(0, 32).replace(/-+$/, '');
  return trimmed || `${ns}-mcp`.slice(0, 32);
}
