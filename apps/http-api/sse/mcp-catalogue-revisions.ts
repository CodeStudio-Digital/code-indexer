import { createHash, randomUUID } from 'node:crypto';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { mcpServerConfigurationKey } from '@mcp/code-agent/tools/mcp-server-manager.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';

interface ToolRevision {
  serverId: string;
  definition: string;
  revision: string;
}

/** A transport outage is not a new tool contract. Retain identities only for
 * unavailable sources; an authoritative removal or config edit revokes them.
 * This cache never establishes availability or permission to dispatch. */
export class McpCatalogueRevisions {
  private readonly entries = new Map<string, ToolRevision>();
  private configurations = new Map<string, string>();

  get(name: string): ToolRevision | undefined { return this.entries.get(name); }

  reconcileConfigurations(configs: McpServerConfig[]): void {
    const next = new Map(configs.map(config => [config.id, mcpServerConfigurationKey(config)]));
    for (const [name, entry] of this.entries) {
      if (!next.has(entry.serverId) || next.get(entry.serverId) !== this.configurations.get(entry.serverId)) {
        this.entries.delete(name);
      }
    }
    this.configurations = next;
  }

  update(tools: CoderTool[], configs: McpServerConfig[],
    states: ReadonlyMap<string, { state: string }>): void {
    this.reconcileConfigurations(configs);
    const names = new Set(tools.map(tool => tool.name));
    for (const [name, entry] of this.entries) {
      // Only a successful listing proves absence. A failed/closed transport
      // cannot revoke every tool held by all the already-running sessions.
      if (!names.has(name) && states.get(entry.serverId)?.state === 'connected') this.entries.delete(name);
    }
    const byLongestId = [...configs].sort((a, b) => b.id.length - a.id.length);
    for (const tool of tools) {
      const serverId = tool.capabilityProvenance?.serverId
        ?? byLongestId.find(config => tool.name.startsWith(`ext_${config.id}__`))?.id;
      if (!serverId || !this.configurations.has(serverId)) continue;
      const definition = createHash('sha256').update(JSON.stringify(canonicalize([
        this.configurations.get(serverId), tool.name, tool.description, tool.parameters,
        tool.repeatPolicy, tool.mutates, tool.riskLevel,
      ]))).digest('hex');
      const previous = this.entries.get(tool.name);
      this.entries.set(tool.name, previous?.definition === definition ? previous
        : { serverId, definition, revision: randomUUID() });
    }
  }

  clear(): void { this.entries.clear(); this.configurations.clear(); }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonicalize(item)]));
}
