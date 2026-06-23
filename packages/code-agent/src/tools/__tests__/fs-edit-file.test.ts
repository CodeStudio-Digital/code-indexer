/**
 * edit_file — 406 historical calls, zero tests. Locks in: exact replace, the
 * progressive matcher's CRLF tolerance, the empty/not-found/non-unique error
 * contracts (telemetry: "old_string cannot be empty"), and replace_all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';

const editFile = fsTools.find((t) => t.name === 'edit_file')!;

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-edit-'));
  ctx = { cwd: root, projectName: 'fs-edit-test' } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, content: string) => writeFileSync(join(root, rel), content);
const readBack = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('edit_file — replacements', () => {
  it('applies a unique exact replacement', async () => {
    write('a.ts', 'const x = 1;\nconst y = 2;\n');
    const res = await editFile.handler(
      { path: 'a.ts', old_string: 'const y = 2;', new_string: 'const y = 42;' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('Edited a.ts (1 replacement)');
    expect(readBack('a.ts')).toContain('const y = 42;');
  });

  it('tolerates CRLF/LF mismatch via the progressive matcher and says so', async () => {
    write('b.ts', 'line one\r\nline two\r\n');
    const res = await editFile.handler(
      { path: 'b.ts', old_string: 'line one\nline two', new_string: 'replaced' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('[matched via:');
  });

  it('replace_all replaces every occurrence and reports the count', async () => {
    write('c.ts', 'foo();\nfoo();\nfoo();\n');
    const res = await editFile.handler(
      { path: 'c.ts', old_string: 'foo();', new_string: 'bar();', replace_all: true },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('(3 replacements)');
    expect(readBack('c.ts')).not.toContain('foo();');
  });
});

describe('edit_file — error contracts', () => {
  it('empty old_string → the exact telemetry message', async () => {
    write('d.ts', 'x');
    const res = await editFile.handler({ path: 'd.ts', old_string: '', new_string: 'y' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('old_string cannot be empty');
  });

  it('empty path → its own message (not a generic failure)', async () => {
    const res = await editFile.handler({ path: '', old_string: 'a', new_string: 'b' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('path is required and cannot be empty');
  });

  it('missing file → "File X not found"', async () => {
    const res = await editFile.handler(
      { path: 'ghost.ts', old_string: 'a', new_string: 'b' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toBe('File ghost.ts not found');
  });

  it('non-unique match without replace_all → actionable ambiguity error', async () => {
    write('e.ts', 'dup();\ndup();\n');
    const res = await editFile.handler({ path: 'e.ts', old_string: 'dup();', new_string: 'x();' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('old_string is not unique in e.ts (2 occurrences');
    expect(res.content).toContain('replace_all=true');
    expect(readBack('e.ts')).toBe('dup();\ndup();\n'); // nothing applied
  });

  it('no match anywhere → lists the strategies tried and forbids a verbatim retry', async () => {
    write('f.ts', 'actual content here\n');
    const res = await editFile.handler(
      { path: 'f.ts', old_string: 'totally absent text', new_string: 'x' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('old_string not found in f.ts');
    expect(res.content).toContain('Do not retry with the same old_string');
  });
});
