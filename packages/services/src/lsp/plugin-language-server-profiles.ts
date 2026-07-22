import { isAbsolute } from 'node:path';
import type { LspActivationRule, LspServerDef } from './lsp-server-types.js';

export interface PluginLanguageServerSnapshot {
  id?: unknown;
  label?: unknown;
  languages?: unknown;
  routing?: unknown;
  install?: unknown;
  entryRelPath?: unknown;
  args?: unknown;
  launchKind?: unknown;
  activation?: unknown;
  compatibility?: unknown;
  sizeLabel?: unknown;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_TOKEN = String.raw`(?:\^|~|>=|<=|>|<)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const SEMVER_RANGE_PATTERN = new RegExp(
  `^${RANGE_TOKEN}(?:\\s+${RANGE_TOKEN})*(?:\\s*\\|\\|\\s*${RANGE_TOKEN}(?:\\s+${RANGE_TOKEN})*)*$`,
);
const PROJECT_RANGE_PATTERN = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/;

type VersionTuple = readonly [number, number, number];
interface ProjectBounds { lower: VersionTuple; upper: VersionTuple }
interface NpmInstall { kind: 'npm'; package: string; version: string }

function compareVersion(a: VersionTuple, b: VersionTuple): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function projectBounds(value: unknown): ProjectBounds | null {
  if (typeof value !== 'string') return null;
  const match = PROJECT_RANGE_PATTERN.exec(value);
  if (!match) return null;
  const bounds: ProjectBounds = {
    lower: [Number(match[1]), Number(match[2]), Number(match[3])],
    upper: [Number(match[4]), Number(match[5]), Number(match[6])],
  };
  return compareVersion(bounds.lower, bounds.upper) < 0 ? bounds : null;
}

function safeRelativePath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  return candidate.length > 0
    && !isAbsolute(candidate)
    && !normalized.startsWith('/')
    && !normalized.split('/').includes('..');
}

function npmInstall(value: unknown): NpmInstall | null {
  const install = value as { kind?: unknown; package?: unknown; version?: unknown } | null;
  if (!install || install.kind !== 'npm'
    || typeof install.package !== 'string' || !NPM_PACKAGE_PATTERN.test(install.package)
    || typeof install.version !== 'string' || !EXACT_SEMVER_PATTERN.test(install.version)) return null;
  return { kind: 'npm', package: install.package, version: install.version };
}

function stringArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32
    || !value.every((arg) => typeof arg === 'string' && arg.length > 0 && arg.length <= 512)) return null;
  return [...value] as string[];
}

function baseDefinition(
  namespace: string,
  value: PluginLanguageServerSnapshot,
): LspServerDef | null {
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)
    || typeof value.label !== 'string' || !value.label || value.label.length > 128) return null;
  if (!Array.isArray(value.languages) || value.languages.length === 0 || value.languages.length > 32
    || !value.languages.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 64)) return null;
  const install = npmInstall(value.install);
  if (!install || typeof value.entryRelPath !== 'string' || !safeRelativePath(value.entryRelPath)) return null;
  const routing = value.routing as { mode?: unknown; priority?: unknown } | null;
  if (routing?.mode !== 'primary' && routing?.mode !== 'overlay') return null;
  const launchKind = value.launchKind ?? 'standard';
  if (launchKind !== 'standard' && launchKind !== 'angular') return null;
  const args = stringArgs(value.args ?? []);
  if (!args) return null;
  const activation = value.activation as LspActivationRule | undefined;
  const whenFiles = activation?.whenFiles;
  const whenPackageDep = activation?.whenPackageDep;
  if ((!Array.isArray(whenFiles) || !whenFiles.length)
    && (!Array.isArray(whenPackageDep) || !whenPackageDep.length)) return null;
  if (whenFiles && !whenFiles.every((item) => typeof item === 'string' && safeRelativePath(item))) return null;
  if (whenPackageDep
    && !whenPackageDep.every((item) => typeof item === 'string' && NPM_PACKAGE_PATTERN.test(item))) return null;
  return {
    id: value.id,
    label: value.label,
    languages: [...value.languages] as string[],
    role: routing.mode,
    install,
    entryRelPath: value.entryRelPath,
    args,
    launchKind,
    sizeLabel: typeof value.sizeLabel === 'string' ? value.sizeLabel : 'download required',
    projectActivation: activation,
    pluginNamespace: namespace,
    priority: typeof routing.priority === 'number' ? routing.priority : 0,
  };
}

interface ParsedProfile {
  id: string;
  projectRange: string;
  bounds: ProjectBounds;
  supportTier: 'full' | 'best-effort' | 'unsupported';
  serverNodeRange: string;
  typescriptRange?: string;
  languageServiceVersion: string;
  install: NpmInstall;
  entryRelPath: string;
  args: string[];
}

function parsedProfile(value: unknown): ParsedProfile | null {
  const profile = value as Record<string, unknown> | null;
  if (!profile || typeof profile.id !== 'string' || !ID_PATTERN.test(profile.id)) return null;
  const bounds = projectBounds(profile.projectVersionRange);
  if (!bounds || typeof profile.projectVersionRange !== 'string') return null;
  if (profile.supportTier !== 'full'
    && profile.supportTier !== 'best-effort'
    && profile.supportTier !== 'unsupported') return null;
  if (typeof profile.serverNodeRange !== 'string' || !SEMVER_RANGE_PATTERN.test(profile.serverNodeRange)) return null;
  if (profile.typescriptRange !== undefined
    && (typeof profile.typescriptRange !== 'string' || !SEMVER_RANGE_PATTERN.test(profile.typescriptRange))) return null;
  if (typeof profile.languageServiceVersion !== 'string'
    || !EXACT_SEMVER_PATTERN.test(profile.languageServiceVersion)) return null;
  const install = npmInstall(profile.install);
  const args = stringArgs(profile.args);
  if (!install || !args
    || typeof profile.entryRelPath !== 'string' || !safeRelativePath(profile.entryRelPath)) return null;
  return {
    id: profile.id,
    projectRange: profile.projectVersionRange,
    bounds,
    supportTier: profile.supportTier,
    serverNodeRange: profile.serverNodeRange,
    typescriptRange: profile.typescriptRange as string | undefined,
    languageServiceVersion: profile.languageServiceVersion,
    install,
    entryRelPath: profile.entryRelPath,
    args,
  };
}

function profilesAreDisjoint(profiles: ParsedProfile[]): boolean {
  const ids = new Set<string>();
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (ids.has(profile.id)) return false;
    ids.add(profile.id);
    for (let previous = 0; previous < index; previous += 1) {
      const other = profiles[previous];
      if (compareVersion(profile.bounds.lower, other.bounds.upper) < 0
        && compareVersion(other.bounds.lower, profile.bounds.upper) < 0) return false;
    }
  }
  return true;
}

function sameFallback(base: LspServerDef, profile: ParsedProfile): boolean {
  return base.install.kind === 'npm'
    && base.install.package === profile.install.package
    && base.install.version === profile.install.version
    && base.entryRelPath === profile.entryRelPath
    && JSON.stringify(base.args) === JSON.stringify(profile.args);
}

export function effectiveProfileServerId(familyId: string, profileId: string): string {
  return `${familyId}--${profileId}`;
}

/** Invalid compatibility metadata degrades to the already-approved fallback. */
export function rehydratePluginLanguageServer(
  namespace: string,
  snapshot: PluginLanguageServerSnapshot,
): LspServerDef[] {
  const base = baseDefinition(namespace, snapshot);
  if (!base || snapshot.compatibility === undefined) return base ? [base] : [];
  const compatibility = snapshot.compatibility as { projectResolver?: unknown; profiles?: unknown } | null;
  if (!compatibility || compatibility.projectResolver !== 'angular-core'
    || !Array.isArray(compatibility.profiles) || compatibility.profiles.length === 0
    || compatibility.profiles.length > 32) return [base];
  const profiles = compatibility.profiles.map(parsedProfile);
  if (profiles.some((profile) => !profile)) return [base];
  const validProfiles = profiles as ParsedProfile[];
  if (!profilesAreDisjoint(validProfiles)) return [base];
  const defaults = validProfiles.filter((profile) => sameFallback(base, profile));
  if (defaults.length !== 1) return [base];
  const defaultId = defaults[0].id;
  const versionCounts = new Map<string, number>();
  for (const profile of validProfiles) {
    versionCounts.set(profile.install.version, (versionCounts.get(profile.install.version) ?? 0) + 1);
  }
  return validProfiles.map((profile) => ({
    ...base,
    id: effectiveProfileServerId(base.id, profile.id),
    // Preserve the legacy family@version directory whenever it is unambiguous,
    // especially for the declared fallback. Profiles sharing one version need
    // separate physical ownership so installing/removing one cannot affect the
    // other profile's live server.
    storageId: versionCounts.get(profile.install.version) === 1 || profile.id === defaultId
      ? base.id
      : effectiveProfileServerId(base.id, profile.id),
    install: profile.install,
    entryRelPath: profile.entryRelPath,
    args: profile.args,
    familyId: base.id,
    profileId: profile.id,
    projectRange: profile.projectRange,
    supportTier: profile.supportTier,
    serverNodeRange: profile.serverNodeRange,
    typescriptRange: profile.typescriptRange,
    languageServiceVersion: profile.languageServiceVersion,
    projectResolver: 'angular-core',
    defaultProfile: profile.id === defaultId,
  }));
}

export function pluginDefinitionFingerprint(def: LspServerDef | undefined): string {
  if (!def) return '';
  return JSON.stringify({
    id: def.id, storageId: def.storageId, label: def.label, languages: def.languages,
    role: def.role, install: def.install, entryRelPath: def.entryRelPath, args: def.args,
    launchKind: def.launchKind, sizeLabel: def.sizeLabel, projectActivation: def.projectActivation,
    pluginNamespace: def.pluginNamespace, priority: def.priority, familyId: def.familyId,
    profileId: def.profileId, projectRange: def.projectRange, supportTier: def.supportTier,
    serverNodeRange: def.serverNodeRange, typescriptRange: def.typescriptRange,
    languageServiceVersion: def.languageServiceVersion, projectResolver: def.projectResolver,
    defaultProfile: def.defaultProfile,
  });
}
