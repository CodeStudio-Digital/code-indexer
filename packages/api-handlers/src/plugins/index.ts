/**
 * Handlers for the `plugins` namespace. Thin delegation to @mcp/plugin-host;
 * Registry reads and per-plugin storage share the host's SQLite connection.
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
  readPluginAsset,
  execStream,
  createAsyncActivationCheck,
  type InstalledPlugin,
} from '@mcp/plugin-host';
import type { PluginSource } from '@mcp/plugin-sdk';
import { MarketClient } from '@mcp/plugin-market-client';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
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

type CheckActivation = ReturnType<typeof createAsyncActivationCheck>;
async function filterActivated<T extends Activatable>(items: T[] | undefined, check: CheckActivation): Promise<T[] | undefined> {
  if (!items) return undefined;
  const active = await Promise.all(items.map(item => check(item.activation)));
  return items.filter((_, i) => active[i]);
}

interface SurfaceItems {
  toolWindows?: Activatable[];
  editorActions?: Activatable[];
  statusBarItems?: Activatable[];
  runConfigurations?: Activatable[];
}

async function activeSurface(items: SurfaceItems, check: CheckActivation): Promise<SurfaceItems> {
  const [toolWindows, editorActions, statusBarItems, runConfigurations] = await Promise.all([
    filterActivated(items.toolWindows, check), filterActivated(items.editorActions, check),
    filterActivated(items.statusBarItems, check), filterActivated(items.runConfigurations, check),
  ]);
  return { toolWindows, editorActions, statusBarItems, runConfigurations };
}

async function filterActiveContributionShape(contributions: Record<string, unknown> | null, check: CheckActivation) {
  if (!contributions) return null;
  const items = contributions as SurfaceItems & { tools?: Activatable[]; modules?: Array<Activatable & SurfaceItems> };
  const [tools, surface, modules] = await Promise.all([
    filterActivated(items.tools, check), activeSurface(items, check), filterActivated(items.modules, check),
  ]);
  const activeModules = modules && await Promise.all(modules.map(async m => ({ ...m, ...await activeSurface(m, check) })));
  return { ...contributions, ...surface, tools, modules: activeModules };
}

export function createPluginsHandlers(deps: HandlerDeps): PluginsApi {
  const installed = new InstalledPluginStore(deps.db.raw());
  const storage = new PluginStorageStore(deps.db.raw());
  return {
    async list() {
      return installed.list().map(toInfo);
    },

    async activeContributions({ projectId }) {
      const root = projectId != null ? (await deps.db.getProjectRootPath(projectId) ?? null) : null;
      const check = createAsyncActivationCheck(root);
      return Promise.all(installed.list().map(async p => {
        const info = toInfo(p);
        info.contributions = await filterActiveContributionShape(info.contributions, check);
        return info;
      }));
    },

    async get({ namespace }) {
      const p = installed.get(namespace);
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
      await syncLanguageServerContributions();
      return { ok: true as const, skillsRemoved: r.skillsRemoved, mcpRemoved: r.mcpRemoved };
    },

    async setEnabled({ namespace, enabled }) {
      installed.setEnabled(namespace, enabled);
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
      const p = installed.get(namespace);
      if (!p || !p.enabled) throw new ApiError('not_found', 404, `plugin ${namespace} not enabled`);
      const granted = (p.permissions_granted as PluginPermissionsShape | null) ?? null;
      yield* execStream({ cmd, args, cwd, allow: granted?.exec?.allow });
    },

    async getPermissions({ namespace }) {
      const p = installed.get(namespace);
      return {
        declared: declaredPermissions(p),
        granted: (p?.permissions_granted as PluginPermissionsShape | null) ?? null,
      };
    },

    async requestPermission({ namespace, granted }) {
      installed.setPermissionsGranted(namespace, granted as Record<string, unknown>);
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
