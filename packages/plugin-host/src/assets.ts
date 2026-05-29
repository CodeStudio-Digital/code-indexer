import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pluginDir } from './paths.js';

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
  return readFile(target, 'utf8');
}
