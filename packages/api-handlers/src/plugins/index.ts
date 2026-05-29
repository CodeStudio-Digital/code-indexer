/**
 * Handlers for the `plugins` namespace. Thin delegation to @mcp/plugin-host;
 * the host functions resolve the DB path via loadConfig() internally, so the
 * handler does not touch `deps`.
 */
import {
  ApiError,
  type PluginsApi,
  type PluginInstallInput,
  type PluginInstallSource,
  type InstalledPluginInfo,
  type PluginInstallResult,
} from '@mcp/api-bus';
import {
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  getInstalledPlugin,
  setPluginEnabled,
  readPluginAsset,
  type InstalledPlugin,
} from '@mcp/plugin-host';
import type { PluginSource } from '@mcp/plugin-sdk';
import { MarketClient } from '@mcp/plugin-market-client';
import type { HandlerDeps } from '../types.js';

function marketClient(): MarketClient {
  const url = process.env.MCP_MARKET_URL;
  if (!url) {
    throw new ApiError('market_not_configured', 503, 'hosted market not configured (set MCP_MARKET_URL)');
  }
  return new MarketClient(url);
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

export function createPluginsHandlers(_deps: HandlerDeps): PluginsApi {
  return {
    async list() {
      return listInstalledPlugins().map(toInfo);
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
      return { ok: true as const, skillsRemoved: r.skillsRemoved, mcpRemoved: r.mcpRemoved };
    },

    async setEnabled({ namespace, enabled }) {
      setPluginEnabled(namespace, enabled);
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
  };
}
