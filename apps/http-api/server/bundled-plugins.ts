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
 *   - NEVER re-enables a plugin the user disabled. Ordinary version refreshes
 *     still leave it alone; a required runtime-format migration may refresh
 *     its files, but restores the disabled flag and prior permissions;
 *   - swallows per-plugin failures (the built-ins remain as the safety net).
 *
 * Must run BEFORE syncPluginProviders so the seeded specs are visible when the
 * registry reconciles. The staged tree is produced by
 * scripts/build-bundled-plugins.mjs and shipped via electron-builder
 * extraResources (desktop) / the deploy bundle (cloud).
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin } from '@mcp/plugin-host';
import { pluginDir } from '@mcp/plugin-host/paths.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';

type RuntimeContributions = {
  worker?: unknown;
  providerRuntime?: { entry?: unknown } | null;
};

function runtimeEntries(contributions: Record<string, unknown> | null): string[] {
  if (!contributions) return [];
  const runtime = contributions as RuntimeContributions;
  const worker = typeof runtime.worker === 'string' ? runtime.worker : null;
  const providerEntry =
    runtime.providerRuntime && typeof runtime.providerRuntime.entry === 'string'
      ? runtime.providerRuntime.entry
      : runtime.providerRuntime
        ? (worker ?? './dist/plugin.js')
        : null;
  return [...new Set([worker, providerEntry].filter((entry): entry is string => !!entry))];
}

/** Lowest runtime format across a plugin's executable JS entries. */
async function bundledRuntimeFormat(
  rootDir: string,
  contributions: Record<string, unknown> | null,
): Promise<number> {
  const root = resolve(rootDir);
  const entries = runtimeEntries(contributions);
  if (entries.length === 0) return 0;
  let format = Number.POSITIVE_INFINITY;

  for (const entry of entries) {
    const entryPath = resolve(root, entry);
    const relativeEntry = relative(root, entryPath);
    if (
      relativeEntry === '..' ||
      relativeEntry.startsWith(`..${sep}`) ||
      isAbsolute(relativeEntry) ||
      extname(entryPath).toLowerCase() !== '.js' ||
      !existsSync(entryPath)
    ) {
      return 0;
    }

    const marker = join(dirname(entryPath), 'package.json');
    try {
      const parsed = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>;
      if (parsed.type !== 'module') return 0;
      const value = parsed.mcpPluginRuntimeFormat;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 0;
      format = Math.min(format, value);
    } catch {
      return 0;
    }
  }

  return Number.isFinite(format) ? format : 0;
}

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
      let stagedContributions: Record<string, unknown> | null = null;
      try {
        version = (JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
        const app = JSON.parse(await readFile(join(dir, '.app.json'), 'utf8')) as unknown;
        stagedContributions =
          app && typeof app === 'object' && !Array.isArray(app)
            ? (app as Record<string, unknown>)
            : null;
      } catch {
        /* keep default */
      }

      const existing = store.get(ns);
      const stagedFormat = await bundledRuntimeFormat(dir, stagedContributions);
      const installedFormat =
        existing?.source === 'bundled'
          ? await bundledRuntimeFormat(pluginDir(ns), existing.contributions)
          : 0;
      // A runtime-format bump is a binary compatibility migration independent
      // of the plugin's product version (for example: ESM createRequire shim).
      // Restrict this special same-version refresh to an existing bundled row;
      // local/market plugins must never be overwritten by the bundled seed.
      const runtimeUpgrade =
        existing?.source === 'bundled' &&
        existing.version === version &&
        stagedFormat > installedFormat;
      // Preserve the established rule for ordinary updates: a user-disabled
      // plugin is left untouched. Runtime compatibility is the sole exception,
      // and its disabled state is restored immediately after installation.
      if (existing && !existing.enabled && !runtimeUpgrade) continue;
      const needsInstall =
        !existing ||
        existing.source !== 'bundled' ||
        existing.version !== version ||
        runtimeUpgrade;
      if (!needsInstall) continue;

      try {
        await installPlugin({ source: { source: 'bundled', path: dir }, overwrite: true });
        // installPlugin treats a fresh install as enabled. A binary refresh of
        // an existing bundled plugin must preserve the user's enablement and
        // permission decisions, including a disabled plugin staying disabled.
        if (existing) {
          store.setEnabled(ns, existing.enabled);
          store.setPermissionsGranted(ns, existing.permissions_granted);
        }
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
