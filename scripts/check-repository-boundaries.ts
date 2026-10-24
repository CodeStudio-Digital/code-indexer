#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MANIFEST_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export interface RepositoryDomain {
  name: string;
  roots: string[];
}

export interface RepositoryBoundaryConfig {
  schemaVersion: number;
  domains: RepositoryDomain[];
  allowedCrossDomainPackages: Record<string, string[]>;
  /** Narrow producer-owned APIs for packages that also contain implementation. */
  allowedCrossDomainImports?: Record<string, string[]>;
  /** Contract packages built together in this monorepo, not independently published. */
  allowedWorkspacePackages?: Record<string, string[]>;
  /** Explicit application composition APIs, only callable within their domain. */
  unitEntrypoints?: string[];
  /** Modules supplied by a runtime rather than the package registry. */
  runtimeModules?: Record<string, string[]>;
  publicationPackages: string[];
  forbiddenTrackedPatterns: string[];
}

export interface BoundaryIssue {
  kind: string;
  file: string;
  unit?: string;
  specifier?: string;
  detail?: string;
}

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface ManifestRecord {
  path: string;
  root: string;
  value: PackageManifest;
}

export interface BoundaryAnalysis {
  issues: BoundaryIssue[];
  keys: string[];
  trackedFiles: string[];
}

export interface BoundaryComparison {
  additions: string[];
  removals: string[];
}

const toRepoPath = (value: string): string => value.split(sep).join('/').replace(/^\.\//, '');

const packageName = (specifier: string): string => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const scriptKind = (path: string): ts.ScriptKind => {
  const extension = extname(path);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

export const extractModuleSpecifiers = (source: string, filePath: string): string[] => {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const specifiers = new Set<string>();
  const add = (node: ts.Expression | undefined): void => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.add(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node.arguments[0]);
      if (
        ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'require'
        && node.expression.name.text === 'resolve'
      ) add(node.arguments[0]);
      if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'resolve'
        && ts.isMetaProperty(node.expression.expression)
        && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
      ) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers].sort();
};

const unitForPath = (path: string): string => {
  const parts = toRepoPath(path).split('/');
  if (['apps', 'packages', 'services', 'extensions', 'docker'].includes(parts[0]) && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts[0] === 'native' && parts[1]) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === 'worker-market') return 'worker-market';
  if (['src', 'scripts', 'benchmarks', 'evals'].includes(parts[0])) return '.';
  return parts[0] || '.';
};

const requiresOwnManifest = (unit: string): boolean => {
  const prefix = unit.split('/')[0];
  return ['apps', 'extensions', 'packages', 'services'].includes(prefix) || unit === 'worker-market';
};

const domainForPath = (path: string, config: RepositoryBoundaryConfig): string | null => {
  const normalized = toRepoPath(path);
  let match: { name: string; length: number } | null = null;
  for (const domain of config.domains) {
    for (const root of domain.roots) {
      const normalizedRoot = toRepoPath(root).replace(/\/$/, '');
      if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)) {
        if (!match || normalizedRoot.length > match.length) match = { name: domain.name, length: normalizedRoot.length };
      }
    }
  }
  return match?.name ?? null;
};

const readManifest = (root: string, path: string): PackageManifest =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifest;

const manifestDependencies = (manifest: PackageManifest): Map<string, string> => {
  const dependencies = new Map<string, string>();
  for (const section of MANIFEST_SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) dependencies.set(name, version);
  }
  return dependencies;
};

const gitWorkingTreeFiles = (root: string): string[] => {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'buffer',
  });
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map(toRepoPath)
    // The index still lists unstaged deletions. Analyze existing sources,
    // including new files, without requiring staging before this check.
    .filter((file) => statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile())
    .sort();
};

const fallbackFiles = (root: string): string[] => {
  const output: string[] = [];
  const excluded = new Set(['.git', 'node_modules', 'dist', 'target']);
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) output.push(toRepoPath(relative(root, child)));
    }
  };
  walk(root);
  return output.sort();
};

const repositoryFiles = (root: string): string[] => {
  try {
    return gitWorkingTreeFiles(root);
  } catch {
    return fallbackFiles(root);
  }
};

const isGeneratedShadow = (path: string, tracked: Set<string>): boolean => {
  if (!['.js', '.jsx', '.mjs', '.cjs'].includes(extname(path))) return false;
  const base = path.slice(0, -extname(path).length);
  return ['.ts', '.tsx', '.mts', '.cts'].some((extension) => tracked.has(`${base}${extension}`));
};

const exportTargets = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
};

const addIssue = (issues: BoundaryIssue[], issue: BoundaryIssue): void => {
  issues.push(issue);
};

export const issueKey = (issue: BoundaryIssue): string => [
  issue.kind,
  issue.file,
  issue.unit ?? '',
  issue.specifier ?? '',
  issue.detail ?? '',
].join('::');

export const analyzeRepository = (
  root: string,
  config: RepositoryBoundaryConfig,
  providedFiles?: string[],
): BoundaryAnalysis => {
  const trackedFiles = (providedFiles ?? repositoryFiles(root)).map(toRepoPath).sort();
  const tracked = new Set(trackedFiles);
  const manifests = trackedFiles
    .filter((path) => path === 'package.json' || path.endsWith('/package.json'))
    .map((path): ManifestRecord => ({
      path,
      root: path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length),
      value: readManifest(root, path),
    }));
  const rootManifest = manifests.find((manifest) => manifest.root === '.');
  if (!rootManifest) throw new Error('Root package.json is required');
  const manifestByRoot = new Map(manifests.map((manifest) => [manifest.root, manifest]));
  const manifestByName = new Map(
    manifests.filter((manifest) => manifest.value.name).map((manifest) => [manifest.value.name!, manifest]),
  );
  const issues: BoundaryIssue[] = [];
  const missingManifestUnits = new Set<string>();

  for (const path of trackedFiles) {
    for (const pattern of config.forbiddenTrackedPatterns) {
      if (minimatch(path, pattern, { dot: true })) {
        addIssue(issues, { kind: 'forbidden-tracked-artifact', file: path, detail: pattern });
      }
    }
  }

  for (const name of config.publicationPackages) {
    const manifest = manifestByName.get(name);
    if (!manifest) {
      addIssue(issues, { kind: 'publication-package-missing', file: 'package.json', detail: name });
      continue;
    }
    if (manifest.value.private === true) {
      addIssue(issues, { kind: 'publication-package-private', file: manifest.path, detail: name });
    }
    if (!manifest.value.version || manifest.value.version === '0.0.0') {
      addIssue(issues, { kind: 'publication-package-version', file: manifest.path, detail: name });
    }
    const targets = exportTargets(manifest.value.exports);
    if (targets.some((target) => /(^|\/)src\//.test(target.replace(/^\.\//, '')))) {
      addIssue(issues, { kind: 'publication-source-export', file: manifest.path, detail: name });
    }
    if (
      manifest.value.exports
      && typeof manifest.value.exports === 'object'
      && Object.keys(manifest.value.exports).some((key) => key.includes('*'))
    ) {
      addIssue(issues, { kind: 'publication-wildcard-export', file: manifest.path, detail: name });
    }
  }

  const sourceFiles = trackedFiles.filter((path) => {
    if (!SOURCE_EXTENSIONS.has(extname(path)) || path.endsWith('.d.ts')) return false;
    if (isGeneratedShadow(path, tracked)) return false;
    return domainForPath(path, config) !== null;
  });

  for (const file of sourceFiles) {
    const sourceDomain = domainForPath(file, config);
    if (!sourceDomain) continue;
    const sourceUnit = unitForPath(file);
    const localManifest = manifestByRoot.get(sourceUnit);
    if (!localManifest && sourceUnit !== '.' && !missingManifestUnits.has(sourceUnit)) {
      missingManifestUnits.add(sourceUnit);
      addIssue(issues, { kind: 'missing-unit-manifest', file: sourceUnit, unit: sourceUnit, detail: sourceDomain });
    }
    const ownerManifest = localManifest ?? rootManifest;
    const declared = manifestDependencies(ownerManifest.value);
    const source = readFileSync(resolve(root, file), 'utf8');

    for (const specifier of extractModuleSpecifiers(source, file)) {
      if (BUILTINS.has(specifier) || specifier.startsWith('node:')) continue;
      if (config.runtimeModules?.[file]?.includes(specifier)) continue;
      if (specifier.startsWith('.')) {
        const absoluteTarget = resolve(root, dirname(file), specifier);
        const target = toRepoPath(relative(root, absoluteTarget));
        if (target === '..' || target.startsWith('../')) {
          addIssue(issues, { kind: 'relative-import-outside-repository', file, unit: sourceUnit, specifier });
          continue;
        }
        const targetDomain = domainForPath(target, config);
        const targetUnit = unitForPath(target);
        if (targetDomain && targetDomain !== sourceDomain) {
          addIssue(issues, {
            kind: 'cross-domain-relative-import',
            file,
            unit: sourceUnit,
            specifier,
            detail: `${sourceDomain}->${targetDomain}`,
          });
        }
        const publicEntrypoint = targetDomain === sourceDomain && config.unitEntrypoints?.includes(target);
        if (targetDomain && targetUnit !== sourceUnit && !publicEntrypoint) {
          addIssue(issues, {
            kind: 'cross-unit-relative-import',
            file,
            unit: sourceUnit,
            specifier,
            detail: `${sourceUnit}->${targetUnit}`,
          });
        }
        continue;
      }
      if (isAbsolute(specifier)) {
        addIssue(issues, { kind: 'absolute-source-import', file, unit: sourceUnit, specifier });
        continue;
      }
      if (specifier.startsWith('@apps/')) {
        const targetPath = `apps/${specifier.slice('@apps/'.length)}`;
        const targetDomain = domainForPath(targetPath, config);
        addIssue(issues, {
          kind: 'source-alias-import',
          file,
          unit: sourceUnit,
          specifier,
          detail: targetDomain ? `${sourceDomain}->${targetDomain}` : sourceDomain,
        });
        continue;
      }

      const dependencyName = packageName(specifier);
      const targetManifest = manifestByName.get(dependencyName);
      if (!targetManifest) {
        if (!declared.has(dependencyName)) {
          addIssue(issues, {
            kind: dependencyName.startsWith('@mcp/') || dependencyName.startsWith('@cloudstudio/')
              ? 'unresolved-internal-package'
              : 'undeclared-external-dependency',
            file,
            unit: sourceUnit,
            specifier: dependencyName,
          });
        }
        continue;
      }

      const targetDomain = domainForPath(targetManifest.root, config);
      if (targetManifest.root !== sourceUnit && !declared.has(dependencyName)) {
        addIssue(issues, {
          kind: 'undeclared-internal-dependency',
          file,
          unit: sourceUnit,
          specifier: dependencyName,
        });
      }
      if (targetDomain && targetDomain !== sourceDomain) {
        const allowed = new Set(config.allowedCrossDomainPackages[sourceDomain] ?? []);
        const allowedImport = allowed.has(dependencyName)
          || config.allowedCrossDomainImports?.[sourceDomain]?.includes(specifier);
        if (!allowedImport) {
          addIssue(issues, {
            kind: 'forbidden-domain-import',
            file,
            unit: sourceUnit,
            specifier: dependencyName,
            detail: `${sourceDomain}->${targetDomain}`,
          });
        }
        const declaredVersion = declared.get(dependencyName);
        // A shared root manifest does not make every source directory an
        // independently versioned workspace. The import rule above still applies.
        const ownsManifest = localManifest && sourceUnit !== '.';
        const allowedWorkspace = config.allowedWorkspacePackages?.[sourceDomain]?.includes(dependencyName);
        if (ownsManifest && !allowedWorkspace && declaredVersion?.startsWith('workspace:')) {
          addIssue(issues, {
            kind: 'cross-domain-workspace-dependency',
            file: ownerManifest.path,
            unit: sourceUnit,
            specifier: dependencyName,
            detail: `${sourceDomain}->${targetDomain}`,
          });
        }
      }
    }
  }

  const deduplicated = new Map(issues.map((issue) => [issueKey(issue), issue]));
  const sortedIssues = [...deduplicated.values()].sort((left, right) => issueKey(left).localeCompare(issueKey(right)));
  return { issues: sortedIssues, keys: sortedIssues.map(issueKey), trackedFiles };
};

export const compareBoundaryBaseline = (current: string[], baseline: string[]): BoundaryComparison => {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  return {
    additions: current.filter((key) => !baselineSet.has(key)),
    removals: baseline.filter((key) => !currentSet.has(key)),
  };
};

const loadConfig = (path: string): RepositoryBoundaryConfig =>
  JSON.parse(readFileSync(path, 'utf8')) as RepositoryBoundaryConfig;

const groupedCounts = (issues: BoundaryIssue[]): string => {
  const counts = new Map<string, number>();
  for (const issue of issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(', ');
};

const argumentValue = (name: string): string | undefined => {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
};

const main = (): void => {
  const root = resolve(argumentValue('--root') ?? process.cwd());
  const configPath = resolve(root, argumentValue('--config') ?? 'scripts/repository-boundaries.json');
  const baselinePath = resolve(root, argumentValue('--baseline') ?? 'scripts/repository-boundaries-baseline.json');
  const analysis = analyzeRepository(root, loadConfig(configPath));

  if (process.argv.includes('--write-baseline')) {
    writeFileSync(baselinePath, `${JSON.stringify(analysis.keys, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${analysis.keys.length} repository-boundary issue(s): ${groupedCounts(analysis.issues)}`);
    return;
  }

  if (!existsSync(baselinePath)) throw new Error(`Boundary baseline is missing: ${baselinePath}`);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as string[];
  const comparison = compareBoundaryBaseline(analysis.keys, baseline);
  if (comparison.removals.length > 0) {
    console.log(`${comparison.removals.length} boundary issue(s) were removed; regenerate the baseline to ratchet it down.`);
  }
  if (comparison.additions.length > 0) {
    console.error(`${comparison.additions.length} new repository-boundary issue(s) are forbidden:`);
    for (const addition of comparison.additions) console.error(`  ${addition}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Repository boundaries hold: ${analysis.keys.length} active issue(s), ${comparison.removals.length} removable baseline entry(s). ${groupedCounts(analysis.issues)}`,
  );
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) main();
