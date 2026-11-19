/**
 * Runner detection — scans a project's root directory for runnable
 * commands across ecosystems (JS/TS, PHP, Java, .NET). Pure filesystem
 * reads (node:fs), no spawning. Returns groups keyed by package manager
 * with an install hint each.
 *
 * Detection is intentionally manifest-driven; .NET project discovery uses a
 * bounded walk for conventional `src/App/App.csproj` layouts. Java/.NET goals are a curated common set since those tools don't expose
 * a cheap machine-readable task list without invoking the build.
 */

import { existsSync, readFileSync, type Dirent } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mapLimit } from '@mcp/shared/utils/map-limit.js';
import { getProjectDiscoveryCacheVersion } from '@mcp/shared/utils/project-ignore.js';
import { readProjectDirectory } from '@mcp/shared/utils/project-directory-reads.js';
import { scanRunnerManifests } from './runner-manifests.js';
import type {
  DetectedGroup,
  DetectedRunner,
  DetectedRunners,
  RunnerManager,
} from '@mcp/api-bus';
import {
  scanDotnetProjects,
  type DotnetProjectScan,
} from './dotnet-project-files.js';
import { quoteShellArgument, type ShellFamily } from '../terminal/shell-quote.js';
import { scanComposerProjects } from './composer-project-files.js';

interface DetectionFiles {
  exists(path: string): boolean;
  text(path: string): string | null;
}

function readJson(files: DetectionFiles, path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(files.text(path) ?? 'null') as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Per-project package-manager overrides (from the project settings). */
export interface DetectOptions {
  /** Force the JS manager (else lockfile auto-detect). */
  nodeManager?: RunnerManager;
  /** Force the Python manager (else manifest auto-detect). */
  pythonManager?: RunnerManager;
  /** Prefer Maven or Gradle when both manifests are present. */
  javaManager?: RunnerManager;
  /** Wrapper command syntax must match the execution target, not the host. */
  shellFamily?: ShellFamily;
}

function defaultShellFamily(): ShellFamily {
  return process.platform === 'win32' ? 'cmd' : 'posix';
}

/** Invalid cmd-only names are omitted instead of making project detection fail. */
function safeShellArgument(value: string, shellFamily: ShellFamily): string | null {
  try {
    return quoteShellArgument(value, shellFamily);
  } catch {
    return null;
  }
}

/** Pick the JS package manager from the lockfile present at the root. */
function detectJsManager(root: string, files: DetectionFiles): RunnerManager {
  if (files.exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (files.exists(join(root, 'yarn.lock'))) return 'yarn';
  if (files.exists(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function detectJs(root: string, override: RunnerManager | undefined, shellFamily: ShellFamily, files: DetectionFiles): DetectedGroup | null {
  const pkg = readJson(files, join(root, 'package.json'));
  if (!pkg) return null;
  const manager = override ?? detectJsManager(root, files);
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const runners: DetectedRunner[] = Object.keys(scripts).flatMap((name) => {
    const argument = safeShellArgument(name, shellFamily);
    return argument ? [{ id: `${manager}:${name}`, label: name, manager, command: `${manager} run ${argument}` }] : [];
  });
  return {
    manager,
    source: 'package.json',
    runners,
    installNeeded: !files.exists(join(root, 'node_modules')),
    installCommand: `${manager} install`,
  };
}

function detectPhp(root: string, source: string, shellFamily: ShellFamily, files: DetectionFiles): DetectedGroup | null {
  const composer = readJson(files, join(root, source));
  if (!composer) return null;
  const manifestDir = dirname(source).replace(/\\/g, '/');
  const cwd = manifestDir === '.' ? undefined : manifestDir;
  const scripts = (composer.scripts ?? {}) as Record<string, unknown>;
  const runners: DetectedRunner[] = Object.keys(scripts).flatMap((name) => {
    const argument = safeShellArgument(name, shellFamily);
    const id = cwd ? `composer:${cwd}:${name}` : `composer:${name}`;
    return argument ? [{ id, label: name, manager: 'composer' as const, command: `composer run ${argument}` }] : [];
  });
  return {
    manager: 'composer',
    source,
    cwd,
    runners,
    installNeeded: !files.exists(join(root, cwd ?? '', 'vendor')),
    installCommand: 'composer install',
  };
}

/**
 * Detect a Python project + its package manager. Auto: Poetry when a
 * `poetry.lock` or a `[tool.poetry]` pyproject is present, else pip. The
 * per-project override (pip/poetry) wins. `installNeeded` is best-effort —
 * a missing local virtualenv (.venv/venv/env) — since Poetry's env can live
 * elsewhere; the install button is idempotent. No script scan in v1.
 */
function detectPython(root: string, files: DetectionFiles, override?: RunnerManager): DetectedGroup | null {
  const hasRequirements = files.exists(join(root, 'requirements.txt'));
  const hasPyproject = files.exists(join(root, 'pyproject.toml'));
  const hasPoetryLock = files.exists(join(root, 'poetry.lock'));
  if (!hasRequirements && !hasPyproject && !hasPoetryLock) return null;

  let auto: RunnerManager = 'pip';
  if (hasPoetryLock) auto = 'poetry';
  else if (hasPyproject && /\[tool\.poetry\]/.test(files.text(join(root, 'pyproject.toml')) ?? '')) auto = 'poetry';
  const manager = override ?? auto;

  const source = hasPyproject ? 'pyproject.toml' : 'requirements.txt';
  // pip targets requirements.txt only when it exists; otherwise install the
  // pyproject project itself (PEP 621 / setuptools / hatch / pdm / flit) —
  // `pip install -r requirements.txt` would fail with "Could not open file".
  const installCommand =
    manager === 'poetry'
      ? 'poetry install'
      : hasRequirements
        ? 'pip install -r requirements.txt'
        : 'pip install .';
  const venvPresent = ['.venv', 'venv', 'env'].some((d) => files.exists(join(root, d)));
  return { manager, source, runners: [], installNeeded: !venvPresent, installCommand };
}

const MAVEN_GOALS = ['compile', 'test', 'package', 'spring-boot:run'];
const GRADLE_TASKS = ['build', 'test', 'bootRun', 'run'];

function wrapperBin(root: string, manager: 'maven' | 'gradle', shellFamily: ShellFamily, files: DetectionFiles): string {
  if (manager === 'maven') {
    if (shellFamily !== 'posix' && files.exists(join(root, 'mvnw.cmd'))) return '.\\mvnw.cmd';
    if (shellFamily === 'posix' && files.exists(join(root, 'mvnw'))) return './mvnw';
    return 'mvn';
  }
  if (shellFamily !== 'posix' && files.exists(join(root, 'gradlew.bat'))) return '.\\gradlew.bat';
  if (shellFamily === 'posix' && files.exists(join(root, 'gradlew'))) return './gradlew';
  return 'gradle';
}

function detectJava(root: string, override: RunnerManager | undefined, shellFamily: ShellFamily, files: DetectionFiles): DetectedGroup[] {
  const groups: DetectedGroup[] = [];
  if (files.exists(join(root, 'pom.xml'))) {
    const bin = wrapperBin(root, 'maven', shellFamily, files);
    groups.push({
      manager: 'maven',
      source: 'pom.xml',
      installNeeded: false,
      installCommand: `${bin} dependency:resolve`,
      updateCommand: `${bin} -U dependency:resolve`,
      runners: MAVEN_GOALS.map((goal) => ({
        id: `maven:${goal}`,
        label: goal,
        manager: 'maven' as const,
        command: `${bin} ${goal}`,
      })),
    });
  }
  const gradleBuild = ['build.gradle', 'build.gradle.kts'].find((f) => files.exists(join(root, f)));
  if (gradleBuild) {
    const bin = wrapperBin(root, 'gradle', shellFamily, files);
    groups.push({
      manager: 'gradle',
      source: gradleBuild,
      installNeeded: false,
      installCommand: `${bin} build -x test`,
      updateCommand: `${bin} build --refresh-dependencies -x test`,
      runners: GRADLE_TASKS.map((task) => ({
        id: `gradle:${task}`,
        label: task,
        manager: 'gradle' as const,
        command: `${bin} ${task}`,
      })),
    });
  }
  if (override === 'gradle') groups.sort((a, b) => Number(b.manager === 'gradle') - Number(a.manager === 'gradle'));
  if (override === 'maven') groups.sort((a, b) => Number(b.manager === 'maven') - Number(a.manager === 'maven'));
  return groups;
}

function dotnetGroup(found: DotnetProjectScan, shellFamily: ShellFamily): DetectedGroup | null {
  // Unity generates root-level project/solution files for IDE integration.
  // They are neither stable dependency manifests nor valid `dotnet run`
  // targets. Keep a zero-runner C# marker so project-open LSP detection still
  // starts/prompts OmniSharp without walking Library or offering bogus Play
  // configurations.
  if (found.unityRoot) {
    return {
      manager: 'dotnet',
      source: 'ProjectSettings/ProjectVersion.txt',
      installNeeded: false,
      runners: [],
    };
  }
  if (found.projects.length === 0 && found.solutions.length === 0) return null;
  const runners: DetectedRunner[] = [
    { id: 'dotnet:build', label: 'build', manager: 'dotnet', command: 'dotnet build' },
    { id: 'dotnet:test', label: 'test', manager: 'dotnet', command: 'dotnet test' },
  ];
  for (const project of found.projects) {
    const name = project.split('/').pop()?.replace(/\.csproj$/i, '') ?? project;
    const argument = safeShellArgument(project, shellFamily);
    if (!argument) continue;
    runners.push(
      { id: `dotnet:run:${project}`, label: `run ${name}`, manager: 'dotnet', command: `dotnet run --project ${argument}` },
      { id: `dotnet:watch:${project}`, label: `watch ${name}`, manager: 'dotnet', command: `dotnet watch --project ${argument} run` },
    );
  }
  return {
    manager: 'dotnet',
    source: found.projects.length === 1 ? found.projects[0] : '*.csproj / *.sln',
    installNeeded: false,
    installCommand: 'dotnet restore',
    updateCommand: 'dotnet restore --force',
    runners,
  };
}

function buildRunners(root: string, opts: DetectOptions | undefined, files: DetectionFiles,
  composer: readonly string[], dotnet: DotnetProjectScan): DetectedRunners {
  const groups: DetectedGroup[] = [];
  const shellFamily = opts?.shellFamily ?? defaultShellFamily();
  const js = detectJs(root, opts?.nodeManager, shellFamily, files);
  if (js) groups.push(js);
  for (const source of composer) {
    const php = detectPhp(root, source, shellFamily, files);
    if (php) groups.push(php);
  }
  const py = detectPython(root, files, opts?.pythonManager);
  if (py) groups.push(py);
  groups.push(...detectJava(root, opts?.javaManager, shellFamily, files));
  const group = dotnetGroup(dotnet, shellFamily);
  if (group) groups.push(group);
  return { groups };
}

/** Synchronous entrypoint for callers outside the IDE hot path. */
export function detectRunners(root: string, opts?: DetectOptions): DetectedRunners {
  return buildRunners(root, opts, { exists: existsSync, text: readText }, scanComposerProjects(root), scanDotnetProjects(root));
}

const rootProbes = [
  'node_modules', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'requirements.txt', 'poetry.lock',
  '.venv', 'venv', 'env', 'pom.xml', 'mvnw', 'mvnw.cmd', 'build.gradle', 'build.gradle.kts', 'gradlew', 'gradlew.bat',
];

async function loadDetectionFiles(root: string, composer: readonly string[], entries: Dirent[] | null): Promise<DetectionFiles> {
  const present = new Set<string>();
  const contents = new Map<string, string>();
  const listing = new Map(entries?.map(entry => [entry.name, entry]));
  const namesLower = new Set(entries?.map(entry => entry.name.toLowerCase()));
  const texts = new Set(composer.map(rel => join(root, rel)));
  for (const name of ['package.json', 'pyproject.toml']) {
    if (!entries || namesLower.has(name)) texts.add(join(root, name));
  }
  const probes = new Set([...texts, ...composer.map(source => join(root, dirname(source), 'vendor'))]);
  for (const name of rootProbes) {
    const entry = listing.get(name);
    const path = join(root, name);
    if (entry && !entry.isSymbolicLink()) present.add(path);
    else if (!entries || namesLower.has(name)) probes.add(path);
  }
  await mapLimit([...probes], 8, async path => {
    try {
      if (texts.has(path)) contents.set(path, await readFile(path, 'utf8'));
      else await access(path);
      present.add(path);
    } catch { /* an absent manifest, wrapper or install directory is normal */ }
  });
  return { exists: path => present.has(path), text: path => contents.get(path) ?? null };
}

const detections = new Map<string, Promise<DetectedRunners>>();
export function detectRunnersAsync(root: string, opts?: DetectOptions): Promise<DetectedRunners> {
  const version = getProjectDiscoveryCacheVersion(root);
  const key = JSON.stringify([resolve(root), version,
    opts?.nodeManager, opts?.pythonManager, opts?.javaManager, opts?.shellFamily]);
  const existing = detections.get(key);
  if (existing) return existing;
  const work = Promise.all([
    readProjectDirectory(resolve(root), resolve(root), version, true).catch(() => null),
    scanRunnerManifests(root),
  ]).then(async ([entries, { dotnet, composer }]) =>
    buildRunners(root, opts, await loadDetectionFiles(root, composer, entries), composer, dotnet)
  ).finally(() => detections.delete(key));
  detections.set(key, work);
  return work;
}
