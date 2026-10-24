import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRepository,
  compareBoundaryBaseline,
  extractModuleSpecifiers,
  type RepositoryBoundaryConfig,
} from '../../scripts/check-repository-boundaries.js';

const roots: string[] = [];

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'repository-boundaries-'));
  roots.push(root);
  return root;
};

const put = (root: string, path: string, content: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};

const config = (overrides: Partial<RepositoryBoundaryConfig> = {}): RepositoryBoundaryConfig => ({
  schemaVersion: 1,
  domains: [
    { name: 'alpha', roots: ['packages/alpha', 'apps/shell'] },
    { name: 'beta', roots: ['packages/beta'] },
  ],
  allowedCrossDomainPackages: { alpha: [], beta: [] },
  publicationPackages: [],
  forbiddenTrackedPatterns: [],
  ...overrides,
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('repository boundary analysis', () => {
  it('ignores tracked files deleted from the working tree without staging', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture' }));
    put(root, 'packages/alpha/package.json', JSON.stringify({ name: '@fixture/alpha' }));
    const deleted = 'packages/alpha/src/removed.ts';
    put(root, deleted, "import 'removed-dependency';\n");
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    unlinkSync(join(root, deleted));

    expect(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }))
      .toContain(`${deleted}\0`);
    const result = analyzeRepository(root, config());
    expect(result.trackedFiles).not.toContain(deleted);
    expect(result.issues).toEqual([]);
  });

  it('checks new untracked sources while honoring ignored files', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture' }));
    put(root, 'packages/alpha/package.json', JSON.stringify({ name: '@fixture/alpha' }));
    put(root, '.gitignore', 'packages/alpha/src/ignored.ts\n');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    const added = 'packages/alpha/src/new source.ts';
    put(root, added, "import 'untracked-dependency';\n");
    put(root, 'packages/alpha/src/ignored.ts', "import 'ignored-dependency';\n");

    const result = analyzeRepository(root, config());
    expect(result.trackedFiles).toContain(added);
    expect(result.trackedFiles).not.toContain('packages/alpha/src/ignored.ts');
    expect(result.issues).toEqual([{
      kind: 'undeclared-external-dependency',
      file: added,
      unit: 'packages/alpha',
      specifier: 'untracked-dependency',
    }]);
  });

  it('extracts every supported static and dynamic module reference', () => {
    const source = [
      "import value from 'static-package';",
      "export { value } from 'exported-package';",
      "const dynamic = import('dynamic-package');",
      "const required = require('required-package');",
      "type Imported = import('type-package').Imported;",
      "import equal = require('equals-package');",
    ].join('\n');

    expect(extractModuleSpecifiers(source, 'fixture.ts')).toEqual([
      'dynamic-package',
      'equals-package',
      'exported-package',
      'required-package',
      'static-package',
      'type-package',
    ]);
  });

  it('finds manifest, dependency and cross-domain violations', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: {} }));
    put(root, 'packages/alpha/package.json', JSON.stringify({
      name: '@fixture/alpha',
      dependencies: { '@fixture/beta': 'workspace:*' },
    }));
    put(root, 'packages/beta/package.json', JSON.stringify({ name: '@fixture/beta' }));
    put(root, 'packages/alpha/src/index.ts', [
      "import '@fixture/beta';",
      "import('undeclared-package');",
      "export * from '../../../packages/beta/src/index.js';",
    ].join('\n'));
    put(root, 'packages/beta/src/index.ts', 'export const beta = true;\n');
    put(root, 'apps/shell/main.ts', "import '@fixture/beta';\n");
    const files = [
      'package.json',
      'packages/alpha/package.json',
      'packages/beta/package.json',
      'packages/alpha/src/index.ts',
      'packages/beta/src/index.ts',
      'apps/shell/main.ts',
    ];

    const result = analyzeRepository(root, config(), files);
    const kinds = result.issues.map((issue) => issue.kind);

    expect(kinds).toContain('cross-domain-relative-import');
    expect(kinds).toContain('cross-domain-workspace-dependency');
    expect(kinds).toContain('forbidden-domain-import');
    expect(kinds).toContain('missing-unit-manifest');
    expect(kinds).toContain('undeclared-external-dependency');
    expect(kinds).toContain('undeclared-internal-dependency');
  });

  it('checks publication readiness and tracked artifact hygiene', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture' }));
    put(root, 'packages/alpha/package.json', JSON.stringify({
      name: '@fixture/alpha',
      version: '0.0.0',
      private: true,
      exports: { '.': './src/index.ts', './*': './src/*' },
    }));
    put(root, 'packages/alpha/src/index.ts', 'export const alpha = true;\n');
    put(root, 'packages/alpha/tsconfig.tsbuildinfo', '{}');

    const result = analyzeRepository(root, config({
      publicationPackages: ['@fixture/alpha', '@fixture/missing'],
      forbiddenTrackedPatterns: ['**/*.tsbuildinfo'],
    }), [
      'package.json',
      'packages/alpha/package.json',
      'packages/alpha/src/index.ts',
      'packages/alpha/tsconfig.tsbuildinfo',
    ]);
    const kinds = result.issues.map((issue) => issue.kind);

    expect(kinds).toContain('forbidden-tracked-artifact');
    expect(kinds).toContain('publication-package-missing');
    expect(kinds).toContain('publication-package-private');
    expect(kinds).toContain('publication-package-version');
    expect(kinds).toContain('publication-source-export');
    expect(kinds).toContain('publication-wildcard-export');
  });

  it('allows debt to shrink and rejects additions', () => {
    expect(compareBoundaryBaseline(['kept'], ['kept', 'removed'])).toEqual({
      additions: [],
      removals: ['removed'],
    });
    expect(compareBoundaryBaseline(['kept', 'added'], ['kept'])).toEqual({
      additions: ['added'],
      removals: [],
    });
  });

  it('does not assign root workspace dependencies to an app while retaining the import boundary', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture', devDependencies: { '@fixture/beta': 'workspace:*' } }));
    put(root, 'packages/beta/package.json', JSON.stringify({ name: '@fixture/beta' }));
    put(root, 'apps/shell/main.ts', "import '@fixture/beta';\n");
    const result = analyzeRepository(root, config(), ['package.json', 'packages/beta/package.json', 'apps/shell/main.ts']);
    expect(result.issues.some(issue => issue.kind === 'cross-domain-workspace-dependency')).toBe(false);
    expect(result.issues.some(issue => issue.kind === 'forbidden-domain-import')).toBe(true);
  });

  it('permits only a named contract subpath and an explicit same-domain application entrypoint', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture' }));
    put(root, 'packages/alpha/package.json', JSON.stringify({ name: '@fixture/alpha', dependencies: { '@fixture/beta': 'workspace:*' } }));
    put(root, 'packages/beta/package.json', JSON.stringify({ name: '@fixture/beta' }));
    put(root, 'packages/alpha/src/index.ts', [
      "import '@fixture/beta/contract.js';", "import '@fixture/beta/internal.js';",
      "import '../../../apps/shell/public.js';", "import '../../../apps/shell/internal.js';",
    ].join('\n'));
    const result = analyzeRepository(root, config({
      allowedCrossDomainImports: { alpha: ['@fixture/beta/contract.js'] },
      allowedWorkspacePackages: { alpha: ['@fixture/beta'] },
      unitEntrypoints: ['apps/shell/public.js'],
    }), ['package.json', 'packages/alpha/package.json', 'packages/beta/package.json', 'packages/alpha/src/index.ts']);
    expect(result.issues.map(issue => issue.specifier)).toEqual([
      '../../../apps/shell/internal.js', '@fixture/beta',
    ]);
  });

  it('limits runtime-provided modules to their declared entrypoint', () => {
    const root = fixture();
    put(root, 'package.json', JSON.stringify({ name: 'fixture' }));
    // A synthetic module tests the per-entrypoint rule in both Node and
    // Electron, whose builtinModules already includes original-fs globally.
    put(root, 'apps/shell/main.ts', "import 'fixture-runtime-native';\n");
    put(root, 'apps/shell/other.ts', "import 'fixture-runtime-native';\n");
    const result = analyzeRepository(root, config({ runtimeModules: { 'apps/shell/main.ts': ['fixture-runtime-native'] } }),
      ['package.json', 'apps/shell/main.ts', 'apps/shell/other.ts']);
    expect(result.issues.filter(issue => issue.kind === 'undeclared-external-dependency').map(issue => issue.file))
      .toEqual(['apps/shell/other.ts']);
  });
});
