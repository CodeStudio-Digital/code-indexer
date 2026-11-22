import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { watchWindowsProject } from '../windows-project-watch.js';

it.runIf(process.platform === 'win32')('tracks creations, edits and both rename paths, and recovers directory moves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-project-watch-'));
  const first = join(root, 'first.ts');
  const second = join(root, 'second.ts');
  const events = vi.fn();
  const lost = vi.fn();
  const failed = vi.fn();
  const watcher = watchWindowsProject({ root, debounce: 15, fileChanged: events, coverageLost: lost,
    indexedDescendants: () => false, ignores: () => false, failed });
  try {
    const watch = watcher.coverage;
    writeFileSync(first, 'first');
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ path: first, kind: 'upsert', isDir: false }));
    events.mockClear();
    writeFileSync(first, 'second');
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ path: first, kind: 'upsert', isDir: false }));
    renameSync(first, second);
    await vi.waitFor(() => {
      expect(events).toHaveBeenCalledWith({ path: first, kind: 'delete', isDir: false });
      expect(events).toHaveBeenCalledWith({ path: second, kind: 'upsert', isDir: false });
    });
    rmSync(second);
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ path: second, kind: 'delete', isDir: false }));
    expect(watcher.coverage).toBe(watch);
    mkdirSync(join(root, '.mcp-indexer'));
    writeFileSync(join(root, '.mcp-indexer', 'index.db-wal'), '');
    mkdirSync(join(root, 'subdir'));
    await vi.waitFor(() => expect(lost).toHaveBeenCalled());
    expect(watcher.coverage).not.toBe(watch);
    expect(events.mock.calls.flat().some(event => event.path.includes('.mcp-indexer'))).toBe(false);
    expect(failed).not.toHaveBeenCalled();
  } finally { watcher.close(); rmSync(root, { recursive: true, force: true }); }
});
