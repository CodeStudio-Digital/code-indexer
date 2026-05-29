import type {
  ContributedTool,
  ContributedToolWindow,
  ContributedCommand,
  ContributedTheme,
  PluginModule,
} from './contributions/types.js';

export interface DefinePluginSpec {
  tools?: ContributedTool[];
  toolWindows?: ContributedToolWindow[];
  commands?: ContributedCommand[];
  themes?: ContributedTheme[];
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
  };
}
