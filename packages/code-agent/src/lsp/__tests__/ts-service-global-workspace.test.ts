import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disposeAllTsServices,
  getTsServiceForFile,
} from '../ts-service.js';

let tempRoot: string;

function canonical(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'ts-global-workspace-'));
});

afterEach(() => {
  disposeAllTsServices();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('TypeScript service routing in a global workspace', () => {
  it('uses the linked real project tsconfig without a junction', () => {
    const primaryRoot = join(tempRoot, 'primary-project');
    mkdirSync(primaryRoot);
    const projectRoot = join(tempRoot, 'real-project');
    const sourceRoot = join(projectRoot, 'src');
    const libraryRoot = join(sourceRoot, 'lib');
    mkdirSync(libraryRoot, { recursive: true });
    mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          baseUrl: '.',
          paths: { '@fixture/*': ['src/lib/*'] },
        },
        include: ['src/**/*.ts'],
      }),
    );
    writeFileSync(join(libraryRoot, 'value.ts'), 'export const fixtureValue = 42;\n');
    writeFileSync(
      join(sourceRoot, 'main.ts'),
      "import { fixtureValue } from '@fixture/value';\nexport const result = fixtureValue;\n",
    );

    const slug = 'linked-project';
    const linkedMain = join(projectRoot, 'src', 'main.ts');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const service = getTsServiceForFile(primaryRoot, linkedMain, [{
        slug,
        rootPath: projectRoot,
      }]);
      const diagnostic = service.diagnose(linkedMain);
      expect(diagnostic.tsconfigPath ? canonical(diagnostic.tsconfigPath) : null).toBe(
        `${canonical(projectRoot)}/tsconfig.json`,
      );
      expect(diagnostic.nodeModulesPresent).toBe(true);

      const definition = service.getDefinition(linkedMain, 1, 10);
      expect(definition.targets).toHaveLength(1);
      expect(definition.targets[0]?.file).toMatch(/real-project\/src\/lib\/value\.ts$/);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps ordinary sessions keyed by their original project root', () => {
    mkdirSync(join(tempRoot, 'src'));
    writeFileSync(join(tempRoot, 'src', 'main.ts'), 'export const value = 1;\n');
    const service = getTsServiceForFile(tempRoot, join(tempRoot, 'src', 'main.ts'));
    expect(canonical(service.diagnose().projectRoot)).toBe(canonical(tempRoot));
  });
});
