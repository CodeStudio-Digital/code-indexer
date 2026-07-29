/**
 * End-to-end for the archive worker: it must actually spawn, produce a real
 * zip, round-trip it, report progress, and refuse a hostile archive — all
 * without the caller ever touching adm-zip on this thread.
 *
 * Uses the real filesystem in a temp dir (no DB, so unaffected by the
 * better-sqlite3 ABI mismatch that blocks the store-backed suites).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { runArchiveJob, runArchiveJobToEnd, cancelArchive, ArchiveError } from '../archive-runner.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-archive-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const p = (...parts: string[]) => path.join(dir, ...parts);

async function seed(): Promise<string> {
  const src = p('src');
  await fs.mkdir(path.join(src, 'nested'), { recursive: true });
  await fs.writeFile(path.join(src, 'a.txt'), 'hello');
  await fs.writeFile(path.join(src, 'nested', 'b.txt'), 'world');
  return src;
}

describe('archive worker (off the main thread)', () => {
  it('zips a folder and round-trips it back to identical content', async () => {
    const src = await seed();
    const out = p('out.zip');

    const zipped = await runArchiveJobToEnd('t1', { kind: 'archive', roots: [src], out });
    expect(zipped.files).toBe(2);
    expect(zipped.bytes).toBe('hello'.length + 'world'.length);
    expect((await fs.stat(out)).size).toBeGreaterThan(0);

    const dest = p('dest');
    const extracted = await runArchiveJobToEnd('t2', { kind: 'extract', zip: out, dest });
    expect(extracted.files).toBe(2);
    // The folder went in under its own basename, so it comes back out under it.
    expect(await fs.readFile(path.join(dest, 'src', 'a.txt'), 'utf8')).toBe('hello');
    expect(await fs.readFile(path.join(dest, 'src', 'nested', 'b.txt'), 'utf8')).toBe('world');
  }, 30_000);

  it('reports progress and ends with a done frame carrying the final totals', async () => {
    const src = await seed();
    const frames = [];
    for await (const f of runArchiveJob('t3', { kind: 'archive', roots: [src], out: p('o.zip') })) frames.push(f);

    expect(frames.length).toBeGreaterThan(0);
    const last = frames[frames.length - 1];
    expect(last.done).toBe(true);
    expect(last.files).toBe(2);
    // Totals are known up front, so a determinate progress bar is possible.
    expect(frames[0].totalFiles).toBe(2);
    // Monotonic — a jumping bar would mean dropped or reordered frames.
    for (let i = 1; i < frames.length; i++) expect(frames[i].files).toBeGreaterThanOrEqual(frames[i - 1].files);
  }, 30_000);

  it('surfaces a typed error instead of hanging when the zip is unreadable', async () => {
    await fs.writeFile(p('not.zip'), 'definitely not a zip');
    await expect(runArchiveJobToEnd('t4', { kind: 'extract', zip: p('not.zip'), dest: p('d') })).rejects.toThrow(
      ArchiveError,
    );
  }, 30_000);

  it('enforces the archive budget inside the worker, before compressing', async () => {
    const src = await seed();
    await expect(
      runArchiveJobToEnd('t5', {
        kind: 'archive',
        roots: [src],
        out: p('capped.zip'),
        limits: { maxTotalBytes: 1, maxEntryBytes: 1, maxEntries: 100, maxCompressionRatio: 1000 },
      }),
    ).rejects.toMatchObject({ code: 'archive_entry_too_large' });
  }, 30_000);

  it('cancel ends the job without throwing, and cancelling an unknown id is a no-op', async () => {
    const src = await seed();
    const iter = runArchiveJob('t6', { kind: 'archive', roots: [src], out: p('c.zip') });
    // Cancel as soon as the worker is registered; the job may already have
    // finished (it is tiny), so the contract under test is "no throw either way".
    const frames = [];
    for await (const f of iter) {
      frames.push(f);
      cancelArchive('t6');
    }
    expect(cancelArchive('does-not-exist')).toBe(false);
  }, 30_000);

  it('does not follow symlinks out of the tree', async () => {
    const src = await seed();
    const outside = p('outside-secret.txt');
    await fs.writeFile(outside, 'SECRET');
    let linked = true;
    try {
      await fs.symlink(outside, path.join(src, 'link.txt'));
    } catch {
      linked = false; // Windows without developer mode — nothing to assert
    }
    if (!linked) return;

    const out = p('sym.zip');
    const res = await runArchiveJobToEnd('t7', { kind: 'archive', roots: [src], out });
    // Only the two real files; the link is skipped rather than inlining SECRET.
    expect(res.files).toBe(2);
  }, 30_000);
});
