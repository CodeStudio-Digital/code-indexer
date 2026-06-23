/**
 * @mcp/plugin-host — installs/uninstalls plugins (Claude Code-compatible
 * bundles) by namespace, generalizing the agent-skills installer. Applies a
 * plugin's skills, MCP servers, and UI/agent contributions, and records the
 * install in the `installed_plugins` store.
 */
export { installPlugin } from './installer.js';
export type { InstallPluginOptions } from './installer.js';
export { uninstallPlugin } from './uninstall.js';
export type { UninstallResult } from './uninstall.js';
export { loadManifest, peekManifestName } from './manifest-loader.js';
export type { LoadedManifest } from './manifest-loader.js';
export { verifyBundle, bundleSha256 } from './signature.js';
export { buildContributions } from './apply/contributions.js';
export type { PluginContributions } from './apply/contributions.js';
export {
  listInstalledPlugins,
  getInstalledPlugin,
  setPluginEnabled,
  setPluginPermissionsGranted,
} from './registry.js';
export type { InstalledPlugin } from './registry.js';
export { buildPluginTools } from './plugin-tool-bridge.js';
export type { EnabledPlugin, PluginToolInvoker, PluginInvokeContext } from './plugin-tool-bridge.js';
export { listEnabledPluginRuntime } from './enabled.js';
export type { EnabledPluginRuntime, PluginBundleRef } from './enabled.js';
export { listProviderPlugins, loadPluginProviders } from './provider-loader.js';
export type {
  ProviderPluginRef,
  LoadPluginProvidersOptions,
  LoadPluginProvidersResult,
} from './provider-loader.js';
export { readPluginAsset } from './assets.js';
export { isActivated } from './activation.js';
export type { ActivationRule } from './activation.js';
export { buildHostInvoke } from './host-invoke.js';
export type { HostInvoke, HostInvokeDeps } from './host-invoke.js';
export { handleFs, handleExec, execStream, handleStorage, isExecAllowed, scopePath } from './capabilities/index.js';
export type { ExecResult, ExecChunk } from './capabilities/index.js';
export * from './types.js';
