import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { getProjectIgnoreRulesAsync, projectIgnorePatterns } from '@mcp/shared/utils/project-ignore.js';

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
const ALWAYS_IGNORE = ['.git/', '.mcp-indexer/', 'node_modules/'];

const cache = new Map<string, IgnoreCacheEntry>();

interface ClassifiedEntry {
  type: 'file' | 'dir';
  size: number | null;
}

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
  ig.add(projectIgnorePatterns(await getProjectIgnoreRulesAsync(rootAbs)));
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

function realPathKey(absPath: string): string {
  const resolved = path.resolve(absPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function resolvedDirKey(absDir: string): Promise<string> {
  try {
    return realPathKey(await fs.realpath(absDir));
  } catch {
    return realPathKey(absDir);
  }
}

async function classifyEntry(absDir: string, entry: Dirent): Promise<ClassifiedEntry | null> {
  const absPath = path.join(absDir, entry.name);
  if (entry.isDirectory()) {
    return { type: 'dir', size: null };
  }
  if (entry.isFile()) {
    try {
      const st = await fs.stat(absPath);
      return { type: 'file', size: st.size };
    } catch {
      return { type: 'file', size: null };
    }
  }
  if (!entry.isSymbolicLink()) {
    return null;
  }
  try {
    const st = await fs.stat(absPath);
    if (st.isDirectory()) return { type: 'dir', size: null };
    if (st.isFile()) return { type: 'file', size: st.size };
  } catch {
    /* dangling link */
  }
  return null;
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
    if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.mcpignore') continue;
    const classified = await classifyEntry(absDir, e);
    if (!classified) continue;
    const relPath = toPosix(relDir === '.' ? e.name : path.join(relDir, e.name));
    // `ignore` package needs a trailing slash for directories to match dir rules.
    const probe = classified.type === 'dir' ? `${relPath}/` : relPath;
    if (ig.ignores(probe)) continue;
    out.push({
      name: e.name,
      path: relPath,
      type: classified.type,
      size: classified.size,
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
  const visitedDirs = new Set<string>();

  async function walk(dirRel: string): Promise<void> {
    if (files.length >= maxFiles || visited >= maxEntries) {
      truncated = true;
      return;
    }
    const absDir = path.resolve(rootAbs, dirRel === '.' ? '' : dirRel);
    const dirKey = await resolvedDirKey(absDir);
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.mcpignore') continue;
      const classified = await classifyEntry(absDir, e);
      if (!classified) continue;
      const relPath = toPosix(dirRel === '.' ? e.name : path.join(dirRel, e.name));
      const probe = classified.type === 'dir' ? `${relPath}/` : relPath;
      if (ig.ignores(probe)) continue;
      if (classified.type === 'file') {
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
  const visitedDirs = new Set<string>();

  async function walk(relDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (visited >= maxEntries || results.length >= maxResults) {
      truncated = true;
      return;
    }
    const absDir = path.resolve(rootAbs, relDir === '.' ? '' : relDir);
    const dirKey = await resolvedDirKey(absDir);
    if (visitedDirs.has(dirKey)) return;
    visitedDirs.add(dirKey);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.') && e.name !== '.gitignore' && e.name !== '.mcpignore') continue;
      const classified = await classifyEntry(absDir, e);
      if (!classified) continue;
      const relPath = toPosix(relDir === '.' ? e.name : path.join(relDir, e.name));
      const probe = classified.type === 'dir' ? `${relPath}/` : relPath;
      if (ig.ignores(probe)) continue;
      if (e.name.toLowerCase().includes(needle) || relPath.toLowerCase().includes(needle)) {
        results.push({ path: relPath, type: classified.type });
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
      }
      if (classified.type === 'dir') {
        await walk(relPath, depth + 1);
        if (results.length >= maxResults || visited >= maxEntries) return;
      }
    }
  }

  await walk('.', 0);
  return { results, truncated };
}
