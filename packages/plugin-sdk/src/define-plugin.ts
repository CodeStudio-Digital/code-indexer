import type {
  ContributedTool,
  ContributedToolWindow,
  ContributedCommand,
  ContributedTheme,
  ContributedEditorAction,
  ContributedStatusBarItem,
  ContributedRunConfiguration,
  ContributedDebugger,
  ContributedProjectModule,
  PluginModule,
} from './contributions/types.js';
import type { PluginPermissions } from './contributions/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

export interface DefinePluginSpec {
  tools?: ContributedTool[];
  toolWindows?: ContributedToolWindow[];
  commands?: ContributedCommand[];
  themes?: ContributedTheme[];
  editorActions?: ContributedEditorAction[];
  statusBarItems?: ContributedStatusBarItem[];
  runConfigurations?: ContributedRunConfiguration[];
  debuggers?: ContributedDebugger[];
  modules?: ContributedProjectModule[];
  permissions?: PluginPermissions;
  /** LLM provider metadata this plugin contributes. */
  providers?: ProviderSpec[];
}

/**
 * Collect a plugin's contributions into the `PluginModule` the worker entry
 * default-exports. The CLI `build` step also reads this to extract the
 * declarative `.app.json` (everything except tool handlers).
 */
export function definePlugin(spec: DefinePluginSpec): PluginModule {
  return {
    tools: spec.tools ?? [],
    toolWindows: spec.toolWindows ?? [],
    commands: spec.commands ?? [],
    themes: spec.themes ?? [],
    editorActions: spec.editorActions ?? [],
    statusBarItems: spec.statusBarItems ?? [],
    runConfigurations: spec.runConfigurations ?? [],
    debuggers: spec.debuggers ?? [],
    modules: spec.modules ?? [],
    ...(spec.permissions ? { permissions: spec.permissions } : {}),
    ...(spec.providers && spec.providers.length ? { providers: spec.providers } : {}),
  };
}
