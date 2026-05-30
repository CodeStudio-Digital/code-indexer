/**
 * Process-wide plugin worker host for UI-driven tool invocations (outside a
 * coder run — e.g. a plugin's own webview clicking "Deploy"). Lazily spawns one
 * worker and reloads it when the enabled-plugin set changes
 * (install/uninstall/enable). Capabilities are enforced via the shared
 * getPluginHostInvoke() choke point. Consumed by the `plugins.invokeTool`
 * handler through DI (wired in server/deps.ts).
 */
import { PluginWorkerHost } from './PluginWorkerHost.js';
import { listEnabledPluginRuntime } from '@mcp/plugin-host';
import { getPluginHostInvoke } from './pluginHostInvoke.js';

export type PluginToolInvokeFn = (
  namespace: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: { projectName: string | null; cwd: string },
) => Promise<{ content: string; isError?: boolean }>;

let host: PluginWorkerHost | null = null;
let loadedKey = '';

function bundleKey(bundles: { namespace: string; file: string }[]): string {
  return bundles
    .map((b) => `${b.namespace}@${b.file}`)
    .sort()
    .join('|');
}

/** Get (or rebuild) the shared worker host, fresh against the enabled set. */
function ensureHost(): PluginWorkerHost {
  const { bundles } = listEnabledPluginRuntime();
  const key = bundleKey(bundles);
  if (host && key !== loadedKey) {
    void host.dispose();
    host = null;
  }
  if (!host) {
    host = new PluginWorkerHost({ bundles, hostInvoke: getPluginHostInvoke() });
    loadedKey = key;
  }
  return host;
}

export const invokePluginTool: PluginToolInvokeFn = (namespace, tool, args, ctx) =>
  ensureHost().invokeTool(namespace, tool, args, ctx);
