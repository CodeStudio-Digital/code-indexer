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
import { getAngularWorkspaceIndex } from './angular-workspace-index.js';
import type { AngularWorkspaceMarkers } from './angular-workspace-scanner.js';
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

type NestedMarkers = (root: string) => AngularWorkspaceMarkers | undefined;

function ruleMatchesRoot(root: string, rule: LspActivationRule): boolean {
  if (rule.whenFiles?.some(pattern => fileMatches(root, pattern))) return true;
  if (!rule.whenPackageDep?.length) return false;
  const dependencies = projectDependencies(root);
  return rule.whenPackageDep.some(name => dependencies.has(name));
}

function usesAngularJson(rule: LspActivationRule): boolean {
  return rule.whenFiles?.some(pattern => pattern.replace(/\\/g, '/').replace(/^\.\//, '') === 'angular.json') ?? false;
}

export function needsNestedAngularMarkers(def: LspServerDef, root: string): boolean {
  const rule = def.projectActivation;
  return def.launchKind === 'angular' && !!rule
    && (usesAngularJson(rule) || !!rule.whenPackageDep?.includes('@angular/core'))
    && !ruleMatchesRoot(root, rule);
}

export function isLspServerActive(
  def: LspServerDef, projectRoot: string | null,
  nested: NestedMarkers = root => getAngularWorkspaceIndex(root).nestedMarkers,
): boolean {
  const rule = def.projectActivation;
  if (!rule || (!rule.whenFiles?.length && !rule.whenPackageDep?.length)) return true;
  if (!projectRoot) return false;
  if (ruleMatchesRoot(projectRoot, rule)) return true;
  if (def.launchKind !== 'angular') return false;
  const markers = nested(projectRoot);
  return !!markers && ((markers.angularJson && usesAngularJson(rule))
    || (markers.angularPackage && !!rule.whenPackageDep?.includes('@angular/core')));
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
  nested?: NestedMarkers,
): LspServerDef[] {
  return allLspServers()
    .filter((s) => s.role === 'overlay' && s.languages.includes(languageId))
    // This route has no file/facet version context. A compatibility family
    // must therefore expose only its declared fallback, never the first
    // profile in manifest order (which is commonly the oldest Angular).
    .filter((s) => !s.profileId || s.defaultProfile === true)
    .filter((s) => isLspServerActive(s, projectRoot, nested))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}

export function serverById(id: string): LspServerDef | undefined {
  return LSP_SERVER_REGISTRY.find((server) => server.id === id) ?? pluginServerById(id);
}
