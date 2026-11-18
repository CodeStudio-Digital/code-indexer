/**
 * Tests for the `apply_patch` Codex-style freeform editor.
 *
 * Covers:
 *   - Parser: Add / Update / Delete / Move actions, multiple hunks per file.
 *   - Applier: writes new files, mutates existing, deletes, moves.
 *   - Tool handler: parses raw input, surfaces errors cleanly.
 *   - Provider wiring: chatgpt provider sends apply_patch as `type: 'custom'`
 *     when applyPatchToolType='freeform', as `function` otherwise.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseApplyPatch,
  applyParsedPatch,
  applyPatchTool,
} from '@mcp/code-agent/tools/apply-patch.js';
import { ChatGPTCodexProvider } from '@mcp/code-agent/providers/chatgpt.js';
import type { ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

async function* events(...evts: Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  for (const e of evts) yield e;
}

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    projectName: 'test',
    overlay: undefined,
    signal: undefined,
    planMode: false,
  } as unknown as ToolContext;
}

describe('apply_patch parser', () => {
  it('parses Add File action with multiple lines', () => {
    const patch = `*** Begin Patch
*** Add File: src/foo.ts
+export const x = 1;
+export const y = 2;
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions).toHaveLength(1);
    const a = parsed.actions[0];
    expect(a.kind).toBe('add');
    if (a.kind === 'add') {
      expect(a.path).toBe('src/foo.ts');
      expect(a.lines).toEqual(['export const x = 1;', 'export const y = 2;']);
    }
  });

  it('parses Delete File action', () => {
    const patch = `*** Begin Patch
*** Delete File: dead.ts
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0]).toEqual({ kind: 'delete', path: 'dead.ts' });
  });

  it('parses Update File with one hunk', () => {
    const patch = `*** Begin Patch
*** Update File: src/foo.ts
@@ context
 unchanged top
-old line
+new line
 unchanged bottom
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions).toHaveLength(1);
    const a = parsed.actions[0];
    expect(a.kind).toBe('update');
    if (a.kind === 'update') {
      expect(a.path).toBe('src/foo.ts');
      expect(a.hunks).toHaveLength(1);
      const h = a.hunks[0];
      expect(h.contextBefore).toEqual(['unchanged top']);
      expect(h.removed).toEqual(['old line']);
      expect(h.added).toEqual(['new line']);
      expect(h.contextAfter).toEqual(['unchanged bottom']);
    }
  });

  it('parses Update File with Move to', () => {
    const patch = `*** Begin Patch
*** Update File: old.ts
*** Move to: new.ts
@@
-old
+new
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    const a = parsed.actions[0];
    if (a.kind === 'update') {
      expect(a.path).toBe('old.ts');
      expect(a.movePath).toBe('new.ts');
    }
  });

  it('parses multiple actions in one patch', () => {
    const patch = `*** Begin Patch
*** Add File: a.ts
+a
*** Update File: b.ts
@@
-old
+new
*** Delete File: c.ts
*** End Patch`;
    const parsed = parseApplyPatch(patch);
    expect(parsed.actions.map((a) => a.kind)).toEqual(['add', 'update', 'delete']);
  });

  it('throws when missing Begin Patch header', () => {
    expect(() => parseApplyPatch('*** Add File: x\n+a\n*** End Patch')).toThrow(/missing/);
  });
});

describe('apply_patch applier', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-patch-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('Add File creates a new file', async () => {
    const ctx = makeCtx(dir);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: hello.txt
+line one
+line two
*** End Patch`);
    const r = await applyParsedPatch(patch, ctx);
    expect(r.added).toEqual(['hello.txt']);
    expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('line one\nline two');
  });

  it('Update File replaces matched hunk', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'const x = 1;\nconst y = 2;\nconst z = 3;\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 const x = 1;
-const y = 2;
+const y = 42;
 const z = 3;
*** End Patch`);
    const r = await applyParsedPatch(patch, ctx);
    expect(r.updated).toEqual(['foo.ts']);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe(
      'const x = 1;\nconst y = 42;\nconst z = 3;\n',
    );
  });

  it('Delete File removes the file', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'dead.txt'), 'goodbye');
    const patch = parseApplyPatch(`*** Begin Patch
*** Delete File: dead.txt
*** End Patch`);
    const r = await applyParsedPatch(patch, ctx);
    expect(r.deleted).toEqual(['dead.txt']);
    expect(existsSync(join(dir, 'dead.txt'))).toBe(false);
  });

  it('throws when Update hunk does not match source', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'completely different content');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
-old
+new
*** End Patch`);
    await expect(applyParsedPatch(patch, ctx)).rejects.toThrow(/did not match/);
  });
});

// ─── CRLF / BOM / atomicity regression tests ─────────────────────
// These cover the "apply_patch never works on Windows" bug class: source
// files with CRLF line endings or UTF-8 BOMs would fail every multi-line
// hunk because the LF-built search string couldn't be found in the
// CRLF/BOM-preserved buffer. Also cover the avalanche scenario where
// one bad hunk in a multi-file patch left earlier files half-written.
describe('apply_patch normalization & atomicity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-patch-norm-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches hunks against CRLF source and preserves CRLF on write', async () => {
    const ctx = makeCtx(dir);
    const crlf = 'const x = 1;\r\nconst y = 2;\r\nconst z = 3;\r\n';
    writeFileSync(join(dir, 'foo.ts'), crlf);
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 const x = 1;
-const y = 2;
+const y = 42;
 const z = 3;
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    const result = readFileSync(join(dir, 'foo.ts'), 'utf8');
    expect(result).toBe('const x = 1;\r\nconst y = 42;\r\nconst z = 3;\r\n');
  });

  it('preserves CRLF on lines added by a hunk', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'a\r\nb\r\nc\r\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 a
+inserted1
+inserted2
 b
 c
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    const result = readFileSync(join(dir, 'foo.ts'), 'utf8');
    expect(result).toBe('a\r\ninserted1\r\ninserted2\r\nb\r\nc\r\n');
    // No bare \n anywhere — every newline must be CRLF.
    expect(/(?<!\r)\n/.test(result)).toBe(false);
  });

  it('preserves UTF-8 BOM on Update', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), '﻿const x = 1;\nconst y = 2;\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
-const x = 1;
+const x = 99;
 const y = 2;
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    const result = readFileSync(join(dir, 'foo.ts'), 'utf8');
    expect(result.charCodeAt(0)).toBe(0xfeff);
    expect(result).toBe('﻿const x = 99;\nconst y = 2;\n');
  });

  it('keeps BOM on Add File output when the patch emits one', async () => {
    const ctx = makeCtx(dir);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: bom.ts
+﻿export const greeting = 'hi';
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    const result = readFileSync(join(dir, 'bom.ts'), 'utf8');
    expect(result.charCodeAt(0)).toBe(0xfeff);
  });

  it('handles two files in one patch with different line endings', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'lf.ts'), 'lf-a\nlf-b\n');
    writeFileSync(join(dir, 'crlf.ts'), 'crlf-a\r\ncrlf-b\r\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: lf.ts
@@
-lf-a
+lf-A
 lf-b
*** Update File: crlf.ts
@@
-crlf-a
+crlf-A
 crlf-b
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'lf.ts'), 'utf8')).toBe('lf-A\nlf-b\n');
    expect(readFileSync(join(dir, 'crlf.ts'), 'utf8')).toBe('crlf-A\r\ncrlf-b\r\n');
  });

  it('mixed endings within one file normalize to dominant convention', async () => {
    const ctx = makeCtx(dir);
    // Two CRLF + one LF in a small file → CRLF wins (any \r\n in first 4 KB).
    writeFileSync(join(dir, 'mix.ts'), 'a\r\nb\nc\r\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: mix.ts
@@
 a
-b
+B
 c
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    const result = readFileSync(join(dir, 'mix.ts'), 'utf8');
    expect(result).toBe('a\r\nB\r\nc\r\n');
  });

  it('atomicity: multi-file patch with all valid hunks writes all files', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    writeFileSync(join(dir, 'b.ts'), 'b\n');
    writeFileSync(join(dir, 'c.ts'), 'c\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
-a
+A
*** Update File: b.ts
@@
-b
+B
*** Update File: c.ts
@@
-c
+C
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('B\n');
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe('C\n');
  });

  it('atomicity: failure in any hunk leaves every file untouched', async () => {
    // Reproduces the user's bug: a 4-file patch failed on file 3, but
    // files 1 and 2 had already been mutated. After the fix nothing
    // should be written when phase 1 finds a bad hunk.
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'a.ts'), 'a\n');
    writeFileSync(join(dir, 'b.ts'), 'b\n');
    writeFileSync(join(dir, 'c.ts'), 'c\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
-a
+A
*** Update File: b.ts
@@
-DOES_NOT_EXIST
+nope
*** Update File: c.ts
@@
-c
+C
*** End Patch`);
    await expect(applyParsedPatch(patch, ctx)).rejects.toThrow(/did not match/);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(dir, 'b.ts'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe('c\n');
  });

  it('atomicity: failure inside an Update aborts pending Add/Delete in same patch', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'doomed.ts'), 'real content\n');
    writeFileSync(join(dir, 'will-survive.ts'), 'survivor\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: newcomer.ts
+I should not exist
*** Update File: doomed.ts
@@
-no-such-line
+replacement
*** Delete File: will-survive.ts
*** End Patch`);
    await expect(applyParsedPatch(patch, ctx)).rejects.toThrow(/did not match/);
    expect(existsSync(join(dir, 'newcomer.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'doomed.ts'), 'utf8')).toBe('real content\n');
    expect(existsSync(join(dir, 'will-survive.ts'))).toBe(true);
  });

  it('move + bad hunk: original file untouched, target not created', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'src.ts'), 'original\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: src.ts
*** Move to: dest.ts
@@
-does-not-match
+nope
*** End Patch`);
    await expect(applyParsedPatch(patch, ctx)).rejects.toThrow(/did not match/);
    expect(readFileSync(join(dir, 'src.ts'), 'utf8')).toBe('original\n');
    expect(existsSync(join(dir, 'dest.ts'))).toBe(false);
  });

  it('move: write target succeeds before unlinking source', async () => {
    // Successful move case — verifies the order isn't broken by the
    // refactor. New path has content, old path is gone.
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'src.ts'), 'hello\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: src.ts
*** Move to: dest.ts
@@
-hello
+world
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    expect(existsSync(join(dir, 'src.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'dest.ts'), 'utf8')).toBe('world\n');
  });

  it('error message includes file metadata and search preview', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'line1\r\nline2\r\nline3\r\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 line1
-nope
+yes
 line3
*** End Patch`);
    let captured: Error | null = null;
    try {
      await applyParsedPatch(patch, ctx);
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).not.toBeNull();
    const msg = captured!.message;
    expect(msg).toMatch(/did not match source/);
    expect(msg).toMatch(/before=1 removed=1 after=1/);
    // Phrasing makes explicit that CRLF/BOM are normalized before matching,
    // so a reader doesn't mistake "no BOM" for a diagnostic claim.
    expect(msg).toMatch(/CRLF normalized for matching, no BOM detected/);
    expect(msg).toMatch(/Search starts with: "line1⏎nope⏎line3"/);
  });

  it('intra-file hunk cascade: second hunk searches the post-first-hunk text', async () => {
    // Guards the deliberate behavior at apply-patch.ts:340 — hunks within
    // an Update apply sequentially against a mutating buffer (matches
    // `git apply` semantics). This test fails if a refactor switches to
    // independent hunk matching against the original content.
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'alpha\nbeta\ngamma\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
-alpha
+ALPHA
@@
 ALPHA
-beta
+BETA
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe('ALPHA\nBETA\ngamma\n');
  });
});

// ─── Multi-block hunk auto-split ──────────────────────────────────
// Regression for the "apply_patch fails on standard unified-diff hunks" bug:
// a single `@@` block containing multiple change groups separated by
// unchanged context lines used to fail because the parser concatenated all
// removed lines into a contiguous block, producing a search string that
// doesn't exist in the source. The parser now auto-splits such hunks into
// linked PatchHunks; application keeps the full @@ block anchored together.
describe('apply_patch multi-block hunks', () => {
  it.each(['\n', '\r\n'])('keeps separated changes inside the anchored function (%j)', async (eol: string) => {
    // A real benchmark patch changed cloneDeep, but its final `return value`
    // was applied to cloneShallow because each split group searched from 0.
    const ctx = makeCtx(dir);
    const source = [
      'function shallow(value) {',
      '  return value;',
      '}',
      '',
      'function deep(value) {',
      '  const copied = value;',
      '',
      '  return value;',
      '}',
      '',
    ].join(eol);
    writeFileSync(join(dir, 'clone.ts'), source);
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: clone.ts
@@
 function deep(value) {
-  const copied = value;
+  const copied = structuredClone(value);

-  return value;
+  return copied;
 }
*** End Patch`);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'clone.ts'), 'utf8')).toBe(
      [
        'function shallow(value) {',
        '  return value;',
        '}',
        '',
        'function deep(value) {',
        '  const copied = structuredClone(value);',
        '',
        '  return copied;',
        '}',
        '',
      ].join(eol),
    );
  });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-patch-multiblock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('splits a hunk with two change groups separated by one context line', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'a\nb\nc\nd\ne\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 a
-b
+B
 c
-d
+D
 e
*** End Patch`);
    // Parser should have produced two hunks from this one @@ block.
    const update = patch.actions[0];
    if (update.kind !== 'update') throw new Error('expected update');
    expect(update.hunks).toHaveLength(2);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe('a\nB\nc\nD\ne\n');
  });

  it('rejects separated fragments that do not form one contiguous context block', async () => {
    const original = 'top\nold-one\nbridge\nunlisted\nold-two\nbottom\n';
    writeFileSync(join(dir, 'foo.ts'), original);
    const patch = parseApplyPatch(`*** Begin Patch
*** Add File: pending.ts
+not committed
*** Update File: foo.ts
@@
 top
-old-one
+new-one
 bridge
-old-two
+new-two
 bottom
*** End Patch`);
    await expect(applyParsedPatch(patch, makeCtx(dir))).rejects.toThrow(/did not match/);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe(original);
    expect(existsSync(join(dir, 'pending.ts'))).toBe(false);
  });

  it('carries multiple context lines between change groups as anchor', async () => {
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'a\nb\nc\nd\ne\nf\ng\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 a
-b
+B
 c
 d
 e
-f
+F
 g
*** End Patch`);
    const update = patch.actions[0];
    if (update.kind !== 'update') throw new Error('expected update');
    expect(update.hunks).toHaveLength(2);
    // Second hunk's contextBefore carries the 3-line bridge as anchor.
    expect(update.hunks[1].contextBefore).toEqual(['c', 'd', 'e']);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe('a\nB\nc\nd\ne\nF\ng\n');
  });

  it('splits add-only multi-block hunks', async () => {
    // Hunk inserts at two distinct points; no removals at all. Split must
    // fire on the second `+` even though the first change group had no `-`.
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'a\nb\nc\nd\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 a
+inserted1
 b
 c
+inserted2
 d
*** End Patch`);
    const update = patch.actions[0];
    if (update.kind !== 'update') throw new Error('expected update');
    expect(update.hunks).toHaveLength(2);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe(
      'a\ninserted1\nb\nc\ninserted2\nd\n',
    );
  });

  it('handles three mixed change groups in one @@ block', async () => {
    // Adversarial: remove+add, add-only, remove+add — all in a single hunk.
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 a
-b
+B
 c
+inserted
 d
 e
-f
+F
 g
 h
*** End Patch`);
    const update = patch.actions[0];
    if (update.kind !== 'update') throw new Error('expected update');
    expect(update.hunks).toHaveLength(3);
    await applyParsedPatch(patch, ctx);
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe(
      'a\nB\nc\ninserted\nd\ne\nF\ng\nh\n',
    );
  });

  it('still throws when a removed line genuinely does not exist', async () => {
    // Split must not silently swallow real mismatches — the split logic
    // depends on context lines after a +/-, so a "broken" hunk where the
    // removed text is wrong should still fail loudly.
    const ctx = makeCtx(dir);
    writeFileSync(join(dir, 'foo.ts'), 'alpha\nbeta\ngamma\n');
    const patch = parseApplyPatch(`*** Begin Patch
*** Update File: foo.ts
@@
 alpha
-DOES_NOT_EXIST
+nope
 gamma
*** End Patch`);
    await expect(applyParsedPatch(patch, ctx)).rejects.toThrow(/did not match/);
    // File untouched (atomicity guarantee).
    expect(readFileSync(join(dir, 'foo.ts'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
});

describe('apply_patch tool handler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-patch-tool-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts patch via `patch` arg (function-tool path)', async () => {
    const ctx = makeCtx(dir);
    const result = await applyPatchTool.handler(
      {
        patch: `*** Begin Patch
*** Add File: x.txt
+hi
*** End Patch`,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, 'x.txt'))).toBe(true);
  });

  it('accepts patch via `_raw` arg (custom-tool path)', async () => {
    const ctx = makeCtx(dir);
    const result = await applyPatchTool.handler(
      {
        _raw: `*** Begin Patch
*** Add File: y.txt
+raw
*** End Patch`,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(existsSync(join(dir, 'y.txt'))).toBe(true);
  });

  it('returns isError when patch is empty', async () => {
    const r = await applyPatchTool.handler({}, makeCtx(dir));
    expect(r.isError).toBe(true);
  });
});

describe('chatgpt provider sends apply_patch in correct shape', () => {
  const baseReq: ChatRequest = {
    messages: [],
    system: 'sys',
    tools: [
      {
        name: 'apply_patch',
        description: 'apply codex patch',
        parameters: {
          type: 'object',
          properties: { patch: { type: 'string' } },
          required: ['patch'],
        },
      },
      {
        name: 'read_file',
        description: 'read',
        parameters: { type: 'object', properties: {} },
      },
    ],
  };

  function makeProvider(applyPatchToolType: string | null) {
    const provider = new ChatGPTCodexProvider({
      apiKey: 'tok',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      accountId: 'acct',
      model: 'gpt-5.5',
      applyPatchToolType,
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        events({ type: 'response.completed', response: { usage: {}, status: 'completed' } }),
      );
    (provider as unknown as { client: { responses: { create: typeof create } } }).client = {
      responses: { create },
    };
    return { provider, create };
  }

  it('sends apply_patch as type:custom when applyPatchToolType=freeform', async () => {
    const { provider, create } = makeProvider('freeform');
    for await (const _ of provider.chat(baseReq)) {
      void _;
    }
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    const tools = args.tools as Array<{ type: string; name: string; parameters?: unknown }>;
    const patchTool = tools.find((t) => t.name === 'apply_patch');
    expect(patchTool?.type).toBe('custom');
    expect(patchTool?.parameters).toBeUndefined();
    const readTool = tools.find((t) => t.name === 'read_file');
    expect(readTool?.type).toBe('function');
  });

  it('sends apply_patch as type:function when applyPatchToolType is null', async () => {
    const { provider, create } = makeProvider(null);
    for await (const _ of provider.chat(baseReq)) {
      void _;
    }
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    const tools = args.tools as Array<{ type: string; name: string; parameters?: unknown }>;
    const patchTool = tools.find((t) => t.name === 'apply_patch');
    expect(patchTool?.type).toBe('function');
    expect(patchTool?.parameters).toBeDefined();
  });
});

// ─── boilerplate for vitest globals ───
import { beforeEach, afterEach } from 'vitest';
