import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
});
