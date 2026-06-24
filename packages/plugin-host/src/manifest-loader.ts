import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePluginManifest, parseAppManifest } from '@mcp/plugin-sdk';
import type { PluginManifest, AppManifest } from '@mcp/plugin-sdk';

export interface LoadedManifest {
  manifest: PluginManifest;
  app: AppManifest | null;
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Read + validate plugin.json (required) and .app.json (optional) from a dir.
 * `trustProviders` validates contributed providers against the FULL provider
 * schema (host capabilities allowed) — used only for first-party bundled
 * installs; the provider loader remains the authoritative runtime gate.
 */
export async function loadManifest(
  dir: string,
  opts?: { trustProviders?: boolean },
): Promise<LoadedManifest> {
  const raw = await readJson(join(dir, 'plugin.json'));
  if (raw === null) throw new Error(`No plugin.json found in ${dir}`);
  const manifest = parsePluginManifest(raw);

  const appPath = manifest.apps ? join(dir, manifest.apps) : join(dir, '.app.json');
  const appRaw = await readJson(appPath);
  const app = appRaw !== null ? parseAppManifest(appRaw, opts) : null;

  return { manifest, app };
}

/** Lightweight read of just the plugin.json `name` (namespace resolution). */
export async function peekManifestName(dir: string): Promise<string> {
  const raw = await readJson(join(dir, 'plugin.json'));
  if (raw === null) throw new Error(`No plugin.json found in ${dir}`);
  return parsePluginManifest(raw).name;
}
