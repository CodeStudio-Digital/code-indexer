import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

/**
 * multi_edit integration: verifies atomic behaviour and sequential application.
 * Uses the real fs handler against a temp directory.
 */

const multiEdit = fsTools.find((t) => t.name === 'multi_edit')!;

function buildCtx(cwd: string): ToolContext {
  return { cwd, projectName: 'test' };
}

describe('multi_edit', () => {
  let dir: string;
  let file: string;
  const ORIGINAL =
    'function greet(name: string) {\n' +
    '  return "hello, " + name;\n' +
    '}\n' +
    '\n' +
    'export const defaultName = "world";\n';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-multiedit-'));
    file = join(dir, 'a.ts');
    writeFileSync(file, ORIGINAL, 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore Windows EBUSY */
    }
  });

  it('applies multiple sequential edits atomically on success', async () => {
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'function greet', new_string: 'export function greet' },
          { old_string: '"hello, "', new_string: '`hi, `' },
          { old_string: '"world"', new_string: '"earth"' },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBeFalsy();
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('export function greet');
    expect(content).toContain('`hi, ` + name');
    expect(content).toContain('"earth"');
  });

  it('rolls back atomically when a later edit fails', async () => {
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'function greet', new_string: 'export function greet' }, // OK
          { old_string: 'THIS STRING DOES NOT EXIST IN THE FILE', new_string: 'x' }, // FAILS
          { old_string: '"world"', new_string: '"earth"' }, // would be OK
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted at edit #2');
    // File must be untouched.
    expect(readFileSync(file, 'utf-8')).toBe(ORIGINAL);
  });

  it('rejects empty edits array', async () => {
    const result = await multiEdit.handler({ path: 'a.ts', edits: [] }, buildCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('cannot be empty');
  });

  it('rejects ambiguous old_string without replace_all', async () => {
    writeFileSync(file, 'x\nx\nx\n', 'utf-8');
    const result = await multiEdit.handler(
      { path: 'a.ts', edits: [{ old_string: 'x', new_string: 'y' }] },
      buildCtx(dir),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not unique|multiple/i);
    expect(readFileSync(file, 'utf-8')).toBe('x\nx\nx\n');
  });

  it('honors replace_all per edit', async () => {
    writeFileSync(file, 'a a a\nb b b\n', 'utf-8');
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'a', new_string: 'Z', replace_all: true },
          { old_string: 'b', new_string: 'Y', replace_all: true },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toBe('Z Z Z\nY Y Y\n');
  });

  it('sees the rolling in-memory result — edit #2 can match on edit #1 output', async () => {
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'function greet', new_string: 'function welcome' },
          // This second edit only matches AFTER the first one runs.
          { old_string: 'function welcome', new_string: 'export function welcome' },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toContain('export function welcome');
  });

  it('matches curly quotes when old_string uses straight quotes', async () => {
    // File contains curly (smart) quotes
    writeFileSync(file, 'const msg = \u201Chello world\u201D;\n', 'utf-8');
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'const msg = "hello world";', new_string: 'const msg = "goodbye world";' },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toContain('goodbye world');
  });

  it('matches straight quotes when old_string uses curly quotes', async () => {
    writeFileSync(file, 'const msg = "hello world";\n', 'utf-8');
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'const msg = \u201Chello world\u201D;', new_string: 'const msg = "goodbye world";' },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(file, 'utf-8')).toContain('goodbye world');
  });

  it('provides actionable fuzzy hint when old_string not found', async () => {
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'function greetPerson', new_string: 'function welcomePerson' },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBe(true);
    // Should find a nearby match and show context
    expect(result.content).toMatch(/line \d+|Suggested|Match/i);
  });

  it('handles CRLF line endings transparently', async () => {
    writeFileSync(file, 'line1\r\nline2\r\nline3\r\n', 'utf-8');
    const result = await multiEdit.handler(
      {
        path: 'a.ts',
        edits: [
          { old_string: 'line1\nline2', new_string: 'changed1\nchanged2' },
        ],
      },
      buildCtx(dir),
    );
    expect(result.isError).toBeFalsy();
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('changed1');
    expect(content).toContain('changed2');
  });
});
