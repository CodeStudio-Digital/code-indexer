/**
 * Resolve the runtime view of currently-enabled plugins: the tool
 * declarations (for buildPluginTools) and the worker bundle paths (for the
 * plugin worker). Read fresh per agent run so install/uninstall/enable take
 * effect on the next turn without a restart.
 */
import { join } from 'node:path';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import type { PluginToolDecl } from '@mcp/plugin-sdk';
import { pluginDir } from './paths.js';
import type { EnabledPlugin } from './plugin-tool-bridge.js';
import { isActivated } from './activation.js';

export interface PluginBundleRef {
  namespace: string;
  file: string;
}

export interface EnabledPluginRuntime {
  /** Tool declarations grouped by namespace — feed to buildPluginTools. */
  toolPlugins: EnabledPlugin[];
  /** Built worker bundles to load in the plugin worker. */
  bundles: PluginBundleRef[];
}

export function listEnabledPluginRuntime(opts?: { projectRoot?: string | null }): EnabledPluginRuntime {
  const { dbPath } = loadConfig();
  const store = new InstalledPluginStore(dbPath);
  const toolPlugins: EnabledPlugin[] = [];
  const bundles: PluginBundleRef[] = [];
  try {
    for (const p of store.list({ enabled: true })) {
      const contrib = (p.contributions ?? {}) as {
        tools?: PluginToolDecl[];
        worker?: string | null;
      };
      const tools = Array.isArray(contrib.tools)
        ? contrib.tools.filter((t) => isActivated(t.activation, opts?.projectRoot ?? null))
        : [];
      if (tools.length > 0) toolPlugins.push({ namespace: p.namespace, tools });
      if (contrib.worker) {
        bundles.push({ namespace: p.namespace, file: join(pluginDir(p.namespace), contrib.worker) });
      }
    }
  } finally {
    store.close();
  }
  return { toolPlugins, bundles };
}
