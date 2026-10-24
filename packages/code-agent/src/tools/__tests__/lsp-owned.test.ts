import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { lspTools } from '../lsp.js';
import { lspPage } from '../../ports/lsp-port.js';
import { TsLanguageService } from '../../lsp/ts-service.js';
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'agent-lsp-')); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const references = lspTools.find(tool => tool.name === 'lsp_references')!;

it('provides exact totals and recoverable continuation without dropping the tail', async () => {
  const cwd = root(); writeFileSync(join(cwd, 'input.ts'), 'export const symbol = 1;');
  const items = Array.from({ length: 503 }, (_, index) => ({ file: 'input.ts', line: index + 1, column: 1 }));
  const query = vi.fn(async input => ({ kind: 'locations' as const, ...lspPage(items, input) }));
  const ctx = { cwd, projectName: 'fixture', ports: { lsp: { query } } };
  const first = await references.handler({ file_path: 'input.ts', line: 1, column: 14, limit: 500 }, ctx);
  expect(first.content).toContain('Found 503'); expect(first.content).toContain('"offset":500');
  expect(first.sourceTruncations).toEqual([{ technique: 'lsp-result-page', inputSize: 503, outputSize: 500, unit: 'items', recoverable: true }]);
  const tail = await references.handler({ file_path: 'input.ts', line: 1, column: 14, offset: 500, limit: 500 }, ctx);
  expect(tail.content).toContain('input.ts:503:1'); expect(tail.content).not.toContain('Continue:');
  const invalid = await references.handler({ file_path: 'input.ts', line: 0, column: 1 }, ctx);
  expect(invalid.isError).toBe(true); expect(query).toHaveBeenCalledTimes(2);
});

it('rejects invalid pages, outside paths and cancelled reads before dispatch', async () => {
  const cwd = root(); writeFileSync(join(cwd, 'input.ts'), 'export {}'); const query = vi.fn();
  const ctx = { cwd, projectName: 'fixture', ports: { lsp: { query } } };
  for (const args of [{ file_path: '../outside.ts' }, { file_path: 'input.ts', limit: 0 }, { file_path: 'input.ts', offset: -1 }]) {
    expect((await references.handler({ line: 1, column: 1, ...args }, ctx)).isError).toBe(true);
  }
  expect((await references.handler({ file_path: 'input.ts', line: 1, column: 1 }, { ...ctx, signal: AbortSignal.abort(new Error('cancelled')) })).content).toContain('cancelled');
  expect(query).not.toHaveBeenCalled();
});

it('observes dependency, out-of-config file and config changes without editor snapshots', () => {
  const cwd = root(), config = { compilerOptions: { strict: true, skipLibCheck: true, noLib: true, types: [] }, files: ['main.ts'] };
  writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(cwd, 'main.ts'), 'import { value } from "./value"; export const count: number = value;');
  writeFileSync(join(cwd, 'value.ts'), 'export const value = "bad";');
  writeFileSync(join(cwd, 'outside.ts'), 'export const outside: number = "bad";');
  const svc = new TsLanguageService(cwd, true);
  try {
    expect(svc.getDiagnostics('main.ts').some(d => d.code === 2322)).toBe(true);
    writeFileSync(join(cwd, 'value.ts'), 'export const value = 42;'); svc.refreshDiskProject();
    expect(svc.getDiagnostics('main.ts')).toEqual([]);
    expect(svc.getDiagnostics('outside.ts').some(d => d.code === 2322)).toBe(true);
    writeFileSync(join(cwd, 'outside.ts'), 'export const outside: number = 42;'); svc.refreshDiskProject();
    expect(svc.getDiagnostics('outside.ts')).toEqual([]);
    writeFileSync(join(cwd, 'main.ts'), 'export const count: number = undefined;'); svc.refreshDiskProject();
    expect(svc.getDiagnostics('main.ts').some(d => d.code === 2322)).toBe(true);
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, strict: false } })); svc.refreshDiskProject();
    expect(svc.getDiagnostics('main.ts')).toEqual([]);
    rmSync(join(cwd, 'main.ts')); expect(() => svc.getDiagnostics('main.ts')).toThrow('disappeared');
  } finally { svc.dispose(); }
});
