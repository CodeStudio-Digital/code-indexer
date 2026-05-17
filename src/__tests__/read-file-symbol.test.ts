import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const readFileTool = fsTools.find((t) => t.name === 'read_file')!;

describe('read_file native — symbol/around_line modes', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rf-symbol-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(
      join(cwd, 'src', 'foo.ts'),
      [
        '// header line',
        '',
        'export function alpha(): number {',
        '  return 1;',
        '}',
        '',
        'export function bravo(name: string): string {',
        '  if (name) {',
        '    return name.toUpperCase();',
        '  }',
        '  return "";',
        '}',
        '',
        'export const charlie = 42;',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return { cwd, projectName: 'test' };
  }

  it('returns just the symbol body when symbol is given', async () => {
    const result = await readFileTool.handler({ path: 'src/foo.ts', symbol: 'bravo' }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('symbol body');
    expect(result.content).toContain('export function bravo');
    expect(result.content).toContain('return name.toUpperCase()');
    // alpha and charlie must NOT leak
    expect(result.content).not.toContain('export function alpha');
    expect(result.content).not.toContain('charlie = 42');
  });

  it('returns the enclosing symbol body for around_line', async () => {
    // Line 9 is inside bravo's body
    const result = await readFileTool.handler({ path: 'src/foo.ts', around_line: 9 }, ctx());
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export function bravo');
    expect(result.content).toContain('return name.toUpperCase()');
    expect(result.content).not.toContain('export function alpha');
  });

  it('errors clearly when symbol is missing', async () => {
    const result = await readFileTool.handler({ path: 'src/foo.ts', symbol: 'nonexistent' }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Symbol 'nonexistent' not found");
  });

  it('falls back to plain range when neither symbol nor around_line is given', async () => {
    const result = await readFileTool.handler(
      { path: 'src/foo.ts', start_line: 1, end_line: 3 },
      ctx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('// header line');
    expect(result.content).toContain('export function alpha');
    expect(result.content).not.toContain('charlie');
  });
});
