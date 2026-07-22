/**
 * Lean authoring entry — plugins import from `@mcp/plugin-sdk/define.js` so
 * their bundle never pulls in the zod-based manifest schemas. Re-exported by
 * the package barrel for host/CLI convenience.
 */
export * from './contributions/types.js';
export type {
  PluginFs,
  PluginExec,
  PluginExecResult,
  PluginStorage,
  PluginPermissions,
} from './contributions/capabilities.js';
export { contributeTool } from './contributions/tool.js';
export { contributeToolWindow } from './contributions/tool-window.js';
export { contributeCommand } from './contributions/command.js';
export { contributeTheme } from './contributions/theme.js';
export { contributeProvider } from './contributions/provider.js';
export { contributeEditorAction } from './contributions/editor-action.js';
export { contributeStatusBarItem } from './contributions/status-bar.js';
export { contributeRunConfiguration } from './contributions/run-configuration.js';
export { contributeDebugger } from './contributions/debugger.js';
export { contributeLanguageServer } from './contributions/language-server.js';
export { contributeProjectModule } from './contributions/project-module.js';
export { definePlugin } from './define-plugin.js';
export type { DefinePluginSpec } from './define-plugin.js';
export { defineDebugAdapter, isDebugResolvedConfiguration } from './debug-adapter.js';
export type {
  DebugAdapterRuntime,
  DebugAdapterExecutable,
  DebugAdapterResolveContext,
  DebugConfigurationInput,
  DebugResolvedConfiguration,
  DebugRunnerInput,
  DebugTargetLaunch,
} from './debug-adapter.js';
