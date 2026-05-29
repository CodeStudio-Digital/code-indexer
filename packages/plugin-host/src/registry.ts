import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import type { InstalledPlugin } from '@mcp/store/installed-plugin-store.js';

function withStore<T>(fn: (s: InstalledPluginStore) => T): T {
  const { dbPath } = loadConfig();
  const store = new InstalledPluginStore(dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export function listInstalledPlugins(): InstalledPlugin[] {
  return withStore((s) => s.list());
}

export function getInstalledPlugin(namespace: string): InstalledPlugin | null {
  return withStore((s) => s.get(namespace));
}

export function setPluginEnabled(namespace: string, enabled: boolean): void {
  withStore((s) => s.setEnabled(namespace, enabled));
}

export type { InstalledPlugin };
