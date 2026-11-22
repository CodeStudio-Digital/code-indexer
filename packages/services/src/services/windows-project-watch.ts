import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isProjectDiscoveryMarker } from '@mcp/shared/utils/project-ignore.js';
import { TREE_BLOCK } from '@mcp/shared/utils/fs-ignore.js';
import type { WatcherFileEvent } from './watcher.js';

interface NativeWatchOptions {
  root: string;
  debounce: number;
  fileChanged(event: WatcherFileEvent): void;
  indexedDescendants(absolutePath: string): boolean;
  ignores(relativePath: string, directory: boolean): boolean;
  coverageLost(): void;
  failed(error: Error): void;
}

/** One Windows directory handle covers the whole tree. Resolve rename hints
 * after coalescing: an atomic save can report the same name more than once. */
export function watchWindowsProject(options: NativeWatchOptions) {
  const pending = new Map<string, boolean>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let uncertain = false;
  let closed = false;
  let coverage = {};
  const invalidate = () => {
    if (uncertain) return;
    coverage = {};
    uncertain = true;
  };
  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    while (inFlight) await inFlight;
    if (closed || (!pending.size && !uncertain)) return;
    const batch = [...pending];
    pending.clear();
    inFlight = (async () => {
      for (let i = 0; i < batch.length && !closed; i += 32) {
        await Promise.all(batch.slice(i, i + 32).map(async ([name, renamed]) => {
          const path = join(options.root, name);
          try {
            const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
              if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
              throw err;
            });
            if (closed) return;
            const isDir = st?.isDirectory() ?? (renamed && options.indexedDescendants(path));
            if (isProjectDiscoveryMarker(name)) invalidate();
            if (options.ignores(name, isDir)) return;
            if ((renamed && isDir) || st?.isSymbolicLink()) invalidate();
            if (!st || st.isFile() || isDir) options.fileChanged({ path, kind: st ? 'upsert' : 'delete', isDir });
          } catch {
            if (!closed) invalidate();
          }
        }));
      }
      if (uncertain && !closed) {
        uncertain = false;
        options.coverageLost();
      }
    })();
    try { await inFlight; } finally { inFlight = undefined; }
  };
  const handle = watch(options.root, { recursive: true, persistent: false }, (event, filename) => {
    if (closed) return;
    const name = filename?.replace(/\\/g, '/');
    if (!name || isAbsolute(name) || name.split('/').includes('..')) invalidate();
    else if (name === '.gitignore' || name === '.mcpindexignore') invalidate();
    else if (name.split('/').some(part => part.startsWith('.') || TREE_BLOCK.has(part.toLowerCase()))) return;
    else if (pending.size >= 2048) invalidate();
    else pending.set(name, event === 'rename' || pending.get(name) === true);
    if (!timer) timer = setTimeout(() => { void flush().catch(options.failed); }, options.debounce);
  });
  handle.on('error', options.failed);
  return {
    flush,
    get coverage() { return coverage; },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      pending.clear();
      handle.close();
    },
  };
}
