import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMcpJson } from '@mcp/code-agent/skills/mcp-json-parser.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import type { InstalledMcpSummary } from '../types.js';

/** Register MCP servers declared in `{baseDir}/.mcp.json`, tagged by namespace. */
export async function applyMcp(opts: {
  dbPath: string;
  baseDir: string;
  namespace: string;
}): Promise<{ installed: InstalledMcpSummary[]; warnings: string[] }> {
  const { dbPath, baseDir, namespace } = opts;
  const installed: InstalledMcpSummary[] = [];
  const warnings: string[] = [];

  let content: string;
  try {
    content = await readFile(join(baseDir, '.mcp.json'), 'utf8');
  } catch {
    return { installed, warnings }; // no .mcp.json — nothing to do
  }

  let inputs;
  try {
    inputs = parseMcpJson(content, namespace);
  } catch (e) {
    warnings.push(`.mcp.json parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return { installed, warnings };
  }

  const store = new McpServerStore(dbPath);
  try {
    for (const input of inputs) {
      const existing = store.getServer(input.id);
      if (existing) {
        const cfg = (existing.config ?? {}) as { installed_by_namespace?: string };
        if (cfg.installed_by_namespace !== namespace) {
          warnings.push(`MCP server id "${input.id}" already exists (unmanaged) — skipped`);
          continue;
        }
        // Preserve user-configured auth across re-install.
        if (existing.auth_token) {
          input.auth_token = existing.auth_token;
          input.auth_type = existing.auth_type;
        }
      }
      const up = store.upsertServer(input);
      installed.push({ id: up.id, name: up.name, transport: up.transport });
    }
  } finally {
    store.close();
  }
  return { installed, warnings };
}
