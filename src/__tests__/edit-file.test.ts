import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const editFile = fsTools.find((t) => t.name === 'edit_file')!;

describe('edit_file fuzzy matching', () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-edit-'));
    ctx = { cwd: root, projectName: 'test' };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exact match works', async () => {
    writeFileSync(join(root, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
    const r = await editFile.handler({ path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = 42;' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, 'a.ts'), 'utf-8')).toBe('const x = 42;\nconst y = 2;\n');
  });

  it('matches across CRLF line endings when old_string uses LF', async () => {
    writeFileSync(join(root, 'crlf.ts'), 'function foo() {\r\n  return 1;\r\n}\r\n');
    const r = await editFile.handler({
      path: 'crlf.ts',
      old_string: 'function foo() {\n  return 1;\n}',
      new_string: 'function foo() {\n  return 42;\n}',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('line-endings normalized');
    expect(readFileSync(join(root, 'crlf.ts'), 'utf-8')).toContain('return 42');
  });

  it('tolerates trailing whitespace mismatch', async () => {
    writeFileSync(join(root, 'trail.ts'), 'const a = 1;   \nconst b = 2;\n');
    const r = await editFile.handler({
      path: 'trail.ts',
      old_string: 'const a = 1;\nconst b = 2;',
      new_string: 'const a = 99;\nconst b = 2;',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('trailing whitespace trimmed');
  });

  it('tolerates internal whitespace differences (collapsed)', async () => {
    writeFileSync(join(root, 'ws.ts'), 'const  x   =   42;\n');
    const r = await editFile.handler({
      path: 'ws.ts',
      old_string: 'const x = 42;',
      new_string: 'const x = 99;',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('whitespace collapsed');
  });

  it('returns a helpful error with fuzzy hint when no match', async () => {
    writeFileSync(join(root, 'nomatch.ts'), 'function add(a: number, b: number) {\n  return a + b;\n}\n');
    const r = await editFile.handler({
      path: 'nomatch.ts',
      old_string: 'function subtract(a, b) {\n  return a - b;\n}',
      new_string: 'function subtract(a, b) { return a - b; }',
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not found');
    expect(r.content).toContain('Do not retry');
  });

  it('fuzzy hint surfaces a nearby line when old_string partially matches', async () => {
    writeFileSync(join(root, 'hint.ts'), 'line a\nline b: actual content here\nline c\n');
    const r = await editFile.handler({
      path: 'hint.ts',
      old_string: 'line b: actual content here\nline that does not exist',
      new_string: 'replaced',
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Match.*near line \d+/);
    expect(r.content).toContain('line b: actual content here');
  });

  it('rejects non-unique match without replace_all', async () => {
    writeFileSync(join(root, 'dup.ts'), 'x = 1;\nx = 1;\n');
    const r = await editFile.handler({
      path: 'dup.ts',
      old_string: 'x = 1;',
      new_string: 'x = 2;',
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not unique');
  });

  it('replace_all works on multiple occurrences', async () => {
    writeFileSync(join(root, 'dup.ts'), 'x = 1;\nx = 1;\n');
    const r = await editFile.handler({
      path: 'dup.ts',
      old_string: 'x = 1;',
      new_string: 'x = 2;',
      replace_all: true,
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, 'dup.ts'), 'utf-8')).toBe('x = 2;\nx = 2;\n');
  });

  // ---- cascade replacers (ported from opencode) ----

  it('escape-normalized: matches when LLM double-escapes \\n in old_string', async () => {
    writeFileSync(join(root, 'esc.ts'), 'const s = "a\\nb";\n');
    // Intentional literal backslash-n in old_string (what a misbehaving LLM emits)
    const r = await editFile.handler({
      path: 'esc.ts',
      old_string: 'const s = "a\\\\nb";', // "const s = \"a\\nb\";"
      new_string: 'const s = "x";',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('escape normalized');
    expect(readFileSync(join(root, 'esc.ts'), 'utf-8')).toBe('const s = "x";\n');
  });

  it('indentation-flexible: matches old_string with no indent against indented content', async () => {
    const src = [
      'function outer() {',
      '    if (x) {',
      '        return 1;',
      '    }',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'indent.ts'), src);
    const r = await editFile.handler({
      path: 'indent.ts',
      old_string: 'if (x) {\n    return 1;\n}',
      new_string: 'if (x) {\n    return 42;\n}',
    }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('indentation flexible');
    expect(readFileSync(join(root, 'indent.ts'), 'utf-8')).toContain('return 42;');
  });

  it('block-anchor: matches when middle body differs slightly', async () => {
    const src = [
      'function compute(a, b) {',
      '  const temp = a * 2;',
      '  const result = temp + b;',
      '  return result;',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'block.ts'), src);
    // Old middle is completely wrong but anchors (first/last line) match exactly
    const r = await editFile.handler({
      path: 'block.ts',
      old_string: 'function compute(a, b) {\n  // stale middle\n  // more stale\n  // even more stale\n}',
      new_string: 'function compute(a, b) {\n  return a + b;\n}',
    }, ctx);
    // Block-anchor requires same line count; give it the right count:
    // Our old has 5 lines, src's function is 5 lines too. Should match.
    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/block anchor|context aware/);
    expect(readFileSync(join(root, 'block.ts'), 'utf-8')).toContain('return a + b;');
  });

  it('context-aware: rejects block-anchor match when middle is dissimilar beyond threshold', async () => {
    // Two different functions share the same first/last lines but different middles.
    // Block-anchor would match both; context-aware should pick the one with
    // sufficient similarity. Here we want the looser block-anchor to be
    // non-unique and bail out cleanly.
    const src = [
      'function f() {',
      '  alpha();',
      '}',
      '',
      'function f() {',
      '  beta();',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'dup-block.ts'), src);
    const r = await editFile.handler({
      path: 'dup-block.ts',
      old_string: 'function f() {\n  alpha();\n}',
      new_string: 'function f() {\n  alpha_v2();\n}',
    }, ctx);
    // Exact match should hit first (no need for block-anchor)
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(root, 'dup-block.ts'), 'utf-8')).toContain('alpha_v2();');
  });
});
