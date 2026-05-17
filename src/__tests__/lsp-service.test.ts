import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TsLanguageService } from '@mcp/code-agent/lsp/ts-service.js';

/**
 * Integration test for the in-process TypeScript language service.
 *
 * Builds a tiny fake TS project in a temp dir (tsconfig + 2 source files),
 * boots a TsLanguageService against it, and exercises the four public
 * methods end-to-end: getDefinition, getReferences, getHover, getDiagnostics.
 *
 * This is a real integration test — the TS compiler actually loads and
 * type-checks the sources. No mocks.
 */

describe('TsLanguageService integration', () => {
  let root: string;
  let svc: TsLanguageService;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-lsp-test-'));

    mkdirSync(join(root, 'src'), { recursive: true });

    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    );

    // A tiny "calculator" module + consumer. Known coordinates used below:
    //   src/calc.ts line 4, col 17 = "add" in "export function add"
    //   src/app.ts  line 3, col 8  = "add" call site
    writeFileSync(
      join(root, 'src', 'calc.ts'),
      [
        '/** Adds two numbers together. */',
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export const PI = 3.14;',
        '',
      ].join('\n'),
    );

    writeFileSync(
      join(root, 'src', 'app.ts'),
      [
        "import { add, PI } from './calc.js';",
        '',
        'export const result = add(1, 2);',
        'export const circumference = 2 * PI * 10;',
        '',
        '// Intentional type error for diagnostics:',
        'export const broken: number = add(1, "two");',
        '',
      ].join('\n'),
    );

    svc = new TsLanguageService(root);
  });

  afterAll(() => {
    svc.dispose();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore Windows file-lock races on cleanup */
    }
  });

  it('getDefinition resolves a call site to its declaration', () => {
    // app.ts line 3: "export const result = add(1, 2);"
    //                 1234567890123456789012345678
    // "add" starts at column 23; col 24 lands inside the identifier.
    const result = svc.getDefinition('src/app.ts', 3, 24);
    expect(result.targets.length).toBeGreaterThanOrEqual(1);
    const target = result.targets[0];
    expect(target.file).toBe('src/calc.ts');
    expect(target.line).toBe(2);
    // Column varies a tiny bit between TS versions — just check it lands on
    // the identifier range (not at col 1).
    expect(target.column).toBeGreaterThan(10);
  });

  it('getReferences finds every usage of a symbol', () => {
    // Position on the declaration in calc.ts → line 2 "function add"
    const result = svc.getReferences('src/calc.ts', 2, 17);
    // At minimum: the declaration + 2 call sites (app.ts line 3 and line 7).
    expect(result.references.length).toBeGreaterThanOrEqual(3);
    const files = new Set(result.references.map((r) => r.file));
    expect(files.has('src/calc.ts')).toBe(true);
    expect(files.has('src/app.ts')).toBe(true);
  });

  it('getHover returns the type signature', () => {
    // Hover on "add" at its declaration.
    const hover = svc.getHover('src/calc.ts', 2, 17);
    expect(hover).not.toBeNull();
    if (!hover) return;
    expect(hover.displayString).toContain('add');
    expect(hover.displayString).toContain('number');
  });

  it('getHover exposes JSDoc documentation when present', () => {
    const hover = svc.getHover('src/calc.ts', 2, 17);
    expect(hover).not.toBeNull();
    expect(hover?.documentation).toContain('Adds two numbers');
  });

  it('getDiagnostics catches a type error in the consumer', () => {
    const diags = svc.getDiagnostics('src/app.ts');
    // The intentional `add(1, "two")` on line 7 must produce an error.
    const errorsOnLine7 = diags.filter((d) => d.severity === 'error' && d.line === 7);
    expect(errorsOnLine7.length).toBeGreaterThanOrEqual(1);
    expect(errorsOnLine7[0].message.toLowerCase()).toContain('string');
  });

  it('getDiagnostics returns empty for a clean file', () => {
    const diags = svc.getDiagnostics('src/calc.ts');
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('paths are returned as project-relative with forward slashes', () => {
    const defs = svc.getDefinition('src/app.ts', 3, 24);
    for (const t of defs.targets) {
      expect(t.file).not.toContain('\\');
      expect(t.file.startsWith('/')).toBe(false);
    }
  });
});
