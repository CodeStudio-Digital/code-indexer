import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it('uses the linked project tsconfig instead of the synthetic union root', () => {
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

    const workspaceRoot = join(tempRoot, 'global-workspace');
    mkdirSync(workspaceRoot);
    const slug = 'linked-project';
    const linkedRoot = join(workspaceRoot, slug);
    symlinkSync(projectRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedMain = join(linkedRoot, 'src', 'main.ts');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const service = getTsServiceForFile(workspaceRoot, linkedMain, [{ slug }]);
      const diagnostic = service.diagnose(linkedMain);
      expect(diagnostic.tsconfigPath ? canonical(diagnostic.tsconfigPath) : null).toBe(
        `${canonical(linkedRoot)}/tsconfig.json`,
      );
      expect(diagnostic.nodeModulesPresent).toBe(true);

      const definition = service.getDefinition(linkedMain, 1, 10);
      expect(definition.targets).toHaveLength(1);
      expect(definition.targets[0]?.file).toMatch(/linked-project\/src\/lib\/value\.ts$/);
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
