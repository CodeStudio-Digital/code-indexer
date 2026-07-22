import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { exactAngularVersion, singleAngularMajor } from './angular-version-utils.js';

export type AngularLockfileSource = 'package-lock' | 'pnpm-lock' | 'yarn-lock';

export interface AngularLockfileVersion {
  version: string;
  source: AngularLockfileSource;
  evidencePath: string;
  evidence: string;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
}

function ancestorDirectories(start: string, stop: string): string[] {
  if (!isWithin(stop, start)) return [];
  const out: string[] = [];
  let current = resolve(start);
  const boundary = resolve(stop);
  while (true) {
    out.push(current);
    if (current.toLowerCase() === boundary.toLowerCase()) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function read(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function packageLockVersion(raw: string, lockDir: string, packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      packages?: Record<string, { version?: unknown }>;
      dependencies?: Record<string, { version?: unknown }>;
    };
    const relPackage = relative(lockDir, packageRoot).replace(/\\/g, '/');
    const keys = [
      ...(relPackage && relPackage !== '.' ? [`${relPackage}/node_modules/@angular/core`] : []),
      'node_modules/@angular/core',
    ];
    for (const key of keys) {
      const version = exactAngularVersion(parsed.packages?.[key]?.version);
      if (version) return version;
    }
    return exactAngularVersion(parsed.dependencies?.['@angular/core']?.version);
  } catch {
    return null;
  }
}

function yamlKey(raw: string): string {
  const value = raw.trim().replace(/:$/, '').trim();
  return value.replace(/^['"]|['"]$/g, '');
}

function yamlScalar(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, '');
}

function pnpmImporterVersion(raw: string, lockDir: string, packageRoot: string): string | null {
  const lines = raw.split(/\r?\n/);
  const importerKey = relative(lockDir, packageRoot).replace(/\\/g, '/') || '.';
  const importersAt = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (importersAt < 0) return null;

  let importerStart = -1;
  let importerIndent = -1;
  for (let i = importersAt + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\S/.test(line)) break;
    const match = /^(\s+)([^#].*):\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    if (indent !== 2 || yamlKey(match[2]!) !== importerKey) continue;
    importerStart = i;
    importerIndent = indent;
    break;
  }
  if (importerStart < 0) return null;

  for (let i = importerStart + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (line.trim() && indent <= importerIndent) break;
    const dependency = /^(\s*)['"]?@angular\/core['"]?:\s*(.*)$/.exec(line);
    if (!dependency) continue;
    const inline = exactAngularVersion(yamlScalar(dependency[2]!));
    if (inline) return inline;
    const dependencyIndent = dependency[1]!.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const nested = lines[j]!;
      const nestedIndent = /^\s*/.exec(nested)?.[0].length ?? 0;
      if (nested.trim() && nestedIndent <= dependencyIndent) break;
      const version = /^\s*version:\s*(.+?)\s*$/.exec(nested);
      const exact = exactAngularVersion(version ? yamlScalar(version[1]!) : null);
      if (exact) return exact;
    }
  }
  return null;
}

function yarnVersion(raw: string, declaredSpec?: string): string | null {
  const lines = raw.split(/\r?\n/);
  const candidates: Array<{ header: string; version: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s/.test(line) || !line.includes('@angular/core@') || !line.trimEnd().endsWith(':')) continue;
    const header = line.trim().replace(/:$/, '').replace(/^['"]|['"]$/g, '');
    for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]!) || !lines[j]!.trim()); j += 1) {
      const match = /^\s*version(?::|\s)\s*['"]?([^'"\s]+)['"]?/.exec(lines[j]!);
      const version = exactAngularVersion(match?.[1]);
      if (version) { candidates.push({ header, version }); break; }
    }
  }
  if (declaredSpec) {
    const exactHeader = candidates.find((candidate) => candidate.header.includes(`@angular/core@${declaredSpec}`));
    if (exactHeader) return exactHeader.version;
  }
  const major = singleAngularMajor(declaredSpec);
  const matching = major == null
    ? candidates
    : candidates.filter((candidate) => Number(candidate.version.split('.')[0]) === major);
  const versions = [...new Set(matching.map((candidate) => candidate.version))];
  return versions.length === 1 ? versions[0]! : null;
}

/** Resolve the closest applicable lockfile without executing package-manager code. */
export function resolveAngularLockfileVersion(
  packageRoot: string,
  projectRoot: string,
  declaredSpec?: string,
): AngularLockfileVersion | null {
  for (const dir of ancestorDirectories(packageRoot, projectRoot)) {
    const candidates: Array<[AngularLockfileSource, string]> = [
      ['package-lock', join(dir, 'package-lock.json')],
      ['pnpm-lock', join(dir, 'pnpm-lock.yaml')],
      ['yarn-lock', join(dir, 'yarn.lock')],
    ];
    for (const [source, path] of candidates) {
      if (!existsSync(path)) continue;
      const raw = read(path);
      if (raw == null) continue;
      const version = source === 'package-lock'
        ? packageLockVersion(raw, dir, packageRoot)
        : source === 'pnpm-lock'
          ? pnpmImporterVersion(raw, dir, packageRoot)
          : yarnVersion(raw, declaredSpec);
      if (version) return { version, source, evidencePath: path, evidence: raw };
    }
  }
  return null;
}

