import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pluginDir } from './paths.js';

/**
 * mtime-validated LRU for plugin assets. An installed plugin's files are
 * immutable for a given version, so once read we keep the content and only
 * re-read when `stat` shows a different mtime/size (a plugin update). Warm
 * reads cost one `stat` instead of streaming an 80KB+ inlined-UI bundle off
 * disk (which on Windows can hit antivirus scanning on every open).
 */
interface CachedAsset {
  mtimeMs: number;
  size: number;
  content: string;
}

const ASSET_CACHE_MAX = 32;
const assetCache = new Map<string, CachedAsset>();

/**
 * Read a text asset (e.g. a tool-window HTML entry) from an installed
 * plugin's directory. Confined to that dir — a resolved path that escapes
 * the plugin root (via `..` or absolute) is rejected, so a malicious manifest
 * can't read arbitrary files.
 */
export async function readPluginAsset(namespace: string, relPath: string): Promise<string> {
  const base = resolve(pluginDir(namespace));
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`asset path escapes plugin "${namespace}": ${relPath}`);
  }

  const st = await stat(target);
  const cached = assetCache.get(target);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    // LRU touch: re-insert so it becomes the most-recently-used entry.
    assetCache.delete(target);
    assetCache.set(target, cached);
    return cached.content;
  }

  const content = await readFile(target, 'utf8');
  assetCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, content });
  if (assetCache.size > ASSET_CACHE_MAX) {
    const oldest = assetCache.keys().next().value;
    if (oldest !== undefined) assetCache.delete(oldest);
  }
  return content;
}
