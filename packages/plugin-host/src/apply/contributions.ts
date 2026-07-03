import type { AppManifest } from '@mcp/plugin-sdk';

export interface PluginContributions {
  tools: NonNullable<AppManifest['tools']>;
  toolWindows: NonNullable<AppManifest['toolWindows']>;
  commands: NonNullable<AppManifest['commands']>;
  themes: NonNullable<AppManifest['themes']>;
  editorActions: NonNullable<AppManifest['editorActions']>;
  statusBarItems: NonNullable<AppManifest['statusBarItems']>;
  runConfigurations: NonNullable<AppManifest['runConfigurations']>;
  modules: NonNullable<AppManifest['modules']>;
  providerRuntime: NonNullable<AppManifest['providerRuntime']> | null;
  worker: string | null;
  permissions: NonNullable<AppManifest['permissions']> | null;
  /** LLM-provider metadata. V2 executable ownership is described by providerRuntime. */
  providers: NonNullable<AppManifest['providers']>;
}

/**
 * Normalize an .app.json into the contributions snapshot persisted on the
 * installed_plugins row. The IDE rehydrates UI + agent-tool contributions
 * from this without re-reading disk or executing plugin code.
 */
export function buildContributions(app: AppManifest | null): PluginContributions | null {
  if (!app) return null;
  return {
    tools: app.tools ?? [],
    toolWindows: app.toolWindows ?? [],
    commands: app.commands ?? [],
    themes: app.themes ?? [],
    editorActions: app.editorActions ?? [],
    statusBarItems: app.statusBarItems ?? [],
    runConfigurations: app.runConfigurations ?? [],
    modules: app.modules ?? [],
    providerRuntime: app.providerRuntime ?? null,
    worker: app.worker ?? null,
    permissions: app.permissions ?? null,
    providers: app.providers ?? [],
  };
}
