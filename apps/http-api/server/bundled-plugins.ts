/**
 * Seed the FIRST-PARTY provider plugins that ship inside the app into the
 * installed-plugins store on first boot, so they register through the normal
 * plugin path (syncPluginProviders) with NO new runtime code path — zero UX
 * regression vs. shipping them as built-ins.
 *
 * Idempotent + boot-safe:
 *   - installs a bundled plugin only when absent, when the shipped version
 *     changed, or when an older install used a different source (migrates the
 *     legacy `local` demo install to `bundled`);
 *   - NEVER re-enables a plugin the user disabled (a disabled row is left alone);
 *   - swallows per-plugin failures (the built-ins remain as the safety net).
 *
 * Must run BEFORE syncPluginProviders so the seeded specs are visible when the
 * registry reconciles. The staged tree is produced by
 * scripts/build-bundled-plugins.mjs and shipped via electron-builder
 * extraResources (desktop) / the deploy bundle (cloud).
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin } from '@mcp/plugin-host';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';

/** Locate the staged bundled-plugins tree across desktop / cloud / dev layouts. */
function bundledPluginsRoot(): string | null {
  const env = process.env.MCP_BUNDLED_PLUGINS_DIR;
  if (env && existsSync(env)) return env;

  // Packaged Electron: shipped via extraResources to resourcesPath/bundled-plugins.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const p = join(resourcesPath, 'bundled-plugins');
    if (existsSync(p)) return p;
  }

  // Dev / cloud: <repo>/dist/bundled-plugins. This file is emitted at
  // dist/apps/http-api/server/bundled-plugins.js (prod) or run from
  // apps/http-api/server/bundled-plugins.ts (dev) — walk up to the dir that
  // holds dist/bundled-plugins.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ['../../../..', '../../..', '../../../../..']) {
    const p = resolve(here, up, 'dist', 'bundled-plugins');
    if (existsSync(p)) return p;
  }
  return null;
}

export async function seedBundledPlugins(): Promise<void> {
  const root = bundledPluginsRoot();
  if (!root) {
    console.warn('[bundled-plugins] no staged bundled-plugins dir found — skipping seed (built-ins remain)');
    return;
  }

  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }

  const { dbPath } = loadConfig();
  const store = new InstalledPluginStore(dbPath);
  let changed = 0;
  try {
    for (const ns of names) {
      const dir = join(root, ns);
      if (!existsSync(join(dir, 'plugin.json'))) continue;

      let version = '0.0.0';
      try {
        version = (JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
      } catch {
        /* keep default */
      }

      const existing = store.get(ns);
      // Respect a user-disabled plugin: never touch it (no re-enable, no refresh).
      if (existing && !existing.enabled) continue;
      const needsInstall = !existing || existing.source !== 'bundled' || existing.version !== version;
      if (!needsInstall) continue;

      try {
        await installPlugin({ source: { source: 'bundled', path: dir }, overwrite: true });
        changed++;
      } catch (e) {
        console.warn(`[bundled-plugins] seed ${ns} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    store.close();
  }
  if (changed) console.log(`[bundled-plugins] seeded/refreshed ${changed} bundled provider plugin(s)`);
}
