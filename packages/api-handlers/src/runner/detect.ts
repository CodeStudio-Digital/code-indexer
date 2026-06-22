/**
 * Runner detection — scans a project's root directory for runnable
 * commands across ecosystems (JS/TS, PHP, Java, .NET). Pure filesystem
 * reads (node:fs), no spawning. Returns groups keyed by package manager
 * with an install hint each.
 *
 * Detection is intentionally shallow (root + recognised manifest files);
 * Java/.NET goals are a curated common set since those tools don't expose
 * a cheap machine-readable task list without invoking the build.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DetectedGroup,
  DetectedRunner,
  DetectedRunners,
  RunnerManager,
} from '@mcp/api-bus';

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
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
}

/** Pick the JS package manager from the lockfile present at the root. */
function detectJsManager(root: string): RunnerManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function detectJs(root: string, override?: RunnerManager): DetectedGroup | null {
  const pkg = readJson(join(root, 'package.json'));
  if (!pkg) return null;
  const manager = override ?? detectJsManager(root);
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const runners: DetectedRunner[] = Object.keys(scripts).map((name) => ({
    id: `${manager}:${name}`,
    label: name,
    manager,
    command: `${manager} run ${name}`,
  }));
  return {
    manager,
    source: 'package.json',
    runners,
    installNeeded: !existsSync(join(root, 'node_modules')),
    installCommand: `${manager} install`,
  };
}

function detectPhp(root: string): DetectedGroup | null {
  const composer = readJson(join(root, 'composer.json'));
  if (!composer) return null;
  const scripts = (composer.scripts ?? {}) as Record<string, unknown>;
  const runners: DetectedRunner[] = Object.keys(scripts).map((name) => ({
    id: `composer:${name}`,
    label: name,
    manager: 'composer' as const,
    command: `composer run ${name}`,
  }));
  return {
    manager: 'composer',
    source: 'composer.json',
    runners,
    installNeeded: !existsSync(join(root, 'vendor')),
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
function detectPython(root: string, override?: RunnerManager): DetectedGroup | null {
  const hasRequirements = existsSync(join(root, 'requirements.txt'));
  const hasPyproject = existsSync(join(root, 'pyproject.toml'));
  const hasPoetryLock = existsSync(join(root, 'poetry.lock'));
  if (!hasRequirements && !hasPyproject && !hasPoetryLock) return null;

  let auto: RunnerManager = 'pip';
  if (hasPoetryLock) auto = 'poetry';
  else if (hasPyproject && /\[tool\.poetry\]/.test(readText(join(root, 'pyproject.toml')) ?? '')) auto = 'poetry';
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
  const venvPresent = ['.venv', 'venv', 'env'].some((d) => existsSync(join(root, d)));
  return { manager, source, runners: [], installNeeded: !venvPresent, installCommand };
}

const MAVEN_GOALS = ['compile', 'test', 'package', 'spring-boot:run'];
const GRADLE_TASKS = ['build', 'test', 'bootRun', 'run'];

function detectJava(root: string): DetectedGroup[] {
  const groups: DetectedGroup[] = [];
  if (existsSync(join(root, 'pom.xml'))) {
    const hasWrapper = existsSync(join(root, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'));
    const bin = hasWrapper ? (process.platform === 'win32' ? 'mvnw.cmd' : './mvnw') : 'mvn';
    groups.push({
      manager: 'maven',
      source: 'pom.xml',
      installNeeded: false,
      runners: MAVEN_GOALS.map((goal) => ({
        id: `maven:${goal}`,
        label: goal,
        manager: 'maven' as const,
        command: `${bin} ${goal}`,
      })),
    });
  }
  const gradleBuild = ['build.gradle', 'build.gradle.kts'].find((f) => existsSync(join(root, f)));
  if (gradleBuild) {
    const hasWrapper = existsSync(join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'));
    const bin = hasWrapper ? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew') : 'gradle';
    groups.push({
      manager: 'gradle',
      source: gradleBuild,
      installNeeded: false,
      runners: GRADLE_TASKS.map((task) => ({
        id: `gradle:${task}`,
        label: task,
        manager: 'gradle' as const,
        command: `${bin} ${task}`,
      })),
    });
  }
  return groups;
}

const DOTNET_VERBS = ['build', 'run', 'test', 'watch'];

/** True when a `*.csproj` / `*.sln` exists at root or one level deep. */
function hasDotnetProject(root: string): boolean {
  const matches = (name: string) => /\.(csproj|sln)$/i.test(name);
  try {
    const top = readdirSync(root, { withFileTypes: true });
    for (const e of top) {
      if (e.isFile() && matches(e.name)) return true;
    }
    for (const e of top) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      try {
        if (readdirSync(join(root, e.name)).some(matches)) return true;
      } catch {
        /* unreadable subdir — skip */
      }
    }
  } catch {
    /* unreadable root — no detection */
  }
  return false;
}

function detectDotnet(root: string): DetectedGroup | null {
  if (!hasDotnetProject(root)) return null;
  return {
    manager: 'dotnet',
    source: '*.csproj / *.sln',
    installNeeded: false,
    runners: DOTNET_VERBS.map((verb) => ({
      id: `dotnet:${verb}`,
      label: verb,
      manager: 'dotnet' as const,
      command: `dotnet ${verb}`,
    })),
  };
}

/** Detect all runnable commands for a project root. */
export function detectRunners(root: string, opts?: DetectOptions): DetectedRunners {
  const groups: DetectedGroup[] = [];
  const js = detectJs(root, opts?.nodeManager);
  if (js) groups.push(js);
  const php = detectPhp(root);
  if (php) groups.push(php);
  const py = detectPython(root, opts?.pythonManager);
  if (py) groups.push(py);
  groups.push(...detectJava(root));
  const dotnet = detectDotnet(root);
  if (dotnet) groups.push(dotnet);
  return { groups };
}
