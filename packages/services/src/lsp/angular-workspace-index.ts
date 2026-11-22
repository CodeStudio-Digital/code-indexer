import { isAbsolute, join, relative, resolve } from 'node:path';
import { canonicalAbs } from '@mcp/shared/utils/fs-canonical.js';
import {
  resolveAngularVersion,
  type AngularVersionConfidence,
  type AngularVersionSource,
} from './angular-version-resolver.js';
import { angularFingerprint } from './angular-version-utils.js';
import {
  discoverAngularWorkspaces,
  type AngularWorkspaceDraft,
  type AngularWorkspaceMarkers,
} from './angular-workspace-scanner.js';

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_DIRECTORIES = 4_096;
const DEFAULT_TTL_MS = 30_000;
const CACHE_LIMIT = 128;

const INVALIDATION_FILES = new Set([
  'angular.json', 'project.json', 'nx.json', 'package.json',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

export interface AngularWorkspaceFacet {
  id: string;
  name?: string;
  /** Project-relative package key used only for persisted profile overrides. */
  overridePath: string;
  workspaceRoot: string;
  packageRoot: string;
  sourceRoots: string[];
  version: string | null;
  major: number | null;
  versionSource: AngularVersionSource;
  confidence: AngularVersionConfidence;
  declaredRange?: string;
  evidencePath?: string;
  fingerprint: string;
}

export interface AngularWorkspaceIndex {
  projectRoot: string;
  nestedMarkers: AngularWorkspaceMarkers;
  facets: AngularWorkspaceFacet[];
  fingerprint: string;
  scannedDirectories: number;
  createdAt: number;
}

export interface AngularWorkspaceResolution extends AngularWorkspaceFacet {
  projectRoot: string;
  file: string;
}

export interface AngularWorkspaceIndexOptions {
  maxDepth?: number;
  maxDirectories?: number;
  ttlMs?: number;
  now?: () => number;
  /** Keys are exact project-relative package roots (`.` only for the root package). */
  overrides?: Readonly<Record<string, string>>;
}

export interface AngularWorkspaceMetadataChange {
  projectRoot: string;
  changedPath: string;
}

type MetadataChangeListener = (event: AngularWorkspaceMetadataChange) => void;

const metadataChangeListeners = new Set<MetadataChangeListener>();

/** Subscribe to watcher-driven Angular metadata invalidations. */
export function onAngularWorkspaceMetadataChanged(listener: MetadataChangeListener): () => void {
  metadataChangeListeners.add(listener);
  return () => metadataChangeListeners.delete(listener);
}

interface CacheEntry {
  index: AngularWorkspaceIndex;
  expiresAt: number;
}

const indexCache = new Map<string, CacheEntry>();
const loading = new Map<string, Promise<AngularWorkspaceIndex>>();

function native(path: string): string { return resolve(path); }
function canonical(path: string): string { return canonicalAbs(native(path)); }

function isWithin(parent: string, child: string): boolean {
  const rel = relative(native(parent), native(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function relativeKey(projectRoot: string, path: string): string {
  return relative(projectRoot, path).replace(/\\/g, '/') || '.';
}

function overrideFor(draft: AngularWorkspaceDraft, projectRoot: string, overrides?: Readonly<Record<string, string>>): string | undefined {
  if (!overrides) return undefined;
  return overrides[relativeKey(projectRoot, draft.packageRoot)];
}

function materializeDraft(draft: AngularWorkspaceDraft, projectRoot: string, options: AngularWorkspaceIndexOptions): AngularWorkspaceFacet {
  const version = resolveAngularVersion({
    projectRoot,
    packageRoot: draft.packageRoot,
    overrideVersion: overrideFor(draft, projectRoot, options.overrides),
  });
  const workspaceRoot = canonical(draft.workspaceRoot);
  const packageRoot = canonical(draft.packageRoot);
  const overridePath = relativeKey(projectRoot, packageRoot);
  const sourceRoots = [...new Set(draft.sourceRoots.map(canonical))].sort((a, b) => b.length - a.length);
  const id = angularFingerprint([workspaceRoot, packageRoot, sourceRoots, draft.name]);
  return {
    id,
    name: draft.name,
    overridePath,
    workspaceRoot,
    packageRoot,
    sourceRoots,
    version: version.version,
    major: version.major,
    versionSource: version.source,
    confidence: version.confidence,
    declaredRange: version.declaredRange,
    evidencePath: version.evidencePath,
    fingerprint: angularFingerprint([id, draft.metadataFingerprint, version.fingerprint]),
  };
}

export function buildAngularWorkspaceIndex(projectRoot: string, options: AngularWorkspaceIndexOptions, createdAt: number): AngularWorkspaceIndex {
  const root = native(projectRoot);
  const discovery = discoverAngularWorkspaces(
    root,
    Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH),
    Math.max(1, options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES),
  );
  const facets = discovery.drafts
    .map((draft) => materializeDraft(draft, root, options))
    .filter((facet, index, all) => all.findIndex((candidate) => candidate.id === facet.id) === index);
  return {
    projectRoot: canonical(root),
    nestedMarkers: discovery.nestedMarkers,
    facets,
    fingerprint: angularFingerprint(facets.map((facet) => facet.fingerprint).sort()),
    scannedDirectories: discovery.scannedDirectories,
    createdAt,
  };
}

function optionsFingerprint(options: AngularWorkspaceIndexOptions): string {
  return angularFingerprint([
    options.maxDepth ?? DEFAULT_MAX_DEPTH,
    options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
    Object.entries(options.overrides ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function cachedIndex(key: string, now: number): AngularWorkspaceIndex | undefined {
  const cached = indexCache.get(key);
  if (cached && cached.expiresAt > now) {
    indexCache.delete(key);
    indexCache.set(key, cached);
    return cached.index;
  }
  if (cached) indexCache.delete(key);
  return undefined;
}

function rememberIndex(key: string, index: AngularWorkspaceIndex, options: AngularWorkspaceIndexOptions): AngularWorkspaceIndex {
  while (indexCache.size >= CACHE_LIMIT) {
    const oldest = indexCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
  const finishedAt = (options.now ?? Date.now)();
  indexCache.set(key, { index, expiresAt: finishedAt + Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS) });
  return index;
}

export function getAngularWorkspaceIndex(projectRoot: string, options: AngularWorkspaceIndexOptions = {}): AngularWorkspaceIndex {
  const root = canonical(projectRoot);
  const key = `${root}\0${optionsFingerprint(options)}`;
  const now = (options.now ?? Date.now)();
  return cachedIndex(key, now) ?? rememberIndex(key, buildAngularWorkspaceIndex(root, options, now), options);
}

/** Synchronous status notifications may use a completed scan without starting filesystem work. */
export function peekAngularWorkspaceIndex(projectRoot: string, options: AngularWorkspaceIndexOptions): AngularWorkspaceIndex | undefined {
  return cachedIndex(`${canonical(projectRoot)}\0${optionsFingerprint(options)}`, (options.now ?? Date.now)());
}

/** Share one background discovery across editor operations for the same project and overrides. */
export function loadAngularWorkspaceIndex(
  projectRoot: string,
  options: AngularWorkspaceIndexOptions,
  scan: () => Promise<AngularWorkspaceIndex>,
): Promise<AngularWorkspaceIndex> {
  const key = `${canonical(projectRoot)}\0${optionsFingerprint(options)}`;
  const hit = cachedIndex(key, (options.now ?? Date.now)());
  if (hit) return Promise.resolve(hit);
  const existing = loading.get(key);
  if (existing) return existing;
  const pending = scan().then(index => {
    // A metadata change can invalidate a scan before its worker returns.
    if (loading.get(key) !== pending) return loadAngularWorkspaceIndex(projectRoot, options, scan);
    return rememberIndex(key, index, options);
  }).finally(() => {
    if (loading.get(key) === pending) loading.delete(key);
  });
  loading.set(key, pending);
  return pending;
}

function prefixLength(parent: string, file: string): number {
  return isWithin(parent, file) ? canonical(parent).length : -1;
}

export function angularProjectFile(projectRoot: string, file: string): string | null {
  const absolute = resolve(projectRoot, file);
  return isWithin(projectRoot, absolute) ? absolute : null;
}

/** Resolve an active project-relative or absolute file to its narrowest Angular facet. */
export function resolveAngularWorkspace(
  projectRoot: string,
  file: string,
  options: AngularWorkspaceIndexOptions = {},
  prepared?: AngularWorkspaceIndex,
): AngularWorkspaceResolution | null {
  const absoluteFile = angularProjectFile(projectRoot, file);
  if (!absoluteFile) return null;
  const index = prepared ?? getAngularWorkspaceIndex(projectRoot, options);
  const ranked = index.facets.map((facet) => {
    const sourceScore = Math.max(-1, ...facet.sourceRoots.map((sourceRoot) => prefixLength(sourceRoot, absoluteFile)));
    const packageScore = prefixLength(facet.packageRoot, absoluteFile);
    const workspaceScore = prefixLength(facet.workspaceRoot, absoluteFile);
    const score = sourceScore >= 0 ? 2_000_000 + sourceScore
      : packageScore >= 0 ? 1_000_000 + packageScore
        : workspaceScore;
    return { facet, score };
  }).filter(({ score }) => score >= 0).sort((a, b) => b.score - a.score);
  const selected = ranked[0];
  if (!selected) return null;
  // A tie means the file is outside the distinguishing source roots. Refuse to
  // guess between potentially different Angular versions.
  if (ranked[1]?.score === selected.score && ranked[1].facet.id !== selected.facet.id) return null;
  return {
    ...selected.facet,
    projectRoot: index.projectRoot,
    file: canonical(absoluteFile),
  };
}

export function invalidateAngularWorkspaceIndex(projectRoot?: string): void {
  if (!projectRoot) { indexCache.clear(); loading.clear(); return; }
  const prefix = `${canonical(projectRoot)}\0`;
  for (const key of [...indexCache.keys()]) if (key.startsWith(prefix)) indexCache.delete(key);
  for (const key of loading.keys()) if (key.startsWith(prefix)) loading.delete(key);
}

/** Fast watcher hook: unrelated source edits do not invalidate the metadata index. */
export function invalidateAngularWorkspaceForPath(projectRoot: string, changedPath: string): boolean {
  const normalized = canonical(isAbsolute(changedPath) ? changedPath : join(projectRoot, changedPath));
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const relevant = INVALIDATION_FILES.has(basename)
    || normalized.endsWith('/node_modules/@angular/core/package.json');
  if (relevant) {
    invalidateAngularWorkspaceIndex(projectRoot);
    const event = { projectRoot: canonical(projectRoot), changedPath: normalized };
    for (const listener of metadataChangeListeners) {
      try { listener(event); } catch { /* watcher invalidation must stay non-fatal */ }
    }
  }
  return relevant;
}
