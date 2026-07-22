import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { canonicalAbs } from '@mcp/shared/utils/fs-canonical.js';
import { resolveAngularLockfileVersion } from './angular-version-lockfiles.js';
import { angularFingerprint, exactAngularVersion, singleAngularMajor } from './angular-version-utils.js';

export type AngularVersionSource =
  | 'installed'
  | 'package-lock'
  | 'pnpm-lock'
  | 'yarn-lock'
  | 'package-json'
  | 'override'
  | 'unknown';

export type AngularVersionConfidence = 'high' | 'medium' | 'none';

export interface AngularVersionResolution {
  /** Exact version when known; otherwise an honest major label such as `12.x`. */
  version: string | null;
  major: number | null;
  source: AngularVersionSource;
  confidence: AngularVersionConfidence;
  declaredRange?: string;
  evidencePath?: string;
  fingerprint: string;
}

export interface ResolveAngularVersionInput {
  projectRoot: string;
  packageRoot: string;
  overrideVersion?: string;
}

interface PackageJsonInfo {
  path: string;
  raw: string;
  angularSpec?: string;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

function packageJsonInfo(packageRoot: string): PackageJsonInfo {
  const path = join(packageRoot, 'package.json');
  try {
    const raw = readFileSync(path, 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const groups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const group of groups) {
      const deps = pkg[group];
      if (!deps || typeof deps !== 'object') continue;
      const spec = (deps as Record<string, unknown>)['@angular/core'];
      if (typeof spec === 'string') return { path, raw, angularSpec: spec };
    }
    return { path, raw };
  } catch {
    return { path, raw: '' };
  }
}

function installedVersion(packageRoot: string, projectRoot: string): { version: string; path: string; raw: string } | null {
  if (!isWithin(projectRoot, packageRoot)) return null;
  let current = resolve(packageRoot);
  const boundary = resolve(projectRoot);
  while (true) {
    const path = join(current, 'node_modules', '@angular', 'core', 'package.json');
    try {
      const raw = readFileSync(path, 'utf8');
      const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
      const version = exactAngularVersion(pkg.version);
      if (version && (pkg.name === undefined || pkg.name === '@angular/core')) return { version, path, raw };
    } catch { /* keep walking for hoisted installs */ }
    if (current.toLowerCase() === boundary.toLowerCase()) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function exactResult(
  version: string,
  source: AngularVersionSource,
  evidencePath: string | undefined,
  evidence: string,
  declaredRange?: string,
): AngularVersionResolution {
  return {
    version,
    major: Number(version.split('.')[0]),
    source,
    confidence: 'high',
    declaredRange,
    evidencePath: evidencePath ? canonicalAbs(resolve(evidencePath)) : undefined,
    fingerprint: angularFingerprint([source, version, evidencePath, evidence, declaredRange]),
  };
}

export function resolveAngularVersion(input: ResolveAngularVersionInput): AngularVersionResolution {
  const projectRoot = resolve(input.projectRoot);
  const packageRoot = resolve(input.packageRoot);
  const declared = packageJsonInfo(packageRoot);

  const installed = installedVersion(packageRoot, projectRoot);
  if (installed) {
    return exactResult(installed.version, 'installed', installed.path, installed.raw, declared.angularSpec);
  }

  const locked = resolveAngularLockfileVersion(packageRoot, projectRoot, declared.angularSpec);
  if (locked) {
    return exactResult(locked.version, locked.source, locked.evidencePath, locked.evidence, declared.angularSpec);
  }

  const declaredMajor = singleAngularMajor(declared.angularSpec);
  if (declaredMajor != null) {
    return {
      version: `${declaredMajor}.x`,
      major: declaredMajor,
      source: 'package-json',
      confidence: 'medium',
      declaredRange: declared.angularSpec,
      evidencePath: canonicalAbs(resolve(declared.path)),
      fingerprint: angularFingerprint(['package-json', declaredMajor, declared.raw]),
    };
  }

  const overrideExact = exactAngularVersion(input.overrideVersion);
  const overrideMajor = singleAngularMajor(input.overrideVersion);
  if (overrideExact || overrideMajor != null) {
    const version = overrideExact ?? `${overrideMajor}.x`;
    const major = overrideExact ? Number(overrideExact.split('.')[0]) : overrideMajor!;
    return {
      version,
      major,
      source: 'override',
      confidence: overrideExact ? 'high' : 'medium',
      declaredRange: declared.angularSpec,
      fingerprint: angularFingerprint(['override', version, declared.raw]),
    };
  }

  return {
    version: null,
    major: null,
    source: 'unknown',
    confidence: 'none',
    declaredRange: declared.angularSpec,
    evidencePath: declared.raw ? canonicalAbs(resolve(declared.path)) : undefined,
    fingerprint: angularFingerprint(['unknown', declared.raw]),
  };
}

