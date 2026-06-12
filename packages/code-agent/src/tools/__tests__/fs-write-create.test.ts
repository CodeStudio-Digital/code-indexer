/**
 * write_file / create_file — basic contracts. The create_file-on-existing
 * error is the exact string that killed a whole code_exec script in
 * telemetry ("File X already exists"), so it's pinned here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';

const writeFile = fsTools.find((t) => t.name === 'write_file')!;
const createFile = fsTools.find((t) => t.name === 'create_file')!;

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-write-'));
  ctx = { cwd: root, projectName: 'fs-write-test' } as ToolContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('write_file', () => {
  it('writes content, creating parent directories, and reports size', async () => {
    const res = await writeFile.handler(
      { path: 'deep/nested/file.md', content: 'one\ntwo' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('Wrote deep/nested/file.md (2 lines, 7 bytes)');
    expect(readFileSync(join(root, 'deep/nested/file.md'), 'utf8')).toBe('one\ntwo');
  });

  it('overwrites an existing file silently (that is its contract)', async () => {
    writeFileSync(join(root, 'x.txt'), 'old');
    const res = await writeFile.handler({ path: 'x.txt', content: 'new' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, 'x.txt'), 'utf8')).toBe('new');
  });

  it('refuses paths outside the project root', async () => {
    const res = await writeFile.handler({ path: '../escape.txt', content: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('outside project root');
    expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false);
  });
});

describe('create_file', () => {
  it('creates a new file', async () => {
    const res = await createFile.handler({ path: 'fresh.ts', content: 'hello' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('Created fresh.ts (5 bytes)');
  });

  it('refuses an existing file with the exact redirect message (code_exec telemetry case)', async () => {
    writeFileSync(join(root, 'exists.md'), 'already here');
    const res = await createFile.handler({ path: 'exists.md', content: 'clobber attempt' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('File exists.md already exists. Use write_file or edit_file to modify it.');
    expect(readFileSync(join(root, 'exists.md'), 'utf8')).toBe('already here'); // untouched
  });
});
