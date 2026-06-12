/**
 * read_file — the most-called tool in the system (1.407 native + 1.016 MCP
 * calls historically) had ZERO tests. Locks in the error strings the
 * telemetry surfaced (empty path, ENOENT), the slice/footer behavior and the
 * force escape hatch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';

const readFile = fsTools.find((t) => t.name === 'read_file')!;

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-read-'));
  ctx = { cwd: root, projectName: 'fs-read-test' } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (tool: CoderTool, args: Record<string, unknown>) => tool.handler(args, ctx);

describe('read_file — happy paths', () => {
  it('reads a small file in full (auto-full) with numbered lines and header', async () => {
    writeFileSync(join(root, 'a.ts'), 'first\nsecond\nthird');
    const res = await run(readFile, { path: 'a.ts' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('a.ts | 3 lines | ts');
    expect(res.content).toContain('[auto-full: file ≤800 lines]');
    expect(res.content).toContain('    1\tfirst');
    expect(res.content).toContain('    3\tthird');
  });

  it('respects start_line/end_line slices', async () => {
    writeFileSync(join(root, 'b.txt'), Array.from({ length: 50 }, (_, i) => `L${i + 1}`).join('\n'));
    const res = await run(readFile, { path: 'b.txt', start_line: 10, end_line: 12 });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('[lines 10-12]');
    expect(res.content).toContain('L10');
    expect(res.content).toContain('L12');
    expect(res.content).not.toContain('L13');
  });
});

describe('read_file — error strings (telemetry cases)', () => {
  it('empty path → the exact message models hit when sending file_path pre-alias', async () => {
    const res = await run(readFile, {});
    expect(res.isError).toBe(true);
    expect(res.content).toBe('path is required and cannot be empty');
  });

  it('missing file → "File X not found" with the underlying reason', async () => {
    const res = await run(readFile, { path: 'nope/missing.md' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('File nope/missing.md not found');
  });

  it('path traversal outside the root is refused', async () => {
    const res = await run(readFile, { path: '../outside.txt' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("outside project root");
  });

  it('a FOREIGN project_name is refused with the cross-project hint (telemetry case)', async () => {
    // Observed: model sent mcp__read_file-style args (project_name + path) to
    // the native tool. After alias repair the path resolves — against the
    // WRONG project root. The guard surfaces that instead of silently reading.
    writeFileSync(join(root, 'same-rel-path.md'), 'local content');
    const res = await run(readFile, { path: 'same-rel-path.md', project_name: 'poa-backend' });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("ignores project_name");
    expect(res.content).toContain('mcp__<project>__read_file');
  });

  it('project_name matching the session project passes through', async () => {
    writeFileSync(join(root, 'ok.md'), 'fine');
    const res = await run(readFile, { path: 'ok.md', project_name: 'fs-read-test' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('fine');
  });
});

describe('read_file — large-file truncation + force', () => {
  it('caps a >800-line file at the default window and explains how to continue', async () => {
    mkdirSync(join(root, 'big'));
    writeFileSync(join(root, 'big', 'huge.log'), Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join('\n'));
    const res = await run(readFile, { path: 'big/huge.log' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('[lines 1-400]');
    expect(res.content).toContain('[auto-full off — file > 800 lines, pass force=true to read all]');
    expect(res.content).toContain('[truncated: 600 more lines — pass force=true, symbol, around_line, or search_term]');
    expect(res.content).not.toContain('row 401');
  });

  it('force=true returns the whole file', async () => {
    writeFileSync(join(root, 'huge2.log'), Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join('\n'));
    const res = await run(readFile, { path: 'huge2.log', force: true });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('[lines 1-1000]');
    expect(res.content).toContain('row 1000');
    expect(res.content).not.toContain('[truncated:');
  });

  it('search_term centers the window and reports a miss without erroring', async () => {
    writeFileSync(join(root, 'find.txt'), Array.from({ length: 900 }, (_, i) => (i === 599 ? 'NEEDLE here' : `pad ${i}`)).join('\n'));
    const hit = await run(readFile, { path: 'find.txt', search_term: 'NEEDLE' });
    expect(hit.isError).toBeFalsy();
    expect(hit.content).toContain('[Auto-scrolled to line 600 matching "NEEDLE"]');

    const miss = await run(readFile, { path: 'find.txt', search_term: 'ABSENT_TOKEN' });
    expect(miss.isError).toBeFalsy();
    expect(miss.content).toContain('not found in find.txt');
  });
});
