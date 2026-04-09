import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globTool } from '../core/coder/tools/glob.js';
import type { ToolContext } from '../core/coder/core/tool.js';

describe('glob tool', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-glob-'));
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    mkdirSync(join(root, 'src', 'apps'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });

    writeFileSync(join(root, 'src', 'core', 'runner.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'core', 'runner.test.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'apps', 'index.ts'), 'export {};');
    writeFileSync(join(root, 'dist', 'runner.js'), '// built');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), '// dep');
    writeFileSync(join(root, '.gitignore'), 'dist\n');

    // Deterministic mtimes so the "most recent first" check is stable.
    const now = Date.now() / 1000;
    utimesSync(join(root, 'src', 'core', 'runner.ts'), now - 100, now - 100);
    utimesSync(join(root, 'src', 'core', 'runner.test.ts'), now, now);
    utimesSync(join(root, 'src', 'apps', 'index.ts'), now - 50, now - 50);
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore Windows EBUSY */
    }
  });

  const ctx = (): ToolContext => ({ cwd: root, projectName: 'test' });

  it('matches a simple **/*.ts pattern and returns project-relative paths', async () => {
    const result = await globTool.handler({ pattern: '**/*.ts' }, ctx());
    expect(result.isError).toBeFalsy();
    const content = result.content;
    expect(content).toContain('src/core/runner.ts');
    expect(content).toContain('src/core/runner.test.ts');
    expect(content).toContain('src/apps/index.ts');
  });

  it('respects .gitignore by default (dist/ excluded)', async () => {
    const result = await globTool.handler({ pattern: '**/*.js' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toContain('dist/runner.js');
  });

  it('always excludes node_modules even without gitignore coverage', async () => {
    const result = await globTool.handler({ pattern: '**/*.ts' }, ctx());
    expect(result.content).not.toContain('node_modules/pkg/index.ts');
  });

  it('respect_ignore:false bypasses ignore rules', async () => {
    const result = await globTool.handler(
      { pattern: '**/*.js', respect_ignore: false },
      ctx(),
    );
    // dist/runner.js should now appear. node_modules is still excluded by
    // the built-in safety list.
    expect(result.content).toContain('dist/runner.js');
  });

  it('orders results by mtime descending', async () => {
    const result = await globTool.handler({ pattern: 'src/**/*.ts' }, ctx());
    const lines = result.content.split('\n').filter((l) => l.includes('.ts'));
    const runnerTestIdx = lines.findIndex((l) => l.includes('runner.test.ts'));
    const runnerIdx = lines.findIndex((l) => l.includes('/runner.ts'));
    expect(runnerTestIdx).toBeGreaterThanOrEqual(0);
    expect(runnerIdx).toBeGreaterThanOrEqual(0);
    expect(runnerTestIdx).toBeLessThan(runnerIdx);
  });

  it('reports zero matches cleanly', async () => {
    const result = await globTool.handler({ pattern: '**/*.rs' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('No matches');
  });

  it('rejects absolute patterns', async () => {
    const result = await globTool.handler({ pattern: '/etc/**' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('absolute');
  });

  it('scopes to a subdirectory via the `path` argument', async () => {
    const result = await globTool.handler({ pattern: '**/*.ts', path: 'src/core' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('src/core/runner.ts');
    expect(result.content).not.toContain('src/apps/index.ts');
  });
});
