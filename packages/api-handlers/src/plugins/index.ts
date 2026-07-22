/**
 * Handlers for the `plugins` namespace. Thin delegation to @mcp/plugin-host;
 * host functions resolve the DB path via loadConfig() internally. Permission
 * grants + per-plugin storage use a dedicated store (also loadConfig-resolved).
 */
import {
  ApiError,
  type PluginsApi,
  type PluginInstallInput,
  type PluginInstallSource,
  type InstalledPluginInfo,
  type PluginInstallResult,
  type PluginPermissionsShape,
  type PluginExecChunk,
} from '@mcp/api-bus';
import {
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  getInstalledPlugin,
  setPluginEnabled,
  setPluginPermissionsGranted,
  readPluginAsset,
  execStream,
  isActivated,
  type InstalledPlugin,
} from '@mcp/plugin-host';
import type { PluginSource } from '@mcp/plugin-sdk';
import { MarketClient } from '@mcp/plugin-market-client';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';
import { getLspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import { syncPluginLanguageServers } from '@mcp/services/lsp/server-registry.js';
import type { HandlerDeps } from '../types.js';
import {
  runPluginAssistant,
  resolveAssistantConfirm,
  listAssistantModels,
} from './assistant.js';

function marketClient(): MarketClient {
  const url = process.env.MCP_MARKET_URL;
  if (!url) {
    throw new ApiError('market_not_configured', 503, 'hosted market not configured (set MCP_MARKET_URL)');
  }
  return new MarketClient(url);
}

async function syncLanguageServerContributions(): Promise<void> {
  const { removed, changed } = syncPluginLanguageServers();
  const manager = getLspServerManager();
  const stale = [...new Set([...removed, ...changed])];
  if (manager && stale.length > 0) {
    await Promise.allSettled(stale.map((serverId) => manager.stopServer(serverId)));
  }
}

function declaredPermissions(p: InstalledPlugin | null): PluginPermissionsShape | null {
  return (p?.contributions as { permissions?: PluginPermissionsShape } | null)?.permissions ?? null;
}

function toInfo(p: InstalledPlugin): InstalledPluginInfo {
  return {
    namespace: p.namespace,
    name: p.name,
    version: p.version,
    source: p.source,
    enabled: p.enabled,
    manifest: p.manifest,
    contributions: p.contributions,
    installed_at: p.installed_at,
    updated_at: p.updated_at,
    permissions: declaredPermissions(p),
  };
}

function toSource(s: PluginInstallSource): PluginSource {
  switch (s.source) {
    case 'local':
      return { source: 'local', path: s.path };
    case 'github':
      return { source: 'github', repo: s.repo, ref: s.ref };
    case 'url':
      return { source: 'url', url: s.url };
    case 'market':
      return { source: 'market', name: s.name, ref: s.ref };
  }
}

type ActivationRule = import('@mcp/plugin-host').ActivationRule;
type Activatable = { activation?: ActivationRule };

function filterActivated<T extends Activatable>(items: T[] | undefined, root: string | null): T[] | undefined {
  return items?.filter((item) => isActivated(item.activation, root));
}

function filterActiveContributionShape(
  contributions: Record<string, unknown> | null,
  root: string | null,
): Record<string, unknown> | null {
  if (!contributions) return null;
  const next = { ...contributions } as Record<string, unknown> & {
    tools?: Activatable[];
    toolWindows?: Activatable[];
    editorActions?: Activatable[];
    statusBarItems?: Activatable[];
    runConfigurations?: Activatable[];
    modules?: Array<Activatable & {
      toolWindows?: Activatable[];
      editorActions?: Activatable[];
      statusBarItems?: Activatable[];
      runConfigurations?: Activatable[];
    }>;
  };
  next.tools = filterActivated(next.tools, root);
  next.toolWindows = filterActivated(next.toolWindows, root);
  next.editorActions = filterActivated(next.editorActions, root);
  next.statusBarItems = filterActivated(next.statusBarItems, root);
  next.runConfigurations = filterActivated(next.runConfigurations, root);
  next.modules = next.modules
    ?.filter((m) => isActivated(m.activation, root))
    .map((m) => ({
      ...m,
      toolWindows: filterActivated(m.toolWindows, root),
      editorActions: filterActivated(m.editorActions, root),
      statusBarItems: filterActivated(m.statusBarItems, root),
      runConfigurations: filterActivated(m.runConfigurations, root),
    }));
  return next;
}

export function createPluginsHandlers(deps: HandlerDeps): PluginsApi {
  const storage = new PluginStorageStore(loadConfig().dbPath);
  return {
    async list() {
      return listInstalledPlugins().map(toInfo);
    },

    async activeContributions({ projectId }) {
      const root = projectId != null ? (deps.db.getProject(projectId)?.root_path ?? null) : null;
      return listInstalledPlugins().map((p) => {
        const info = toInfo(p);
        info.contributions = filterActiveContributionShape(info.contributions, root);
        return info;
      });
    },

    async get({ namespace }) {
      const p = getInstalledPlugin(namespace);
      return p ? toInfo(p) : null;
    },

    async install(input: PluginInstallInput): Promise<PluginInstallResult> {
      try {
        const r = await installPlugin({
          source: toSource(input.source),
          namespace: input.namespace,
          overwrite: input.overwrite,
        });
        // Register any declarative provider the plugin contributes, live.
        deps.syncPluginProviders();
        await syncLanguageServerContributions();
        return {
          namespace: r.namespace,
          name: r.name,
          version: r.version,
          skills: r.skills,
          mcpServers: r.mcpServers,
          warnings: r.warnings,
        };
      } catch (e) {
        throw new ApiError(
          'plugin_install_failed',
          400,
          e instanceof Error ? e.message : String(e),
        );
      }
    },

    async uninstall({ namespace }) {
      const r = await uninstallPlugin(namespace);
      deps.syncPluginProviders();
      await syncLanguageServerContributions();
      return { ok: true as const, skillsRemoved: r.skillsRemoved, mcpRemoved: r.mcpRemoved };
    },

    async setEnabled({ namespace, enabled }) {
      setPluginEnabled(namespace, enabled);
      deps.syncPluginProviders();
      await syncLanguageServerContributions();
      return { ok: true as const };
    },

    async readAsset({ namespace, path }) {
      return { content: await readPluginAsset(namespace, path) };
    },

    async searchMarket({ query }) {
      return marketClient().search(query);
    },

    async marketInfo({ name }) {
      return marketClient().getInfo(name);
    },

    async invokeTool({ namespace, tool, args, projectId }) {
      let projectName: string | null = null;
      let cwd = process.cwd();
      if (projectId != null) {
        const proj = deps.db.getProject(projectId);
        if (!proj) throw new ApiError('not_found', 404, `project ${projectId} not found`);
        projectName = proj.name;
        cwd = proj.root_path;
      }
      return deps.invokePluginTool(namespace, tool, args ?? {}, { projectName, cwd });
    },

    async *execStream({ namespace, cmd, args, projectId }): AsyncGenerator<PluginExecChunk> {
      let cwd = process.cwd();
      if (projectId != null) {
        const proj = deps.db.getProject(projectId);
        if (!proj) throw new ApiError('not_found', 404, `project ${projectId} not found`);
        cwd = proj.root_path;
      }
      const p = getInstalledPlugin(namespace);
      if (!p || !p.enabled) throw new ApiError('not_found', 404, `plugin ${namespace} not enabled`);
      const granted = (p.permissions_granted as PluginPermissionsShape | null) ?? null;
      yield* execStream({ cmd, args, cwd, allow: granted?.exec?.allow });
    },

    async getPermissions({ namespace }) {
      const p = getInstalledPlugin(namespace);
      return {
        declared: declaredPermissions(p),
        granted: (p?.permissions_granted as PluginPermissionsShape | null) ?? null,
      };
    },

    async requestPermission({ namespace, granted }) {
      setPluginPermissionsGranted(namespace, granted as Record<string, unknown>);
      return { ok: true as const };
    },

    async storageGet({ namespace, key }) {
      return { value: storage.get(namespace, key) };
    },

    async storageSet({ namespace, key, value }) {
      storage.set(namespace, key, value);
      return { ok: true as const };
    },

    async storageList({ namespace }) {
      return { keys: storage.listKeys(namespace) };
    },

    async listModels() {
      return listAssistantModels(deps.providerStore);
    },

    async *assistantStream({ namespace, message, providerId, modelId, projectId, history }) {
      let projectName: string | null = null;
      let cwd = process.cwd();
      if (projectId != null) {
        const proj = deps.db.getProject(projectId);
        if (!proj) throw new ApiError('not_found', 404, `project ${projectId} not found`);
        projectName = proj.name;
        cwd = proj.root_path;
      }
      yield* runPluginAssistant({
        namespace,
        message,
        providerId,
        modelId,
        projectName,
        cwd,
        history,
        invokeTool: deps.invokePluginTool,
      });
    },

    async assistantConfirm({ callId, approved }) {
      resolveAssistantConfirm(callId, approved);
      return { ok: true as const };
    },
  };
}
