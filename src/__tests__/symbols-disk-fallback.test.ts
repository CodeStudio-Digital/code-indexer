import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../store/db.js';
import { symbolTools } from '../apps/mcp-server/tools/symbols.js';

const find_references = symbolTools.find((t) => t.name === 'find_references')!;
const trace_usage = symbolTools.find((t) => t.name === 'trace_usage')!;
const prepare_edit = symbolTools.find((t) => t.name === 'prepare_edit')!;

describe('symbol tools — disk fallback for non-indexed projects', () => {
  let workDir: string;
  let dbPath: string;
  let db: CodeIndexDB;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sdf-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(
      join(workDir, 'src', 'lib.ts'),
      [
        'export function calcular(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export function dobrar(n: number): number {',
        '  return n * 2;',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(workDir, 'src', 'app.ts'),
      [
        "import { calcular, dobrar } from './lib';",
        '',
        'export function main() {',
        '  const total = calcular(2, 3);',
        '  return dobrar(total);',
        '}',
        '',
      ].join('\n'),
    );

    dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    // Project registered but never indexed.
    db.createProject('test-proj', workDir);
  });

  afterAll(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  function ctx() {
    return { db } as unknown as Parameters<typeof find_references.handler>[1];
  }

  it('find_references — disk-grep fallback returns hits across files', async () => {
    const out = await find_references.handler(
      { project_name: 'test-proj', symbol_name: 'calcular' },
      ctx(),
    );
    const text = String(out);
    expect(text).toContain('disk-grep fallback');
    expect(text).toContain('src/app.ts');
    // Should include the import line and the call line
    const lineMatches = text.match(/src\/app\.ts:\d+/g) ?? [];
    expect(lineMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('find_references — JSON source flag', async () => {
    const out = await find_references.handler(
      { project_name: 'test-proj', symbol_name: 'dobrar', format: 'json' },
      ctx(),
    );
    const parsed = JSON.parse(String(out));
    expect(parsed.source).toBe('disk_grep_fallback');
    expect(parsed.total).toBeGreaterThan(0);
  });

  it('trace_usage — falls back to depth=1 disk grep', async () => {
    const out = await trace_usage.handler(
      { project_name: 'test-proj', symbol_name: 'calcular', depth: 3 },
      ctx(),
    );
    const text = String(out);
    expect(text).toContain('tree-sitter fallback');
    expect(text).toContain('disk-grep fallback');
    expect(text).toContain('src/app.ts');
    expect(text).toContain('depth=3 but disk fallback only supports depth=1');
  });

  it('prepare_edit — disk fallback returns body + neighbors + callers', async () => {
    const out = await prepare_edit.handler(
      { project_name: 'test-proj', symbol_name: 'calcular' },
      ctx(),
    );
    const text = String(out);
    expect(text).toContain('disk fallback');
    expect(text).toContain('[BODY]');
    expect(text).toContain('return a + b');
    expect(text).toContain('[CALLERS]');
    expect(text).toContain('src/app.ts');
    expect(text).toContain('[NEIGHBORS]');
    expect(text).toContain('dobrar');
  });

  it('prepare_edit — JSON has source=disk_fallback and shape parity', async () => {
    const out = await prepare_edit.handler(
      { project_name: 'test-proj', symbol_name: 'dobrar', format: 'json' },
      ctx(),
    );
    const parsed = JSON.parse(String(out));
    expect(parsed.source).toBe('disk_fallback');
    expect(parsed.symbol.file_path).toBe('src/lib.ts');
    expect(parsed.body).toBeTruthy();
    expect(parsed.callers.total).toBeGreaterThan(0);
    expect(parsed.imports).toEqual([]);
    expect(parsed.tests_covering).toEqual([]);
  });

  it('prepare_edit — still throws when symbol does not exist anywhere', async () => {
    await expect(
      prepare_edit.handler(
        { project_name: 'test-proj', symbol_name: 'inexistente_xyz' },
        ctx(),
      ),
    ).rejects.toThrow(/not found/);
  });
});
