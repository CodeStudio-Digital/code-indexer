import { isAbsolute, join } from 'node:path';
import { readdirSync, lstatSync, statSync } from 'node:fs';
import type { McpTool } from '../tool.js';
import { listDirectory } from './list-directory.js';
import { readFile } from './read-file.js';
import { fileSkeleton } from './file-skeleton.js';
import { indexNavigationTools } from './index-navigation.js';
/**
 * Bounded recursive directory listing for the disk fallback. Skips the same
 * standard ignore dirs the project scanner uses so we don't dump
 * `node_modules` into the result. Lines mirror the indexed format
 * (`<rel-path> (<size>B)`) so the LLM doesn't need to special-case the
 * fallback output.
 */
export function listDirectoryFromDisk(
  rootPath: string,
  prefix: string,
  depth: number,
  topLevelLinks?: ReadonlySet<string>,
  onTruncated?: () => void,
  maxEntries = 500,
): string[] {
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.mcp-indexer', '.cache', '.turbo', 'coverage']);
  const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const prefixParts = normalizedPrefix.split('/').filter((part) => part && part !== '.');
  if (isAbsolute(prefix) || prefixParts.includes('..')) return [];
  if (topLevelLinks && prefixParts.length > 0) {
    if (!topLevelLinks.has(prefixParts[0])) return [];
    // The first segment is the DB-authorized workspace junction. Reject a
    // replaced first link and every nested link in a direct-prefix request so
    // callers cannot skip the guarded root walk.
    let cursor = join(rootPath, prefixParts[0]);
    try {
      if (!lstatSync(cursor).isSymbolicLink()) return [];
      for (const part of prefixParts.slice(1)) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) return [];
      }
    } catch { return []; }
  }
  const startAbs = prefixParts.length > 0 ? join(rootPath, ...prefixParts) : rootPath;
  const cap = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : 500;
  let stat: { isDirectory(): boolean };
  try { stat = statSync(startAbs); } catch { return []; }
  if (!stat.isDirectory()) {
    // The prefix points at a file: report just that one.
    try {
      const fileStat = statSync(startAbs);
      const norm = prefix.replace(/\\/g, '/');
      return [`${norm} (${fileStat.size}B)`];
    } catch { return []; }
  }
  const out: string[] = [];
  const walk = (absDir: string, relDir: string, level: number): void => {
    if (level > depth) return;
    let entries: {
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }[] = [];
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const childAbs = join(absDir, entry.name);
      const atSyntheticRoot = level === 0 && !relDir && !!topLevelLinks;
      const isAuthorizedTopLevelLink =
        atSyntheticRoot && topLevelLinks.has(entry.name) && entry.isSymbolicLink();
      if (atSyntheticRoot && !isAuthorizedTopLevelLink) continue;
      const eligible = entry.isDirectory() || isAuthorizedTopLevelLink || entry.isFile();
      if (!eligible) continue;
      if (out.length >= cap) {
        onTruncated?.();
        return;
      }
      if (entry.isDirectory() || isAuthorizedTopLevelLink) {
        out.push(`${childRel}/`);
        walk(childAbs, childRel, level + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = statSync(childAbs).size; } catch { /* ignore */ }
        out.push(`${childRel} (${size}B)`);
      }
    }
  };
  walk(startAbs, normalizedPrefix, 0);
  return out;
}

export const fileTools: McpTool[] = [
  fileSkeleton,
  readFile,
  listDirectory,
  ...indexNavigationTools,
];
