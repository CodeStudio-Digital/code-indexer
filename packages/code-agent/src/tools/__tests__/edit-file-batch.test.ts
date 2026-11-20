/**
 * edit_file `edits`: several find/replace operations on one file, applied
 * sequentially on a buffer, all validated, written once only when every one
 * matches (the engine of the retired multi_edit tool). The single-change form is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../core/tool.js';
import { defaultLocalFilesystemPort } from '../../ports/filesystem-port.js';
import { fsTools } from '../fs.js';
import { normalizeKimiToolParameters } from '../../providers/kimi-code-messages.js';

const editFile = fsTools.find(t => t.name === 'edit_file')!;
let root: string;
let ctx: ToolContext;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edit-batch-'));
  ctx = { cwd: root, projectName: 'eb' } as ToolContext;
  writeFileSync(join(root, 'a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const disk = () => readFileSync(join(root, 'a.ts'), 'utf8');
const batch = (edits: unknown, extra: Record<string, unknown> = {}, c: ToolContext = ctx) =>
  editFile.handler({ path: 'a.ts', edits, ...extra }, c);

describe('edit_file edits (atomic batch)', () => {
  it('applies every edit and writes once', async () => {
    const local = defaultLocalFilesystemPort();
    const writeFile = vi.fn((p: string, d: string) => local.writeFile(p, d));
    const port = new Proxy(local, { get: (t, k) => (k === 'writeFile' ? writeFile : Reflect.get(t, k)) });
    const res = await batch([
      { old_string: 'const a = 1;', new_string: 'const a = 10;' },
      { old_string: 'const c = 3;', new_string: 'const c = 30;' },
    ], {}, { ...ctx, ports: { fs: port } } as ToolContext);
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/2 edits applied atomically/);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(disk()).toBe('const a = 10;\nconst b = 2;\nconst c = 30;\n');
  });

  it('writes nothing when one edit in the middle fails, and reports every failure', async () => {
    const res = await batch([
      { old_string: 'const a = 1;', new_string: 'const a = 10;' },
      { old_string: 'missing one', new_string: 'x' },
      { old_string: 'missing two', new_string: 'y' },
    ]);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/edit_file aborted: 2 of 3 edits failed\. Nothing was written to disk/);
    expect(res.content).toMatch(/#2: FAILED/);
    expect(res.content).toMatch(/#3: FAILED/);
    expect(res.content).toMatch(/#1: would succeed/);
    expect(disk()).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
  });

  it('applies edit N to the result of edit N-1', async () => {
    const res = await batch([
      { old_string: 'const b = 2;', new_string: 'const b = 20;' },
      { old_string: 'const b = 20;', new_string: 'const b = 200;' },
    ]);
    expect(res.isError).toBeFalsy();
    expect(disk()).toContain('const b = 200;');
  });

  it('keeps the single-change form byte-for-byte', async () => {
    const res = await editFile.handler({ path: 'a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, ctx);
    expect(res.content).toBe('Edited a.ts (1 replacement)');
    expect((await editFile.handler({ path: 'a.ts', old_string: '', new_string: 'x' }, ctx)).content).toBe('old_string cannot be empty');
  });

  it('rejects both forms together, neither form, and an empty or oversized edits list', async () => {
    const both = await batch([{ old_string: 'const a = 1;', new_string: 'z' }], { old_string: 'const a = 1;', new_string: 'z' });
    expect(both.isError).toBe(true);
    expect(both.content).toMatch(/either old_string\/new_string .* or edits/i);
    const neither = await editFile.handler({ path: 'a.ts' }, ctx);
    expect(neither.isError).toBe(true);
    expect(neither.content).toMatch(/old_string\/new_string .* or edits/i);
    expect((await batch([])).content).toMatch(/edits must be a non-empty array/);
    expect((await batch('not a list')).content).toMatch(/edits must be a non-empty array/);
    expect((await batch(Array.from({ length: 51 }, () => ({ old_string: 'a', new_string: 'b' })))).content).toMatch(/max 50/);
    expect(disk()).toBe('const a = 1;\nconst b = 2;\nconst c = 3;\n');
  });

  it('declares edits in the schema without oneOf/anyOf and without requiring old_string', () => {
    const schema = editFile.parameters as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['path']);
    expect(schema.properties).toHaveProperty('edits');
    expect(JSON.stringify(schema)).not.toMatch(/"(oneOf|anyOf|allOf)"/);
    // The item shape the retired multi_edit shipped to every provider family.
    expect((schema.properties.edits as { items: unknown }).items).toEqual({
      type: 'object',
      properties: {
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Default false. When true, every match of old_string is replaced.' },
      },
      required: ['old_string', 'new_string'],
    });
    const kimi = normalizeKimiToolParameters(editFile.parameters) as { properties: Record<string, unknown> };
    expect(Object.keys(kimi.properties)).toEqual(expect.arrayContaining(['path', 'old_string', 'new_string', 'edits']));
  });
});
