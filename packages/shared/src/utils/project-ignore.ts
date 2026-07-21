/**
 * Project-aware ignore profiles shared by the live Explorer, watcher and
 * structural indexer. The important distinction from `fs-ignore.ts` is scope:
 * names such as `bin` are generated output in .NET/Java projects, but can be
 * legitimate source directories in a mixed monorepo.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TREE_BLOCK_DIRS } from './fs-ignore.js';

export type ProjectIgnoreKind = 'java' | 'dotnet' | 'unity';

export interface ProjectIgnoreScope {
  /** Project-relative directory; empty string means the workspace root. */
  path: string;
  kind: ProjectIgnoreKind;
}

export interface ProjectIgnoreRules {
  rootPath: string;
  scopes: readonly ProjectIgnoreScope[];
}

interface IgnoreProfile {
  /** Conventional spelling is retained so glob pruning works on Linux. */
  directories: readonly string[];
  exactFiles: readonly string[];
  fileSuffixes: readonly string[];
  filePatterns: readonly string[];
}

const JAVA_PROFILE: IgnoreProfile = {
  directories: [
    'target', 'build', 'out', 'bin', '.gradle', '.kotlin', '.settings',
    '.metadata', '.recommenders', '.cxx', '.externalNativeBuild', 'captures',
  ],
  exactFiles: ['.classpath', '.project', '.factorypath', 'dependency-reduced-pom.xml'],
  fileSuffixes: ['.iml'],
  filePatterns: ['hs_err_pid*.log', 'replay_pid*.log'],
};

const DOTNET_PROFILE: IgnoreProfile = {
  directories: [
    'bin', 'obj', '.vs', '.nuget', 'TestResults', 'artifacts',
    'BenchmarkDotNet.Artifacts', '_ReSharper.Caches', '.sonarqube', '.fake', 'ipch',
  ],
  exactFiles: [],
  fileSuffixes: [
    '.user', '.suo', '.userosscache', '.sln.docstates', '.nupkg', '.snupkg',
    '.coverage', '.coveragexml',
  ],
  filePatterns: [],
};

const UNITY_PROFILE: IgnoreProfile = {
  directories: [
    // Unity's generated/cache roots. Assets, Packages and ProjectSettings are
    // intentionally absent: they are authoritative project input.
    'Library', 'Temp', 'Logs', 'UserSettings', 'MemoryCaptures', 'Recordings',
    'bin', 'obj', 'Build', 'Builds', 'ExportedObj', '.vs', '.nuget', '.gradle',
    'TestResults', 'artifacts', 'BenchmarkDotNet.Artifacts',
  ],
  exactFiles: [],
  fileSuffixes: [
    // Unity regenerates these IDE artifacts. `.meta` remains on disk/in Git;
    // this only keeps it out of the code tree/index/watch stream.
    '.meta', '.csproj', '.sln', '.slnx', '.unityproj', '.pidb', '.booproj',
    '.svd', '.pdb', '.mdb', '.opendb', '.vc.db', '.user', '.userprefs', '.suo',
  ],
  // Unity's directory monitor drops (and immediately deletes) a
  // `~UnityDirMonSyncFile~<guid>` marker into every folder it watches — pure
  // churn that would otherwise spam the watcher/index with add+unlink pairs.
  filePatterns: ['~UnityDirMonSyncFile~*'],
};

const PROFILES: Record<ProjectIgnoreKind, IgnoreProfile> = {
  java: JAVA_PROFILE,
  dotnet: DOTNET_PROFILE,
  unity: UNITY_PROFILE,
};

interface CompiledIgnoreProfile {
  directories: ReadonlySet<string>;
  exactFiles: ReadonlySet<string>;
  fileSuffixes: readonly string[];
  filePatterns: readonly string[];
}

function compileProfile(profile: IgnoreProfile): CompiledIgnoreProfile {
  return {
    directories: new Set(profile.directories.map((name) => name.toLowerCase())),
    exactFiles: new Set(profile.exactFiles.map((name) => name.toLowerCase())),
    fileSuffixes: profile.fileSuffixes.map((suffix) => suffix.toLowerCase()),
    filePatterns: profile.filePatterns.map((pattern) => pattern.toLowerCase()),
  };
}

const COMPILED_PROFILES: Record<ProjectIgnoreKind, CompiledIgnoreProfile> = {
  java: compileProfile(JAVA_PROFILE),
  dotnet: compileProfile(DOTNET_PROFILE),
  unity: compileProfile(UNITY_PROFILE),
};

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
    if (isUnity) {
      if (!alreadyCovered(scopes, current.rel, 'unity')) {
        scopes.push({ path: current.rel, kind: 'unity' });
      }
      // A Unity scope already covers its generated descendants. Avoid walking
      // the very large Assets tree merely to rediscover generated .csproj files.
      continue;
    }

    if (files.some((name) => JAVA_MARKERS.has(name)) && !alreadyCovered(scopes, current.rel, 'java')) {
      scopes.push({ path: current.rel, kind: 'java' });
    }
    if (
      files.some((name) => DOTNET_EXACT_MARKERS.has(name) || isFileMarker(name, DOTNET_MARKER_SUFFIXES))
      && !alreadyCovered(scopes, current.rel, 'dotnet')
    ) {
      scopes.push({ path: current.rel, kind: 'dotnet' });
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
  if (rootPath) cache.delete(resolve(rootPath));
  else cache.clear();
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
