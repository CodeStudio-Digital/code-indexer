import { PROFILES, COMPILED_PROFILES } from './project-ignore-profiles.js';
import type { ProjectIgnoreKind } from './project-ignore-profiles.js';
export type { ProjectIgnoreKind } from './project-ignore-profiles.js';
/**
 * Project-aware ignore profiles shared by the live Explorer, watcher and
 * structural indexer. The important distinction from `fs-ignore.ts` is scope:
 * names such as `bin` are generated output in .NET/Java projects, but can be
 * legitimate source directories in a mixed monorepo.
 */
import { readdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TREE_BLOCK_DIRS } from './fs-ignore.js';

export interface ProjectIgnoreScope {
  /** Project-relative directory; empty string means the workspace root. */
  path: string;
  kind: ProjectIgnoreKind;
}

export interface ProjectIgnoreRules {
  rootPath: string;
  scopes: readonly ProjectIgnoreScope[];
}

const JAVA_MARKERS = new Set([
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'gradlew', 'mvnw', '.classpath',
]);
const DOTNET_EXACT_MARKERS = new Set([
  'global.json', 'directory.build.props', 'directory.build.targets',
  'directory.packages.props', 'nuget.config',
]);
const DOTNET_MARKER_SUFFIXES = ['.csproj', '.fsproj', '.vbproj', '.sln', '.slnx'];

const BASELINE_DIRS_LOWER = new Set(TREE_BLOCK_DIRS.map((name) => name.toLowerCase()));
const DISCOVERY_SKIP = new Set([
  ...BASELINE_DIRS_LOWER,
  ...Object.values(PROFILES).flatMap((profile) =>
    profile.directories.map((name) => name.toLowerCase()),
  ),
  '.hg', '.svn', '.mcp-indexer',
]);

const DISCOVERY_MAX_DEPTH = 6;
const DISCOVERY_MAX_DIRS = 4_096;
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { expiresAt: number; rules: ProjectIgnoreRules }>();
const asyncRulesInFlight = new Map<string, Promise<ProjectIgnoreRules>>();
const discoveryVersions = new Map<string, number>();
let globalDiscoveryVersion = 0;

function normalizeRel(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

function isInsideScope(path: string, scope: string): boolean {
  return scope === '' || path === scope || path.startsWith(`${scope}/`);
}

function alreadyCovered(scopes: readonly ProjectIgnoreScope[], path: string, kind: ProjectIgnoreKind): boolean {
  return scopes.some((scope) => scope.kind === kind && isInsideScope(path, scope.path));
}

function isFileMarker(nameLower: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => nameLower.endsWith(suffix));
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/** Cheap root-only Unity probe for synchronous lifecycle/spawn contracts. */
export function isUnityProjectRoot(rootPath: string): boolean {
  return isDirectory(join(rootPath, 'Assets'))
    && isRegularFile(join(rootPath, 'ProjectSettings', 'ProjectVersion.txt'));
}

async function isRegularFileAsync(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function addDetectedScopes(
  scopes: ProjectIgnoreScope[],
  relativePath: string,
  files: readonly string[],
  unity: boolean,
): void {
  if (unity && !alreadyCovered(scopes, relativePath, 'unity')) {
    scopes.push({ path: relativePath, kind: 'unity' });
  }
  if (unity) return;
  if (files.some((name) => JAVA_MARKERS.has(name)) && !alreadyCovered(scopes, relativePath, 'java')) {
    scopes.push({ path: relativePath, kind: 'java' });
  }
  if (
    files.some((name) => DOTNET_EXACT_MARKERS.has(name) || isFileMarker(name, DOTNET_MARKER_SUFFIXES))
    && !alreadyCovered(scopes, relativePath, 'dotnet')
  ) {
    scopes.push({ path: relativePath, kind: 'dotnet' });
  }
}

function discoverProjectScopes(rootPath: string): ProjectIgnoreScope[] {
  const scopes: ProjectIgnoreScope[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: rootPath, rel: '', depth: 0 },
  ];
  let visited = 0;

  while (queue.length > 0 && visited < DISCOVERY_MAX_DIRS) {
    const current = queue.shift()!;
    visited++;
    let entries;
    try {
      entries = readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    const dirs = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase()),
    );
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase());

    // ProjectVersion.txt makes this strict enough not to mistake an ordinary
    // Assets/ProjectSettings pair for a Unity workspace.
    const isUnity = dirs.has('assets') && dirs.has('projectsettings')
      && isRegularFile(join(current.abs, 'ProjectSettings', 'ProjectVersion.txt'));
    addDetectedScopes(scopes, current.rel, files, isUnity);
    if (isUnity) {
      // A Unity scope already covers its generated descendants. Avoid walking
      // the very large Assets tree merely to rediscover generated .csproj files.
      continue;
    }

    if (current.depth >= DISCOVERY_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || DISCOVERY_SKIP.has(entry.name.toLowerCase())) continue;
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      queue.push({ abs: join(current.abs, entry.name), rel, depth: current.depth + 1 });
    }
  }

  return scopes;
}

export interface ProjectTreeScanOptions {
  maxDepth?: number;
  maxDirectories?: number;
  /** Explicit macrotask yield cadence in addition to async filesystem I/O. */
  yieldEvery?: number;
  /** Collect only files useful to the caller; paths use forward slashes. */
  acceptFile?: (nameLower: string, relativePath: string) => boolean;
}

export interface ProjectTreeScanResult {
  rules: ProjectIgnoreRules;
  files: string[];
  visitedDirectories: number;
  truncated: boolean;
}

/**
 * One-pass, bounded project-tree discovery for latency-sensitive main-process
 * callers. It discovers Java/.NET/Unity scopes and collects requested files in
 * the same async walk, pruning generated descendants as soon as their owning
 * scope is known. Directory symlinks are deliberately not followed.
 */
export async function scanProjectTree(
  rootPath: string,
  options: ProjectTreeScanOptions = {},
): Promise<ProjectTreeScanResult> {
  const normalizedRoot = resolve(rootPath);
  const discoveryVersion = getProjectDiscoveryCacheVersion(normalizedRoot);
  const maxDepth = Math.max(0, options.maxDepth ?? DISCOVERY_MAX_DEPTH);
  const maxDirectories = Math.max(1, options.maxDirectories ?? DISCOVERY_MAX_DIRS);
  const yieldEvery = Math.max(1, options.yieldEvery ?? 32);
  const scopes: ProjectIgnoreScope[] = [];
  const files: string[] = [];
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: normalizedRoot, rel: '', depth: 0 },
  ];
  let queueIndex = 0;
  const rules: ProjectIgnoreRules = { rootPath: normalizedRoot, scopes };
  let visitedDirectories = 0;
  let truncated = false;

  while (queueIndex < queue.length) {
    if (visitedDirectories >= maxDirectories) {
      truncated = true;
      break;
    }
    const current = queue[queueIndex++]!;
    visitedDirectories++;
    let entries;
    try {
      entries = await readdir(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    const dirs = new Set(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase()),
    );
    const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase());
    const unity = dirs.has('assets') && dirs.has('projectsettings')
      && await isRegularFileAsync(join(current.abs, 'ProjectSettings', 'ProjectVersion.txt'));
    addDetectedScopes(scopes, current.rel, names, unity);

    if (!unity) {
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const relativePath = current.rel ? `${current.rel}/${entry.name}` : entry.name;
        const lower = entry.name.toLowerCase();
        if (shouldIgnoreProjectPath(rules, relativePath, false)) continue;
        if (options.acceptFile?.(lower, relativePath)) files.push(relativePath);
      }

      if (current.depth < maxDepth) {
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const relativePath = current.rel ? `${current.rel}/${entry.name}` : entry.name;
          if (shouldIgnoreProjectPath(rules, relativePath, true)) continue;
          queue.push({
            abs: join(current.abs, entry.name),
            rel: relativePath,
            depth: current.depth + 1,
          });
        }
      } else if (entries.some((entry) => entry.isDirectory() && !entry.name.startsWith('.'))) {
        truncated = true;
      }
    }

    if (visitedDirectories % yieldEvery === 0) {
      await new Promise<void>((resolveYield) => setImmediate(resolveYield));
    }
  }

  if (getProjectDiscoveryCacheVersion(normalizedRoot) === discoveryVersion) {
    cache.set(normalizedRoot, { expiresAt: Date.now() + CACHE_TTL_MS, rules });
  }
  return { rules, files, visitedDirectories, truncated };
}

/** Async scope-only discovery for main-process services such as the watcher. */
export async function getProjectIgnoreRulesAsync(rootPath: string): Promise<ProjectIgnoreRules> {
  const normalizedRoot = resolve(rootPath);
  const now = Date.now();
  const cached = cache.get(normalizedRoot);
  if (cached && cached.expiresAt > now) return cached.rules;
  const version = getProjectDiscoveryCacheVersion(normalizedRoot);
  const pendingKey = `${normalizedRoot}\0${version}`;
  const pending = asyncRulesInFlight.get(pendingKey);
  if (pending) return pending;
  const promise = scanProjectTree(normalizedRoot)
    .then((result) => result.rules)
    .finally(() => asyncRulesInFlight.delete(pendingKey));
  asyncRulesInFlight.set(pendingKey, promise);
  return promise;
}

/** Detect Java/.NET/Unity roots, including bounded nested monorepo scopes. */
export function getProjectIgnoreRules(rootPath: string): ProjectIgnoreRules {
  const normalizedRoot = resolve(rootPath);
  const now = Date.now();
  const cached = cache.get(normalizedRoot);
  if (cached && cached.expiresAt > now) return cached.rules;
  const rules: ProjectIgnoreRules = {
    rootPath: normalizedRoot,
    scopes: discoverProjectScopes(normalizedRoot),
  };
  cache.set(normalizedRoot, { expiresAt: now + CACHE_TTL_MS, rules });
  return rules;
}

export function clearProjectIgnoreRulesCache(rootPath?: string): void {
  invalidateProjectDiscoveryCache(rootPath);
}

/** Version observed by derivative caches such as runner manifest discovery. */
export function getProjectDiscoveryCacheVersion(rootPath: string): string {
  const normalizedRoot = resolve(rootPath);
  return `${globalDiscoveryVersion}:${discoveryVersions.get(normalizedRoot) ?? 0}`;
}

/** Invalidate scope and derivative discovery caches after relevant file changes. */
export function invalidateProjectDiscoveryCache(rootPath?: string): void {
  if (rootPath) {
    const normalizedRoot = resolve(rootPath);
    cache.delete(normalizedRoot);
    discoveryVersions.set(normalizedRoot, (discoveryVersions.get(normalizedRoot) ?? 0) + 1);
    return;
  }
  cache.clear();
  discoveryVersions.clear();
  globalDiscoveryVersion++;
}

function matchesSimplePattern(name: string, pattern: string): boolean {
  const star = pattern.indexOf('*');
  if (star < 0) return name === pattern;
  return name.startsWith(pattern.slice(0, star)) && name.endsWith(pattern.slice(star + 1));
}

function profileIgnoresFile(kind: ProjectIgnoreKind, basenameLower: string): boolean {
  const profile = COMPILED_PROFILES[kind];
  if (profile.exactFiles.has(basenameLower)) return true;
  if (profile.fileSuffixes.some((suffix) => basenameLower.endsWith(suffix))) return true;
  return profile.filePatterns.some((pattern) => matchesSimplePattern(basenameLower, pattern));
}

/**
 * Test a project-relative path against baseline tree rules plus every profile
 * whose detected scope contains it. Directory rules match any path segment,
 * so this works for both directory entries and files below generated roots.
 */
export function shouldIgnoreProjectPath(
  rules: ProjectIgnoreRules,
  relativePath: string,
  isDirectory = false,
): boolean {
  const rel = normalizeRel(relativePath);
  if (!rel) return false;
  const allSegments = rel.split('/');
  if (allSegments.some((segment) => BASELINE_DIRS_LOWER.has(segment.toLowerCase()))) return true;

  for (const scope of rules.scopes) {
    if (!isInsideScope(rel, scope.path) || rel === scope.path) continue;
    const inside = scope.path ? rel.slice(scope.path.length + 1) : rel;
    const segments = inside.split('/');
    const profile = COMPILED_PROFILES[scope.kind];
    if (segments.some((segment) => profile.directories.has(segment.toLowerCase()))) return true;
    if (!isDirectory && profileIgnoresFile(scope.kind, segments.at(-1)!.toLowerCase())) return true;
  }
  return false;
}

function spellingVariants(name: string): string[] {
  const lower = name.toLowerCase();
  return lower === name ? [name] : [name, lower];
}

/** Gitignore-style patterns for APIs that already use the `ignore` package. */
export function projectIgnorePatterns(rules: ProjectIgnoreRules): string[] {
  const out = new Set<string>();
  for (const scope of rules.scopes) {
    const profile = PROFILES[scope.kind];
    for (const directory of profile.directories.flatMap(spellingVariants)) {
      if (scope.path) {
        out.add(`${scope.path}/${directory}/`);
        out.add(`${scope.path}/**/${directory}/`);
      } else {
        out.add(`${directory}/`);
      }
    }
    const filePatterns = [
      ...profile.exactFiles,
      ...profile.fileSuffixes.map((suffix) => `*${suffix}`),
      ...profile.filePatterns,
    ];
    for (const pattern of filePatterns) {
      if (scope.path) {
        out.add(`${scope.path}/${pattern}`);
        out.add(`${scope.path}/**/${pattern}`);
      } else {
        out.add(pattern);
      }
    }
  }
  return [...out];
}

/**
 * `glob` ignores for generated directories and profile-specific generated
 * files. Post-walk filtering remains authoritative; these patterns are a
 * performance prune so Unity Library/Java target/.NET obj trees are never
 * enumerated and Unity's many `.meta` files are not yielded one by one.
 */
export function projectGlobPrunePatterns(rules: ProjectIgnoreRules): string[] {
  const out = new Set<string>();
  for (const scope of rules.scopes) {
    const profile = PROFILES[scope.kind];
    for (const directory of profile.directories.flatMap(spellingVariants)) {
      if (scope.path) {
        out.add(`${scope.path}/${directory}/**`);
        out.add(`${scope.path}/**/${directory}/**`);
      } else {
        out.add(`${directory}/**`);
        out.add(`**/${directory}/**`);
      }
    }
    const filePatterns = [
      ...profile.exactFiles,
      ...profile.fileSuffixes.map((suffix) => `*${suffix}`),
      ...profile.filePatterns,
    ];
    for (const pattern of filePatterns) {
      if (scope.path) {
        out.add(`${scope.path}/${pattern}`);
        out.add(`${scope.path}/**/${pattern}`);
      } else {
        out.add(pattern);
        out.add(`**/${pattern}`);
      }
    }
  }
  return [...out];
}
