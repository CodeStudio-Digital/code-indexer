import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TREE_BLOCK } from '@mcp/shared/utils/fs-ignore.js';
import { angularFingerprint } from './angular-version-utils.js';

const BLOCKED_DIRECTORIES = new Set([
  ...[...TREE_BLOCK].map((name) => name.toLowerCase()),
  '.angular', '.nx', '.pnpm-store', '.yarn', 'bower_components', 'coverage', 'out', 'temp', 'tmp', 'vendor',
]);

export interface AngularWorkspaceDraft {
  name?: string;
  workspaceRoot: string;
  packageRoot: string;
  sourceRoots: string[];
  metadataFingerprint: string;
}

export interface AngularWorkspaceDiscovery {
  drafts: AngularWorkspaceDraft[];
  scannedDirectories: number;
}

interface ScanResult {
  angularJson: Array<{ path: string; raw: string }>;
  projectJson: Array<{ path: string; raw: string }>;
  nxRoots: string[];
  angularPackages: Map<string, { raw: string; declaredRange: string }>;
  scannedDirectories: number;
}

function native(path: string): string { return resolve(path); }

function isWithin(parent: string, child: string): boolean {
  const rel = relative(native(parent), native(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function read(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch { return null; }
}

function angularDependency(pkg: Record<string, unknown>): string | null {
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[group];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const spec = (deps as Record<string, unknown>)['@angular/core'];
    if (typeof spec === 'string') return spec;
  }
  return null;
}

function scanProject(root: string, maxDepth: number, maxDirectories: number): ScanResult {
  const result: ScanResult = {
    angularJson: [], projectJson: [], nxRoots: [], angularPackages: new Map(), scannedDirectories: 0,
  };
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  for (let cursor = 0; cursor < pending.length && result.scannedDirectories < maxDirectories; cursor += 1) {
    const current = pending[cursor]!;
    result.scannedDirectories += 1;
    let entries;
    try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(current.dir, entry.name);
      if (entry.name === 'angular.json' || entry.name === 'project.json') {
        const raw = read(path);
        if (raw != null) (entry.name === 'angular.json' ? result.angularJson : result.projectJson).push({ path, raw });
      } else if (entry.name === 'nx.json') {
        result.nxRoots.push(current.dir);
      } else if (entry.name === 'package.json') {
        const raw = read(path);
        const parsed = raw == null ? null : parseObject(raw);
        const declaredRange = parsed ? angularDependency(parsed) : null;
        if (raw != null && declaredRange) result.angularPackages.set(native(current.dir), { raw, declaredRange });
      }
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || BLOCKED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (pending.length >= maxDirectories) break;
      pending.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return result;
}

function safePath(base: string, value: unknown, projectRoot: string): string | null {
  if (typeof value !== 'string' || isAbsolute(value)) return null;
  const path = native(join(base, value || '.'));
  return isWithin(projectRoot, path) ? path : null;
}

function nearestAngularPackage(start: string, projectRoot: string, packages: ScanResult['angularPackages']): string | null {
  let current = native(start);
  const boundary = native(projectRoot);
  if (!isWithin(boundary, current)) return null;
  while (true) {
    if (packages.has(current)) return current;
    if (current.toLowerCase() === boundary.toLowerCase()) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sourceRootOrDefault(candidate: string | null, projectDir: string): string {
  if (candidate) return candidate;
  const src = join(projectDir, 'src');
  return existsSync(src) ? src : projectDir;
}

function cliDrafts(item: ScanResult['angularJson'][number], projectRoot: string, scan: ScanResult): AngularWorkspaceDraft[] {
  const parsed = parseObject(item.raw);
  if (!parsed) return [];
  const workspaceRoot = dirname(item.path);
  const projects = parsed.projects;
  const drafts: AngularWorkspaceDraft[] = [];
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [name, rawProject] of Object.entries(projects as Record<string, unknown>)) {
      if (!rawProject || typeof rawProject !== 'object' || Array.isArray(rawProject)) continue;
      const project = rawProject as Record<string, unknown>;
      const projectDir = safePath(workspaceRoot, project.root ?? '', projectRoot);
      if (!projectDir) continue;
      const sourceRoot = sourceRootOrDefault(safePath(workspaceRoot, project.sourceRoot, projectRoot), projectDir);
      const packageRoot = nearestAngularPackage(projectDir, projectRoot, scan.angularPackages)
        ?? nearestAngularPackage(workspaceRoot, projectRoot, scan.angularPackages);
      if (!packageRoot) continue;
      drafts.push({
        name, workspaceRoot, packageRoot, sourceRoots: [sourceRoot],
        metadataFingerprint: angularFingerprint(['angular.json', item.path, item.raw, name]),
      });
    }
  }
  if (drafts.length > 0) return drafts;
  const packageRoot = nearestAngularPackage(workspaceRoot, projectRoot, scan.angularPackages);
  return packageRoot ? [{
    workspaceRoot, packageRoot, sourceRoots: [sourceRootOrDefault(null, workspaceRoot)],
    metadataFingerprint: angularFingerprint(['angular.json', item.path, item.raw]),
  }] : [];
}

function nxDraft(item: ScanResult['projectJson'][number], projectRoot: string, scan: ScanResult): AngularWorkspaceDraft | null {
  const parsed = parseObject(item.raw);
  const targets = parsed?.targets ?? parsed?.architect;
  if (!parsed || !targets || typeof targets !== 'object'
    || !/(?:@nx\/angular|@nrwl\/angular|@angular-devkit\/build-angular)/.test(JSON.stringify(targets))) return null;
  const configDir = dirname(item.path);
  const workspaceRoot = scan.nxRoots.filter((root) => isWithin(root, configDir)).sort((a, b) => b.length - a.length)[0]
    ?? projectRoot;
  const projectDir = safePath(workspaceRoot, parsed.root, projectRoot) ?? configDir;
  const sourceRoot = sourceRootOrDefault(safePath(workspaceRoot, parsed.sourceRoot, projectRoot), projectDir);
  const packageRoot = nearestAngularPackage(projectDir, projectRoot, scan.angularPackages)
    ?? nearestAngularPackage(workspaceRoot, projectRoot, scan.angularPackages);
  return packageRoot ? {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    workspaceRoot, packageRoot, sourceRoots: [sourceRoot],
    metadataFingerprint: angularFingerprint(['project.json', item.path, item.raw]),
  } : null;
}

export function discoverAngularWorkspaces(
  projectRoot: string,
  maxDepth: number,
  maxDirectories: number,
): AngularWorkspaceDiscovery {
  const root = native(projectRoot);
  const scan = scanProject(root, maxDepth, maxDirectories);
  const drafts = [
    ...scan.angularJson.flatMap((item) => cliDrafts(item, root, scan)),
    ...scan.projectJson.map((item) => nxDraft(item, root, scan)).filter((draft): draft is AngularWorkspaceDraft => !!draft),
  ];
  for (const packageRoot of scan.angularPackages.keys()) {
    if (drafts.some((draft) => draft.packageRoot.toLowerCase() === packageRoot.toLowerCase())) continue;
    drafts.push({
      workspaceRoot: packageRoot,
      packageRoot,
      sourceRoots: [sourceRootOrDefault(null, packageRoot)],
      metadataFingerprint: angularFingerprint(['package-json', packageRoot, scan.angularPackages.get(packageRoot)!.raw]),
    });
  }
  return { drafts, scannedDirectories: scan.scannedDirectories };
}

