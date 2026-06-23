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

function canon(p: string): string {
  return p
    .split('\\')
    .join('/')
    .replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
}

describe('TsLanguageService integration', () => {
  let root: string;
  let svc: TsLanguageService;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-lsp-test-'));

    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@demo', 'lib'), { recursive: true });

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

    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@demo/lib': '1.0.0' } }, null, 2),
    );

    writeFileSync(
      join(root, 'node_modules', '@demo', 'lib', 'package.json'),
      JSON.stringify({ name: '@demo/lib', version: '1.0.0', types: 'index.d.ts' }, null, 2),
    );

    writeFileSync(
      join(root, 'node_modules', '@demo', 'lib', 'index.d.ts'),
      'export class ExternalWidget { ping(): string }\n',
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

    writeFileSync(
      join(root, 'src', 'generated.ts'),
      'export class GeneratedReportService { run(): number { return 1; } }\n',
    );

    writeFileSync(
      join(root, 'src', 'auto.ts'),
      [
        'export function make() {',
        '  const service = new Generated',
        '  return service',
        '}',
        '',
      ].join('\n'),
    );

    writeFileSync(
      join(root, 'src', 'auto-pkg.ts'),
      [
        'export function makeExternal() {',
        '  return new ExternalW',
        '}',
        '',
      ].join('\n'),
    );

    writeFileSync(
      join(root, 'src', 'missing-import.ts'),
      'export const widget = new GeneratedReportService();\n',
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
    expect(target.file).toBe(canon(join(root, 'src', 'calc.ts')));
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
    expect(files.has(canon(join(root, 'src', 'calc.ts')))).toBe(true);
    expect(files.has(canon(join(root, 'src', 'app.ts')))).toBe(true);
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

  it('paths are returned as canonical absolute paths with forward slashes', () => {
    const defs = svc.getDefinition('src/app.ts', 3, 24);
    for (const t of defs.targets) {
      expect(t.file).not.toContain('\\');
      expect(t.file.startsWith('/')).toBe(false);
      expect(t.file).toContain(':/');
      expect(t.file.endsWith('/src/calc.ts')).toBe(true);
    }
  });

  it('resolves project export completions with an auto-import edit', () => {
    const col = '  const service = new Generated'.length + 1;
    const item = svc
      .getCompletions('src/auto.ts', 2, col)
      .find((entry) => entry.name === 'GeneratedReportService');

    expect(item).toBeDefined();
    expect(item?.hasAction).toBe(true);

    const details = svc.getCompletionDetails(
      'src/auto.ts',
      2,
      col,
      item!.name,
      item!.source,
      item!.data,
    );

    expect(details?.additionalTextEdits?.[0]?.newText).toContain('GeneratedReportService');
    expect(details?.additionalTextEdits?.[0]?.newText).toContain('./generated');
  });

  it('resolves package export completions with an auto-import edit', () => {
    const col = '  return new ExternalW'.length + 1;
    const item = svc
      .getCompletions('src/auto-pkg.ts', 2, col)
      .find((entry) => entry.name === 'ExternalWidget');

    expect(item).toBeDefined();
    expect(item?.source).toBe('@demo/lib');

    const details = svc.getCompletionDetails(
      'src/auto-pkg.ts',
      2,
      col,
      item!.name,
      item!.source,
      item!.data,
    );

    expect(details?.additionalTextEdits?.[0]?.newText).toContain('ExternalWidget');
    expect(details?.additionalTextEdits?.[0]?.newText).toContain('from "@demo/lib"');
  });

  it('returns TS quick fixes as workspace edits', () => {
    const start = 'export const widget = new '.length + 1;
    const actions = svc.getCodeActions('src/missing-import.ts', {
      start: { line: 1, column: start },
      end: { line: 1, column: start + 'GeneratedReportService'.length },
    });

    const importAction = actions.find((a) => JSON.stringify(a.edit).includes('./generated'));
    expect(importAction).toBeDefined();
    expect(importAction?.edit?.changes[canon(join(root, 'src', 'missing-import.ts'))]?.[0]?.newText)
      .toContain('GeneratedReportService');
  });
});
