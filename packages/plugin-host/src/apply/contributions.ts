import type { AppManifest } from '@mcp/plugin-sdk';

export interface PluginContributions {
  tools: NonNullable<AppManifest['tools']>;
  toolWindows: NonNullable<AppManifest['toolWindows']>;
  commands: NonNullable<AppManifest['commands']>;
  themes: NonNullable<AppManifest['themes']>;
  worker: string | null;
  permissions: NonNullable<AppManifest['permissions']> | null;
  /**
   * Declarative LLM-provider contributions (metadata + `supports*` flags, no
   * adapter functions). Lets the provider-host loader discover which enabled
   * plugins contribute providers — and surface them in the admin picker —
   * without importing the bundle. The functions are wired in-process by the
   * loader (trust-gated) from the bundle's `worker` entry.
   */
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
    worker: app.worker ?? null,
    permissions: app.permissions ?? null,
    providers: app.providers ?? [],
  };
}
