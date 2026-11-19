/**
 * Tolerant hunk location for apply_patch (Codex `seek_sequence` parity).
 *
 * The first case is the exact failure of the 3.16.24 Ky benchmark: hunks for
 * `source/utils/timeout.ts` carried one tab too many on removed and added
 * lines, the strict substring match rejected the whole four-file patch, and
 * the model spent three rounds (git diff, re-read, regenerate) recovering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyParsedPatch, applyPatchTool, parseApplyPatch } from '@mcp/code-agent/tools/apply-patch.js';
import { indentMapper, locateHunk } from '@mcp/code-agent/tools/apply-patch-match.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

let dir: string;
const ctx = (): ToolContext => ({ cwd: dir, projectName: 'apply-patch-match' }) as ToolContext;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'apply-patch-match-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const TIMEOUT_SOURCE = [
  'export async function timeout(request, abortController, options) {',
  '\treturn new Promise((resolve, reject) => {',
  '\t\tconst timeoutId = setTimeout(() => {',
  '\t\t\tif (abortController) {',
  '\t\t\t\tvoid abortController;',
  '\t\t\t}',
  '\t\t}, options.timeout);',
  '\t\tvoid timeoutId;',
  '\t});',
  '}',
  '',
].join('\n');

describe('apply_patch tolerant matching', () => {
  it('applies the benchmark patch whose hunks carried one extra tab, re-indenting added lines', async () => {
    writeFileSync(join(dir, 'timeout.ts'), TIMEOUT_SOURCE);
    writeFileSync(join(dir, 'other.ts'), 'export const a = 1;\n');
    const result = await applyPatchTool.handler({
      patch: [
        '*** Begin Patch',
        '*** Update File: other.ts',
        '@@',
        '-export const a = 1;',
        '+export const a = 2;',
        '*** Update File: timeout.ts',
        '@@',
        '-\t\t\t\t\tvoid abortController;',
        '+\t\t\t\t\tabortController?.abort();',
        '@@',
        '-\t\tvoid timeoutId;',
        '+\t\tclearTimeout(timeoutId);',
        '*** End Patch',
      ].join('\n'),
    }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Updated: other.ts, timeout.ts');
    expect(result.content).toContain('timeout.ts matched ignoring indentation');
    const written = readFileSync(join(dir, 'timeout.ts'), 'utf8');
    expect(written).toContain('\n\t\t\t\tabortController?.abort();\n');
    expect(written).not.toContain('\t\t\t\t\tabortController');
    expect(written).toContain('\n\t\tclearTimeout(timeoutId);\n');
    expect(readFileSync(join(dir, 'other.ts'), 'utf8')).toBe('export const a = 2;\n');
  });

  it('keeps the file context lines when only their indentation differed', async () => {
    // Patch indentation is uniformly two spaces shallower than the file.
    writeFileSync(join(dir, 'a.ts'), 'function f() {\n    if (x) {\n        go();\n    }\n}\n');
    await applyParsedPatch(parseApplyPatch([
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '   if (x) {',
      '-      go();',
      '+      go();',
      '+      stop();',
      '   }',
      '*** End Patch',
    ].join('\n')), ctx());
    expect(readFileSync(join(dir, 'a.ts'), 'utf8'))
      .toBe('function f() {\n    if (x) {\n        go();\n        stop();\n    }\n}\n');
  });

  it('inserts added lines verbatim when the indentation evidence is inconsistent', async () => {
    writeFileSync(join(dir, 'h.ts'), 'if (x) {\n    go();\n}\n');
    await applyParsedPatch(parseApplyPatch([
      '*** Begin Patch', '*** Update File: h.ts', '@@',
      '   if (x) {', '-  go();', '+  stop();', ' }', '*** End Patch',
    ].join('\n')), ctx());
    expect(readFileSync(join(dir, 'h.ts'), 'utf8')).toBe('if (x) {\n  stop();\n}\n');
  });

  it('tolerates trailing whitespace and typographic punctuation', async () => {
    writeFileSync(join(dir, 'b.ts'), 'const label = “done”;   \nconst n = 1;\n');
    await applyParsedPatch(parseApplyPatch([
      '*** Begin Patch',
      '*** Update File: b.ts',
      '@@',
      ' const label = "done";',
      '-const n = 1;',
      '+const n = 2;',
      '*** End Patch',
    ].join('\n')), ctx());
    // The file's own context line (fancy quotes + trailing spaces) survives.
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('const label = “done”;   \nconst n = 2;\n');
  });

  it('prefers the region after an @@ anchor over an earlier identical block', async () => {
    writeFileSync(join(dir, 'c.ts'), [
      'function first() {', '  return value;', '}', 'function second() {', '  return value;', '}', '',
    ].join('\n'));
    await applyParsedPatch(parseApplyPatch([
      '*** Begin Patch',
      '*** Update File: c.ts',
      '@@ function second() {',
      '-  return value;',
      '+  return other;',
      '*** End Patch',
    ].join('\n')), ctx());
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe([
      'function first() {', '  return value;', '}', 'function second() {', '  return other;', '}', '',
    ].join('\n'));
  });

  it('appends a context-free addition before the final newline', async () => {
    writeFileSync(join(dir, 'd.ts'), 'a\nb\n');
    await applyParsedPatch(parseApplyPatch('*** Begin Patch\n*** Update File: d.ts\n@@\n+c\n*** End Patch'), ctx());
    expect(readFileSync(join(dir, 'd.ts'), 'utf8')).toBe('a\nb\nc\n');
  });

  it('does not match a fragment in the middle of a longer line', async () => {
    writeFileSync(join(dir, 'e.ts'), 'const max = 1;\n');
    await expect(applyParsedPatch(parseApplyPatch(
      '*** Begin Patch\n*** Update File: e.ts\n@@\n-x = 1;\n+x = 2;\n*** End Patch',
    ), ctx())).rejects.toThrow(/did not match source/);
    expect(readFileSync(join(dir, 'e.ts'), 'utf8')).toBe('const max = 1;\n');
  });

  it('explains a real mismatch with the closest current text and the atomic guarantee', async () => {
    writeFileSync(join(dir, 'f.ts'), 'export function sum(a, b) {\n\treturn a + b;\n}\n');
    writeFileSync(join(dir, 'g.ts'), 'untouched\n');
    const result = await applyPatchTool.handler({
      patch: [
        '*** Begin Patch',
        '*** Update File: g.ts',
        '@@',
        '-untouched',
        '+changed',
        '*** Update File: f.ts',
        '@@',
        ' export function sum(a, b) {',
        '-\treturn a - b;',
        '+\treturn b + a;',
        ' }',
        '*** End Patch',
      ].join('\n'),
    }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Closest region: lines 1-3 (2/3 patch lines equal ignoring indentation)');
    expect(result.content).toContain('    2\t\treturn a + b;');
    expect(result.content).toContain('First difference: patch line 2 is "\\treturn a - b;" but file line 2 is "\\treturn a + b;"');
    expect(result.content).toContain('No file was changed');
    expect(readFileSync(join(dir, 'g.ts'), 'utf8')).toBe('untouched\n');
    expect(existsSync(join(dir, 'f.ts'))).toBe(true);
  });
});

describe('apply-patch-match primitives', () => {
  it('searches forward from the cursor before wrapping to the top', () => {
    const lines = ['x', 'y', 'x', 'y'];
    expect(locateHunk(lines, ['x', 'y'], 1)).toEqual({ start: 2, level: 'exact' });
    expect(locateHunk(lines, ['x', 'y'], 3)).toEqual({ start: 0, level: 'exact' });
  });

  it('re-indents only with consistent evidence', () => {
    const map = indentMapper([['\t\t\tfoo();', '\t\tfoo();'], ['\t\t\t\tbar();', '\t\t\tbar();']]);
    expect(map('\t\t\tbaz();')).toBe('\t\tbaz();');
    expect(map('\t\tclose();')).toBe('\tclose();');
    const inconsistent = indentMapper([['\tfoo();', '  foo();'], ['\t\tbar();', '\tbar();']]);
    expect(inconsistent('\tbaz();')).toBe('\tbaz();');
  });
});
