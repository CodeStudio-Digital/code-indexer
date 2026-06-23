/**
 * Shared, lazily-built reverse-RPC host surface for plugin tool calls. Built
 * once (stores opened once) and reused across coder runs and the UI-driven
 * plugin host. `resolveGrants` reads the user-approved capability subset per
 * namespace (installed_plugins.permissions_granted); `storage` backs
 * `ctx.storage`. This is what makes `ctx.fs`/`ctx.exec`/`ctx.storage` actually
 * work (and be enforced) — without it, `host.invoke` returns null.
 */
import { buildHostInvoke, type HostInvoke } from '@mcp/plugin-host';
import type { PluginPermissions } from '@mcp/plugin-sdk';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';

let cached: HostInvoke | null = null;

export function getPluginHostInvoke(): HostInvoke {
  if (cached) return cached;
  const { dbPath } = loadConfig();
  const installed = new InstalledPluginStore(dbPath);
  const storage = new PluginStorageStore(dbPath);
  cached = buildHostInvoke({
    resolveGrants: (ns) => {
      const p = installed.get(ns);
      return (p?.permissions_granted as PluginPermissions | null) ?? null;
    },
    storage,
  });
  return cached;
}
