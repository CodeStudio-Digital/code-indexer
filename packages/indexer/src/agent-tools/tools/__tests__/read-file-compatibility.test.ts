import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { readFile } from '../read-file.js';

describe('MCP read_file compatibility modes', () => {
  let cwd: string;
  let db: CodeIndexDB;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mcp-read-compat-'));
    mkdirSync(join(cwd, 'src'));
    db = new CodeIndexDB(join(cwd, 'index.sqlite'));
    db.createProject('test', cwd);
    writeFileSync(join(cwd, 'src/big.ts'), Array.from({ length: 1000 }, (_, i) => `const x${i + 1} = ${i + 1}; // line ${i + 1}`).join('\n'));
    writeFileSync(join(cwd, 'src/foo.ts'), [
      '// header line', '', 'export function alpha(): number {', '  return 1;', '}', '',
      'export function bravo(name: string): string {', '  if (name) {',
      '    return name.toUpperCase();', '  }', '  return "";', '}', '',
      'export const charlie = 42;', '',
    ].join('\n'));
  });
  afterEach(() => {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  async function compatibilityRead(args: Record<string, unknown>) {
    const result = await readFile.handler({ project_name: 'test', ...args }, { db } as Parameters<typeof readFile.handler>[1]);
    return { content: typeof result === 'string' ? result : result.text, isError: false };
  }

  it('MCP compatibility: search_term centers the window on the first match', async () => {
    const r = await compatibilityRead({ file_path: 'src/big.ts', search_term: 'line 750' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Auto-scrolled to line 750');
    expect(r.content).toContain('const x750 =');
  });

  it('search_term returns a not-found message instead of erroring', async () => {
    const r = await compatibilityRead({ file_path: 'src/big.ts', search_term: 'definitely_not_in_file_xyz' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('not found');
  });

  it('MCP compatibility: returns the enclosing symbol body for around_line', async () => {
    // Line 9 is inside bravo's body
    const result = await compatibilityRead({ file_path: 'src/foo.ts', around_line: 9 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export function bravo');
    expect(result.content).toContain('return name.toUpperCase()');
    expect(result.content).not.toContain('export function alpha');
  });
});
