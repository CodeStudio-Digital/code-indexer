import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export interface ProjectTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

export interface ProjectSearchResult {
  path: string;
  type: 'file' | 'dir';
}

interface IgnoreCacheEntry {
  ig: Ignore;
  loadedAt: number;
  gitignoreMtime: number | null;
  mcpignoreMtime: number | null;
}

const IGNORE_TTL_MS = 30_000;
const ALWAYS_IGNORE = ['.git/', 'node_modules/'];

const cache = new Map<string, IgnoreCacheEntry>();

async function statMtime(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Load (and cache) the merged .gitignore + .mcpignore matcher for a project
 * root. Cache invalidates after TTL OR when either ignore file's mtime changes.
 * Always includes baseline rules (`.git/`, `node_modules/`) even if both
 * files are missing.
 */
export async function loadIgnore(rootAbs: string): Promise<Ignore> {
  const now = Date.now();
  const cached = cache.get(rootAbs);
  const gitignorePath = path.join(rootAbs, '.gitignore');
  const mcpignorePath = path.join(rootAbs, '.mcpignore');
  const [gitMtime, mcpMtime] = await Promise.all([
    statMtime(gitignorePath),
    statMtime(mcpignorePath),
  ]);

  if (
    cached &&
    now - cached.loadedAt < IGNORE_TTL_MS &&
    cached.gitignoreMtime === gitMtime &&
    cached.mcpignoreMtime === mcpMtime
  ) {
    return cached.ig;
  }

  const [gitContent, mcpContent] = await Promise.all([
    readIfExists(gitignorePath),
    readIfExists(mcpignorePath),
  ]);

  const ig = ignore();
  ig.add(ALWAYS_IGNORE);
  if (gitContent) ig.add(gitContent);
  if (mcpContent) ig.add(mcpContent);

  cache.set(rootAbs, {
    ig,
    loadedAt: now,
    gitignoreMtime: gitMtime,
    mcpignoreMtime: mcpMtime,
  });
  return ig;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/**
 * One-level listing of `relDir` under `rootAbs`, filtered by .gitignore +
 * .mcpignore. Hidden dotfiles (other than the ignore files themselves) are
 * also dropped to match common file-tree expectations.
 */
export async function listDirFiltered(
  rootAbs: string,
  relDir: string,
): Promise<ProjectTreeEntry[]> {
  const ig = await loadIgnore(rootAbs);
  const absDir = path.resolve(rootAbs, relDir === '.' ? '' : relDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: ProjectTreeEntry[] = [];
  for (const e of entries) {
    if (!e.isFile() && !e.isDirectory()) continue;
    if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.mcpignore') continue;
    const relPath = toPosix(relDir === '.' ? e.name : path.join(relDir, e.name));
    // `ignore` package needs a trailing slash for directories to match dir rules.
    const probe = e.isDirectory() ? `${relPath}/` : relPath;
    if (ig.ignores(probe)) continue;
    let size: number | null = null;
    if (e.isFile()) {
      try {
        const st = await fs.stat(path.join(absDir, e.name));
        size = st.size;
      } catch {
        size = null;
      }
    }
    out.push({
      name: e.name,
      path: relPath,
      type: e.isDirectory() ? 'dir' : 'file',
      size,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

interface SearchOpts {
  maxResults?: number;
  maxEntries?: number;
  maxDepth?: number;
}

interface RecursiveOpts {
  maxFiles?: number;
  maxEntries?: number;
}

/**
 * Flat list of every file (not directories) under `relDir`, filtered by the
 * same ignore rules as `listDirFiltered`. Capped to keep folder-select on
 * monorepo roots from blowing up the client.
 */
export async function listFilesRecursive(
  rootAbs: string,
  relDir: string,
  opts: RecursiveOpts = {},
): Promise<{ files: string[]; truncated: boolean }> {
  const maxFiles = opts.maxFiles ?? 500;
  const maxEntries = opts.maxEntries ?? 5000;
  const ig = await loadIgnore(rootAbs);
  const files: string[] = [];
  let visited = 0;
  let truncated = false;

  async function walk(dirRel: string): Promise<void> {
    if (files.length >= maxFiles || visited >= maxEntries) {
      truncated = true;
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.resolve(rootAbs, dirRel === '.' ? '' : dirRel), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return;
      }
      if (!e.isFile() && !e.isDirectory()) continue;
      if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.mcpignore') continue;
      const relPath = toPosix(dirRel === '.' ? e.name : path.join(dirRel, e.name));
      const probe = e.isDirectory() ? `${relPath}/` : relPath;
      if (ig.ignores(probe)) continue;
      if (e.isFile()) {
        files.push(relPath);
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      } else {
        await walk(relPath);
        if (files.length >= maxFiles || visited >= maxEntries) return;
      }
    }
  }

  await walk(relDir);
  return { files, truncated };
}

/**
 * Recursive case-insensitive substring search rooted at `rootAbs`. Walks at
 * most `maxEntries` filesystem entries to keep monorepos responsive; returns
 * up to `maxResults` matches. Honors the same ignore rules as `listDirFiltered`.
 */
export async function searchFiles(
  rootAbs: string,
  query: string,
  opts: SearchOpts = {},
): Promise<{ results: ProjectSearchResult[]; truncated: boolean }> {
  const maxResults = opts.maxResults ?? 200;
  const maxEntries = opts.maxEntries ?? 5000;
  const maxDepth = opts.maxDepth ?? 8;
  const needle = query.toLowerCase();
  const ig = await loadIgnore(rootAbs);

  const results: ProjectSearchResult[] = [];
  let visited = 0;
  let truncated = false;

  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (visited >= maxEntries || results.length >= maxResults) {
      truncated = true;
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(path.resolve(rootAbs, relDir === '.' ? '' : relDir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return;
      }
      if (!e.isFile() && !e.isDirectory()) continue;
      if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.mcpignore') continue;
      const relPath = toPosix(relDir === '.' ? e.name : path.join(relDir, e.name));
      const probe = e.isDirectory() ? `${relPath}/` : relPath;
      if (ig.ignores(probe)) continue;
      if (e.name.toLowerCase().includes(needle) || relPath.toLowerCase().includes(needle)) {
        results.push({ path: relPath, type: e.isDirectory() ? 'dir' : 'file' });
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
      }
      if (e.isDirectory()) {
        await walk(relPath, depth + 1);
        if (results.length >= maxResults || visited >= maxEntries) return;
      }
    }
  }

  await walk('.', 0);
  return { results, truncated };
}
