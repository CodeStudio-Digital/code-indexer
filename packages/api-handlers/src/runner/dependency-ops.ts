import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ApiError, type AddDependencyResult, type RuntimeTarget } from '@mcp/api-bus';
import type { RuntimeEnv } from '../runtime/runtime-resolve.js';
import { toWslMntPath } from '../runtime/wsl-paths.js';
import { posixExportPrefix } from '../terminal/pty-manager.js';
import { shSingleQuote } from '../terminal/shell-quote.js';
import { addGradleDependency, addMavenDependency } from './dependency-editors.js';
import { scanDotnetProjects } from './dotnet-project-files.js';

const execFileAsync = promisify(execFile);
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,100}$/;

function relativeManifest(root: string, absolute: string): string {
  return relative(root, absolute).replace(/\\/g, '/');
}

function confined(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ApiError('invalid_input', 400, 'project file escapes the project root');
  return absolute;
}

function validate(manager: 'maven' | 'gradle' | 'dotnet', packageId: string, version: string): void {
  const idPattern = manager === 'dotnet' ? /^[A-Za-z0-9_.-]+$/ : /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;
  if (!idPattern.test(packageId)) throw new ApiError('invalid_input', 400, `invalid ${manager} package id`);
  if (!VERSION.test(version)) throw new ApiError('invalid_input', 400, 'invalid package version');
}

async function addNuget(
  root: string,
  packageId: string,
  version: string,
  projectFile: string | undefined,
  target: RuntimeTarget,
  env: RuntimeEnv,
): Promise<AddDependencyResult> {
  const candidates = scanDotnetProjects(root).projects.map((file) => join(root, ...file.split('/')));
  const manifest = projectFile ? confined(root, projectFile) : candidates.length === 1 ? candidates[0] : null;
  if (!manifest || !existsSync(manifest) || !manifest.toLowerCase().endsWith('.csproj')) {
    throw new ApiError('conflict', 409, candidates.length > 1
      ? 'multiple .csproj files found; choose an exact project file'
      : 'no .csproj file found');
  }
  const args = ['add', manifest, 'package', packageId, '--version', version];
  if (target.kind === 'wsl') {
    const wslManifest = toWslMntPath(manifest);
    const script = `${posixExportPrefix(env.posixPathPrepend, env.posixExtraEnv)}dotnet add ${shSingleQuote(wslManifest)} package ${shSingleQuote(packageId)} --version ${shSingleQuote(version)}`;
    await execFileAsync('wsl.exe', ['-d', target.distro, '--', 'bash', '-lc', script], {
      timeout: 120_000,
      maxBuffer: 1 << 22,
      windowsHide: true,
    });
  } else {
    const PATH = [...env.pathPrepend, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
    await execFileAsync('dotnet', args, {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 1 << 22,
      windowsHide: true,
      env: { ...process.env, ...env.extraEnv, PATH },
    });
  }
  return { changed: true, manifest: relativeManifest(root, manifest) };
}

export async function addDependency(opts: {
  root: string;
  manager: 'maven' | 'gradle' | 'dotnet';
  packageId: string;
  version: string;
  projectFile?: string;
  target: RuntimeTarget;
  env: RuntimeEnv;
}): Promise<AddDependencyResult> {
  validate(opts.manager, opts.packageId, opts.version);
  if (opts.manager === 'dotnet') {
    return addNuget(opts.root, opts.packageId, opts.version, opts.projectFile, opts.target, opts.env);
  }
  const file = opts.manager === 'maven'
    ? join(opts.root, 'pom.xml')
    : ['build.gradle', 'build.gradle.kts'].map((name) => join(opts.root, name)).find(existsSync);
  if (!file || !existsSync(file)) throw new ApiError('not_found', 404, `no ${opts.manager} manifest found`);
  const before = readFileSync(file, 'utf8');
  const edit = opts.manager === 'maven'
    ? addMavenDependency(before, opts.packageId, opts.version)
    : addGradleDependency(before, opts.packageId, opts.version, file.endsWith('.kts'));
  if (edit.changed) writeFileSync(file, edit.text, 'utf8');
  return { changed: edit.changed, manifest: relativeManifest(opts.root, file), message: edit.changed ? undefined : 'dependency already present' };
}
