import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { LSP_SERVER_REGISTRY } from './built-in-server-catalog.js';
import type { LspServerDef } from './lsp-server-types.js';
import {
  pluginDefinitionFingerprint,
  rehydratePluginLanguageServer,
  type PluginLanguageServerSnapshot,
} from './plugin-language-server-profiles.js';

export type { PluginLanguageServerSnapshot } from './plugin-language-server-profiles.js';

export interface PluginLanguageServerSyncResult {
  added: string[];
  removed: string[];
  changed: string[];
  active: string[];
}

const pluginServers = new Map<string, LspServerDef>();
const builtInIds = new Set(LSP_SERVER_REGISTRY.map((server) => server.id));

export function pluginLanguageServers(): readonly LspServerDef[] {
  return [...pluginServers.values()];
}

export function pluginServerById(id: string): LspServerDef | undefined {
  return pluginServers.get(id);
}

export function pluginProfileServers(): readonly LspServerDef[] {
  return pluginLanguageServers().filter((server) => server.profileId !== undefined);
}

export function pluginServersForFamily(familyId: string): readonly LspServerDef[] {
  return pluginLanguageServers().filter(
    (server) => server.familyId === familyId || (!server.familyId && server.id === familyId),
  );
}

function definitionsFrom(
  entries: Array<{ namespace: string; contribution: PluginLanguageServerSnapshot }>,
): Map<string, LspServerDef> {
  const next = new Map<string, LspServerDef>();
  const claimedFamilies = new Set<string>();
  for (const { namespace, contribution } of entries) {
    const definitions = rehydratePluginLanguageServer(namespace, contribution);
    if (definitions.length === 0) continue;
    const familyId = definitions[0].familyId ?? definitions[0].id;
    if (claimedFamilies.has(familyId) || builtInIds.has(familyId)
      || definitions.some((definition) => builtInIds.has(definition.id) || next.has(definition.id))) continue;
    claimedFamilies.add(familyId);
    for (const definition of definitions) next.set(definition.id, definition);
  }
  return next;
}

function replaceRegistry(next: Map<string, LspServerDef>): PluginLanguageServerSyncResult {
  const previous = new Map(pluginServers);
  pluginServers.clear();
  for (const [id, definition] of next) pluginServers.set(id, definition);
  const active = [...next.keys()];
  return {
    added: active.filter((id) => !previous.has(id)),
    removed: [...previous.keys()].filter((id) => !next.has(id)),
    changed: active.filter((id) => previous.has(id)
      && pluginDefinitionFingerprint(previous.get(id)) !== pluginDefinitionFingerprint(next.get(id))),
    active,
  };
}

/**
 * Rehydrate executable declarations only from enabled bundled plugins. The
 * persisted source check remains the authoritative runtime trust boundary.
 */
export function syncPluginLanguageServers(): PluginLanguageServerSyncResult {
  const entries: Array<{ namespace: string; contribution: PluginLanguageServerSnapshot }> = [];
  try {
    const store = new InstalledPluginStore(loadConfig().dbPath);
    try {
      for (const plugin of store.list({ enabled: true })) {
        if (plugin.source !== 'bundled') continue;
        const contributed = (plugin.contributions as { languageServers?: unknown } | null)?.languageServers;
        if (!Array.isArray(contributed)) continue;
        for (const raw of contributed) {
          if (!raw || typeof raw !== 'object') continue;
          entries.push({
            namespace: plugin.namespace,
            contribution: raw as PluginLanguageServerSnapshot,
          });
        }
      }
    } finally {
      store.close();
    }
  } catch {
    // Startup/unit-test databases may not have reached the plugin migration.
  }
  return replaceRegistry(definitionsFrom(entries));
}

/** Pure seam used by focused tests and host-owned bootstrap code. */
export function replacePluginLanguageServers(
  entries: Array<{ namespace: string; contribution: PluginLanguageServerSnapshot }>,
): PluginLanguageServerSyncResult {
  return replaceRegistry(definitionsFrom(entries));
}

