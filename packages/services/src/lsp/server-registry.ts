/**
 * Catalog of installable LSP servers. Two install kinds:
 *   - 'npm'    — node-based servers, installed via npm and run with the
 *                app's managed Node (`node <entry> --stdio`).
 *   - 'binary' — native executables from pinned GitHub release assets,
 *                spawned directly (no Node, no ELECTRON_RUN_AS_NODE).
 * Versions are PINNED: one global install per `id@version` under the data
 * dir; bumping a version here installs side-by-side on the next prompt.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LSP_SERVER_REGISTRY } from './built-in-server-catalog.js';
import {
  pluginLanguageServers,
  pluginProfileServers,
  pluginServerById,
  pluginServersForFamily,
} from './plugin-language-server-registry.js';
import {
  type LspActivationRule,
  type LspServerDef,
} from './lsp-server-types.js';

export { JDTLS_LOMBOK_RELPATH, LSP_SERVER_REGISTRY } from './built-in-server-catalog.js';
export type {
  LspActivationRule,
  LspBinaryAsset,
  LspCompanionAsset,
  LspDynamicSpawnContext,
  LspInstallSpec,
  LspRuntimeResolution,
  LspServerDef,
  LspSpawnCommand,
  LspTargetKey,
} from './lsp-server-types.js';
export {
  binaryAssetFor,
  currentTargetKey,
  entryFor,
  installDirFor,
  isInstalled,
  spawnSpecFor,
  validateNpmServerInstall,
} from './server-spawn.js';
export {
  replacePluginLanguageServers,
  syncPluginLanguageServers,
} from './plugin-language-server-registry.js';
export type {
  PluginLanguageServerSnapshot,
  PluginLanguageServerSyncResult,
} from './plugin-language-server-registry.js';

/** Built-ins plus the currently enabled, trusted bundled-plugin servers. */
export function allLspServers(): readonly LspServerDef[] {
  return [...LSP_SERVER_REGISTRY, ...pluginLanguageServers()];
}

/** Effective compatibility-profile definitions across all plugin families. */
export function allLspServerProfiles(): readonly LspServerDef[] {
  return pluginProfileServers();
}

/** Effective definitions belonging to one logical language-server family. */
export function lspServersForFamily(familyId: string): readonly LspServerDef[] {
  return pluginServersForFamily(familyId);
}

function fileMatches(root: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    try { return readdirSync(root).some((name) => name.endsWith(pattern.slice(1))); }
    catch { return false; }
  }
  return existsSync(join(root, pattern));
}

function projectDependencies(root: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

const ANGULAR_SCAN_MAX_DEPTH = 6;
const ANGULAR_SCAN_MAX_DIRECTORIES = 4_096;
const ANGULAR_SCAN_CACHE_TTL_MS = 30_000;
const ANGULAR_SCAN_CACHE_MAX_ENTRIES = 256;
const ANGULAR_SCAN_BLOCKED_DIRECTORIES = new Set([
  '.angular',
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.next',
  '.nuxt',
  '.nx',
  '.pnpm-store',
  '.svn',
  '.svelte-kit',
  '.turbo',
  '.vite',
  '.yarn',
  'bower_components',
  'build',
  'cache',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'temp',
  'tmp',
  'vendor',
]);

interface AngularScanCacheEntry {
  value: boolean;
  expiresAt: number;
}

const angularScanCache = new Map<string, AngularScanCacheEntry>();

function isAngularWorkspaceMarker(pattern: string): boolean {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '') === 'angular.json';
}

function angularScanRule(rule: LspActivationRule): { matchAngularJson: boolean; matchAngularPackage: boolean } {
  return {
    matchAngularJson: rule.whenFiles?.some(isAngularWorkspaceMarker) ?? false,
    matchAngularPackage: rule.whenPackageDep?.includes('@angular/core') ?? false,
  };
}

/**
 * Finds Angular workspaces in monorepos without an unbounded recursive glob.
 * Root markers are handled by the fast path in isLspServerActive; this scan
 * only considers descendants and does not follow symlinked directories.
 */
function scanNestedAngularProject(
  root: string,
  matchAngularJson: boolean,
  matchAngularPackage: boolean,
): boolean {
  if (!matchAngularJson && !matchAngularPackage) return false;

  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scannedDirectories = 0;

  for (let index = 0; index < pending.length && scannedDirectories < ANGULAR_SCAN_MAX_DIRECTORIES; index += 1) {
    const current = pending[index]!;
    scannedDirectories += 1;

    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    if (current.depth > 0) {
      if (matchAngularJson && entries.some((entry) => entry.isFile() && entry.name === 'angular.json')) {
        return true;
      }
      if (matchAngularPackage
        && entries.some((entry) => entry.isFile() && entry.name === 'package.json')
        && projectDependencies(current.dir).has('@angular/core')) {
        return true;
      }
    }

    if (current.depth >= ANGULAR_SCAN_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || ANGULAR_SCAN_BLOCKED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (pending.length >= ANGULAR_SCAN_MAX_DIRECTORIES) break;
      pending.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return false;
}

function hasNestedAngularProject(root: string, rule: LspActivationRule): boolean {
  const { matchAngularJson, matchAngularPackage } = angularScanRule(rule);
  if (!matchAngularJson && !matchAngularPackage) return false;

  const cacheKey = `${root}\0${matchAngularJson ? 'json' : ''}\0${matchAngularPackage ? 'package' : ''}`;
  const now = Date.now();
  const cached = angularScanCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Map insertion order doubles as a small LRU: refresh recency on every hit.
    angularScanCache.delete(cacheKey);
    angularScanCache.set(cacheKey, cached);
    return cached.value;
  }
  if (cached) angularScanCache.delete(cacheKey);

  const value = scanNestedAngularProject(root, matchAngularJson, matchAngularPackage);
  if (angularScanCache.size >= ANGULAR_SCAN_CACHE_MAX_ENTRIES) {
    const oldestKey = angularScanCache.keys().next().value;
    if (oldestKey !== undefined) angularScanCache.delete(oldestKey);
  }
  angularScanCache.set(cacheKey, { value, expiresAt: now + ANGULAR_SCAN_CACHE_TTL_MS });
  return value;
}

export function isLspServerActive(def: LspServerDef, projectRoot: string | null): boolean {
  const rule = def.projectActivation;
  if (!rule || (!rule.whenFiles?.length && !rule.whenPackageDep?.length)) return true;
  if (!projectRoot) return false;
  if (rule.whenFiles?.some((pattern) => fileMatches(projectRoot, pattern))) return true;
  const deps = rule.whenPackageDep?.length ? projectDependencies(projectRoot) : null;
  if (deps && rule.whenPackageDep!.some((name) => deps.has(name))) return true;
  return def.launchKind === 'angular' && hasNestedAngularProject(projectRoot, rule);
}

export function serverForLanguage(languageId: string): LspServerDef | undefined {
  // Only PRIMARY servers take part in per-language routing — complementary
  // roles (ruff) never shadow pyright regardless of catalog order.
  return allLspServers().find(
    (s) => (s.role ?? 'primary') === 'primary' && s.languages.includes(languageId),
  );
}

export function overlayServersForLanguage(
  languageId: string,
  projectRoot: string | null,
): LspServerDef[] {
  return allLspServers()
    .filter((s) => s.role === 'overlay' && s.languages.includes(languageId) && isLspServerActive(s, projectRoot))
    // This route has no file/facet version context. A compatibility family
    // must therefore expose only its declared fallback, never the first
    // profile in manifest order (which is commonly the oldest Angular).
    .filter((s) => !s.profileId || s.defaultProfile === true)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function serverById(id: string): LspServerDef | undefined {
  return LSP_SERVER_REGISTRY.find((server) => server.id === id) ?? pluginServerById(id);
}
