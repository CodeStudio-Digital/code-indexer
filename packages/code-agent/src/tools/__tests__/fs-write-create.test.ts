/**
 * write_file — basic contracts. write_file is the only create/replace tool
 * (create_file was retired): a new path is created exclusively where the port
 * offers createFile, and an existing path the session does not know is refused
 * with nothing written. The refusal is the exact string code_exec scripts see,
 * so it is pinned here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';
import { SessionFileKnowledge } from '../file-knowledge.js';
import { defaultLocalFilesystemPort, type IFilesystemPort } from '../../ports/filesystem-port.js';

const writeFile = fsTools.find((t) => t.name === 'write_file')!;

let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-write-'));
  ctx = { cwd: root, projectName: 'fs-write-test', fileKnowledge: new SessionFileKnowledge() } as ToolContext;
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

  it('overwrites an existing file the session has read (unread overwrites are refused)', async () => {
    writeFileSync(join(root, 'x.txt'), 'old');
    expect((await writeFile.handler({ path: 'x.txt', content: 'new' }, ctx)).isError).toBe(true);
    await fsTools.find((t) => t.name === 'read_file')!.handler({ path: 'x.txt' }, ctx);
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

describe('write_file creation (formerly create_file)', () => {
  const REFUSAL = 'write_file refused: exists.md already exists and this session has not read it, ' +
    'so its current content is unknown. Nothing was written. Read it with read_file, then repeat the call; ' +
    'for a targeted change use edit_file.';
  const withPort = (overrides: Partial<IFilesystemPort>): ToolContext => {
    const local = defaultLocalFilesystemPort();
    const port = new Proxy(local, { get: (t, k) => (k in overrides ? overrides[k as keyof IFilesystemPort] : Reflect.get(t, k)) });
    return { ...ctx, ports: { fs: port } } as ToolContext;
  };

  it('creates a new file', async () => {
    const res = await writeFile.handler({ path: 'fresh.ts', content: 'hello' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe('Wrote fresh.ts (1 lines, 5 bytes)');
  });

  it('refuses an existing unread file with the exact message and leaves it untouched (code_exec telemetry case)', async () => {
    writeFileSync(join(root, 'exists.md'), 'already here');
    const res = await writeFile.handler({ path: 'exists.md', content: 'clobber attempt' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toBe(REFUSAL);
    expect(readFileSync(join(root, 'exists.md'), 'utf8')).toBe('already here'); // untouched
  });

  it('allows exactly one concurrent creator and preserves its complete UTF-8 content', async () => {
    const contents = Array.from({ length: 16 }, (_, i) => `${i}:😀`.repeat(100));
    const results = await Promise.all(contents.map(content => writeFile.handler({ path: 'race.txt', content }, ctx)));
    const winners = results.map((r, i) => !r.isError ? i : -1).filter(i => i >= 0);
    expect(winners).toHaveLength(1);
    expect(readFileSync(join(root, 'race.txt'), 'utf8')).toBe(contents[winners[0]]);
    expect(results[winners[0]].content).toContain(`${Buffer.byteLength(contents[winners[0]], 'utf8')} bytes`);
    for (const [i, r] of results.entries()) {
      if (i !== winners[0]) expect(r.content).toMatch(/^write_file refused: race\.txt .*Nothing was written\./);
    }
  });

  it('does not create a parent directory or file after pre-cancellation', async () => {
    await expect(writeFile.handler({ path: 'cancelled/file.txt', content: 'no' }, { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
    expect(existsSync(join(root, 'cancelled'))).toBe(false);
  });

  it('creates through the port createFile, never writeFile, when the path is new', async () => {
    const local = defaultLocalFilesystemPort();
    const createFile = vi.fn((p: string, d: string) => local.createFile!(p, d));
    const plainWrite = vi.fn((p: string, d: string) => local.writeFile(p, d));
    const res = await writeFile.handler({ path: 'new.txt', content: 'x' }, withPort({ createFile, writeFile: plainWrite }));
    expect(res.isError).toBeFalsy();
    expect(createFile).toHaveBeenCalledTimes(1);
    expect(plainWrite).not.toHaveBeenCalled();
  });

  it('refuses when a code-less exclusive-create failure leaves the path existing (sandbox adapter)', async () => {
    const createFile = vi.fn(async (p: string) => {
      writeFileSync(p, 'other writer');
      throw new Error('Sandbox exclusive creation failed (1): exists');
    });
    const res = await writeFile.handler({ path: 'exists.md', content: 'mine' }, withPort({ createFile }));
    expect(res.content).toBe(REFUSAL);
    expect(readFileSync(join(root, 'exists.md'), 'utf8')).toBe('other writer');
  });

  it('rethrows an exclusive-create failure when the path still does not exist', async () => {
    const createFile = vi.fn(async () => { throw new Error('disk full'); });
    await expect(writeFile.handler({ path: 'nope.txt', content: 'x' }, withPort({ createFile }))).rejects.toThrow('disk full');
    expect(existsSync(join(root, 'nope.txt'))).toBe(false);
  });

  it('falls back to a plain write where the port has no createFile', async () => {
    const plainWrite = vi.fn((p: string, d: string) => defaultLocalFilesystemPort().writeFile(p, d));
    const res = await writeFile.handler({ path: 'legacy.txt', content: 'x' }, withPort({ createFile: undefined, writeFile: plainWrite }));
    expect(res.isError).toBeFalsy();
    expect(plainWrite).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'legacy.txt'), 'utf8')).toBe('x');
  });
});
