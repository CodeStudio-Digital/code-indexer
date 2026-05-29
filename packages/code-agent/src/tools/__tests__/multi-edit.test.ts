/**
 * multi_edit DX tests — atomic full-validation behaviour.
 *
 * Contract (post PR after session 798's write_stdin loop diagnosis):
 *   - All-or-nothing on disk (atomic).
 *   - When ANY edit fails, NONE are written and the error reports
 *     EVERY problem so the agent fixes them all in one round-trip.
 *   - Edits AFTER the first failure are flagged as
 *     `dependsOnPrior=true` (in the message text) when they were
 *     evaluated against an unchanged rolling buffer.
 *   - The "not unique" message warns the agent explicitly about the
 *     risk of using `replace_all=true` blindly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { multiEdit } from '@mcp/code-agent/tools/fs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

let dir: string;
function ctx(): ToolContext {
  return { cwd: dir, projectName: 'multi-edit-test' };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'multi-edit-'));
});

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seed(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return name;
}

describe('multi_edit — happy path', () => {
  it('applies a sequence of independent edits and writes once', async () => {
    const file = seed('a.txt', 'alpha\nbeta\ngamma\n');
    const r = await multiEdit.handler({
      path: file,
      edits: [
        { old_string: 'alpha', new_string: 'ALPHA' },
        { old_string: 'gamma', new_string: 'GAMMA' },
      ],
    }, ctx());
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, file), 'utf-8')).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  it('applies dependent edits in order (rolling buffer)', async () => {
    const file = seed('b.txt', 'X');
    const r = await multiEdit.handler({
      path: file,
      edits: [
        { old_string: 'X', new_string: 'Y' },
        { old_string: 'Y', new_string: 'Z' },
      ],
    }, ctx());
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, file), 'utf-8')).toBe('Z');
  });
});

describe('multi_edit — full-validation failure path', () => {
  it('reports EVERY independent failure in a single response', async () => {
    const file = seed('c.txt', 'dup\nother\ndup\nfoo\n');
    // edit #1: not unique — should fail with the new warning.
    // edit #2: independent, valid (would succeed against the unchanged
    //   rolling buffer since #1 didn't advance it).
    // edit #3: independent, NOT FOUND — should also fail.
    const r = await multiEdit.handler({
      path: file,
      edits: [
        { old_string: 'dup', new_string: 'DUP' },
        { old_string: 'foo', new_string: 'FOO' },
        { old_string: 'absent_token', new_string: '!' },
      ],
    }, ctx());
    expect(r.isError).toBe(true);
    // Summary header counts failures correctly.
    expect(r.content).toContain('2 of 3 edit');
    // Per-edit verdict lines.
    expect(r.content).toContain('#1: FAILED');
    expect(r.content).toContain('not unique');
    expect(r.content).toContain('#2: would succeed');
    expect(r.content).toContain('#3: FAILED');
    expect(r.content).toContain('old_string not found');
    // Original file untouched (atomic).
    expect(readFileSync(join(dir, file), 'utf-8')).toBe('dup\nother\ndup\nfoo\n');
  });

  it('flags downstream edits as "may also be a downstream effect"', async () => {
    const file = seed('d.txt', 'A\n');
    // edit #1: A → B (succeeds — would advance buffer).
    // edit #2: missing source — fails.
    // edit #3: B → C (depends on #1; will be evaluated against the
    //   not-yet-advanced buffer since #2 came between and rolled forward).
    //
    // Actually: #1 IS valid; buffer advances. #2 fails (firstFailIdx
    // becomes 2). #3 sees buffer = 'B\n' and would succeed (B → C).
    // To force a dependent verdict we need edit #2 to be downstream of
    // #1 and fail. Restructure: #1 succeed, #2 fail, #3 depends.
    const r = await multiEdit.handler({
      path: file,
      edits: [
        { old_string: 'A', new_string: 'B' },
        { old_string: 'nope', new_string: '!' },        // forces fail
        { old_string: 'C', new_string: 'D' },           // would only succeed AFTER a third edit B→C, which doesn't exist; this fails too
      ],
    }, ctx());
    expect(r.isError).toBe(true);
    // edit #3's failure should mention the downstream caveat.
    const block = r.content.split('\n').find((l) => l.startsWith('  #3:'));
    expect(block).toBeDefined();
    expect(block).toContain('downstream effect');
  });

  it('uses the new "replace_all" warning that flags the silent-mass-edit risk', async () => {
    const file = seed('e.txt', 'dup\ndup\ndup\n');
    const r = await multiEdit.handler({
      path: file,
      edits: [{ old_string: 'dup', new_string: 'X' }],
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('PREFERRED: add surrounding context');
    expect(r.content).toContain('ONLY if you actually want to replace ALL');
    // Mentions the actual occurrence count.
    expect(r.content).toContain('3 occurrences');
  });
});

describe('multi_edit — atomicity', () => {
  it('never partially writes when any edit fails', async () => {
    const original = 'hello\nworld\n';
    const file = seed('f.txt', original);
    const r = await multiEdit.handler({
      path: file,
      edits: [
        { old_string: 'hello', new_string: 'HELLO' }, // would succeed
        { old_string: 'absent', new_string: 'X' },    // would fail
      ],
    }, ctx());
    expect(r.isError).toBe(true);
    expect(readFileSync(join(dir, file), 'utf-8')).toBe(original);
  });
});
