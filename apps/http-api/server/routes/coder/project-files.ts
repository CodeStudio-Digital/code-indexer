import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import {
  getProjectIgnoreRulesAsync,
  shouldIgnoreProjectPath,
} from '@mcp/shared/utils/project-ignore.js';

interface ProjectTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

interface ProjectSearchResult {
  path: string;
  type: 'file' | 'dir';
}

interface ClassifiedEntry {
  type: 'file' | 'dir';
  size: number | null;
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
 * One-level listing of `relDir` under `rootAbs`, using the same project-tree
 * ignore policy as the editor Navigation. Git-ignored files remain visible;
 * generated/dependency trees such as `.git`, `node_modules`, and Unity Library
 * remain excluded.
 */
export async function listDirFiltered(
  rootAbs: string,
  relDir: string,
): Promise<ProjectTreeEntry[]> {
  const projectIgnore = await getProjectIgnoreRulesAsync(rootAbs);
  const absDir = path.resolve(rootAbs, relDir === '.' ? '' : relDir);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: ProjectTreeEntry[] = [];
  for (const e of entries) {
    const classified = await classifyEntry(absDir, e);
    if (!classified) continue;
    const relPath = toPosix(relDir === '.' ? e.name : path.join(relDir, e.name));
    if (shouldIgnoreProjectPath(projectIgnore, relPath, classified.type === 'dir')) continue;
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
  const projectIgnore = await getProjectIgnoreRulesAsync(rootAbs);
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
      const classified = await classifyEntry(absDir, e);
      if (!classified) continue;
      const relPath = toPosix(dirRel === '.' ? e.name : path.join(dirRel, e.name));
      if (shouldIgnoreProjectPath(projectIgnore, relPath, classified.type === 'dir')) continue;
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
  const projectIgnore = await getProjectIgnoreRulesAsync(rootAbs);

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
      const classified = await classifyEntry(absDir, e);
      if (!classified) continue;
      const relPath = toPosix(relDir === '.' ? e.name : path.join(relDir, e.name));
      if (shouldIgnoreProjectPath(projectIgnore, relPath, classified.type === 'dir')) continue;
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
