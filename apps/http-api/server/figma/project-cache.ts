import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { atomicWriteFile } from '@mcp/session-storage';
import { abortableRead } from '@mcp/shared/utils/abortable.js';

const PROJECT_BYTES = 128 * 1024 * 1024;
const PROJECT_ENTRIES = 192;
const ENTRY_BYTES = 18 * 1024 * 1024;
const ENTRY_NAME = /^[0-9a-f]{24}-[0-9a-f]{32}\.json$/;

export interface CacheScope {
  dir: string;
  filePrefix: string;
  assertCurrent(): void;
}

export interface Cached<T> {
  savedAt: number;
  value: T;
}

export interface TreeCoverage {
  root: string | null;
  depth: number;
  nodes: Record<string, number>;
}

type IndexedTree = Cached<TreeCoverage> & { key: string };

interface PendingRead {
  controller: AbortController;
  result: Promise<unknown>;
  waiters: number;
}

export class FigmaProjectCache {
  private readonly root: string;
  private readonly pending = new Map<string, PendingRead>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(root: string) { this.root = resolve(root); }

  scope(projectId: unknown, revision: string, fileKey: string, assertCurrent: () => void): CacheScope | null {
    if (typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId <= 0) return null;
    return { dir: join(this.root, hash(revision), String(projectId)), filePrefix: hash(fileKey).slice(0, 24), assertCurrent };
  }

  private entryPath(scope: CacheScope, key: string): string {
    return join(scope.dir, scope.filePrefix + '-' + hash(key).slice(0, 32));
  }

  async read<T>(scope: CacheScope | null, key: string): Promise<Cached<T> | null> {
    if (!scope) return null;
    const entry = await readJson<Cached<T>>(this.entryPath(scope, key) + '.json');
    return validEntry(entry) ? entry : null;
  }

  /** Coverage sidecars stay small, so looking for a cached child never loads unrelated tree bodies. */
  async trees(scope: CacheScope | null): Promise<IndexedTree[]> {
    if (!scope) return [];
    const names = await readdir(scope.dir).catch((): string[] => []);
    const matches = names.filter(name => name.startsWith(scope.filePrefix + '-') && name.endsWith('.tree'));
    const entries = await Promise.all(matches.map(name => readJson<IndexedTree>(join(scope.dir, name))));
    return entries.filter((entry): entry is IndexedTree => validEntry(entry) && typeof entry.key === 'string' && !!entry.value?.nodes)
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async write<T>(scope: CacheScope | null, key: string, entry: Cached<T>, tree?: TreeCoverage): Promise<void> {
    if (!scope) return;
    const write = (this.writes.get(scope.dir) ?? Promise.resolve()).then(async () => {
      scope.assertCurrent();
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload) > ENTRY_BYTES) return;
      const path = this.entryPath(scope, key);
      if (tree) {
        const previous = await readJson<IndexedTree>(path + '.tree');
        // Overlapping reads at different depths must not discard already saved descendants.
        if (validEntry(previous) && previous.value?.depth > tree.depth) return;
      }
      await mkdir(scope.dir, { recursive: true });
      const options = { beforePublish: scope.assertCurrent };
      await atomicWriteFile(path + '.json', payload, options);
      if (tree) {
        await atomicWriteFile(path + '.tree', JSON.stringify({ key, savedAt: entry.savedAt, value: tree }), options);
      }
      await prune(scope.dir);
    }).catch(() => { /* Cache write failures are recoverable; the live read still works. */ });
    this.writes.set(scope.dir, write);
    try { await write; }
    finally { if (this.writes.get(scope.dir) === write) this.writes.delete(scope.dir); }
  }

  async load<T>(scope: CacheScope | null, key: string, signal: AbortSignal, fetch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (!scope) return fetch(signal);
    const id = this.entryPath(scope, key);
    let job = this.pending.get(id);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const current: PendingRead = { controller, waiters: 0, result: Promise.resolve().then(() => fetch(controller.signal)) };
      this.pending.set(id, current);
      void current.result.finally(() => {
        if (this.pending.get(id) === current) this.pending.delete(id);
      }).catch(() => {});
      job = current;
    }
    const active = job;
    active.waiters++;
    try { return await abortableRead(() => active.result as Promise<T>, signal); }
    finally {
      if (--active.waiters === 0 && this.pending.get(id) === active) active.controller.abort();
    }
  }

  async retire(revision: string): Promise<void> {
    const dir = resolve(this.root, hash(revision));
    if (dirname(dir) !== this.root || !/^[a-f0-9]{64}$/.test(basename(dir))) return;
    const prefix = dir + sep;
    for (const [key, pending] of this.pending) if (key.startsWith(prefix)) pending.controller.abort();
    await Promise.all([...this.writes].filter(([path]) => path.startsWith(prefix)).map(([, write]) => write));
    await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function validEntry<T>(entry: Cached<T> | null): entry is Cached<T> {
  return !!entry && Number.isFinite(entry.savedAt) && Object.hasOwn(entry, 'value');
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch { return null; }
}

async function prune(dir: string): Promise<void> {
  const listing = await readdir(dir, { withFileTypes: true });
  const live = new Set(listing.filter(file => file.isFile() && ENTRY_NAME.test(file.name)).map(file => file.name));
  const entries = (await Promise.all([...live].map(async name => {
    const info = await stat(join(dir, name)).catch(() => null);
    return info ? { name, modified: info.mtimeMs, size: info.size } : null;
  }))).filter(entry => entry != null).sort((a, b) => b.modified - a.modified);
  let used = 0;
  const removed = entries.filter((entry, index) => {
    used += entry.size;
    return used > PROJECT_BYTES || index >= PROJECT_ENTRIES;
  });
  for (const entry of removed) live.delete(entry.name);
  const orphanedTrees = listing.filter(file => file.isFile() && file.name.endsWith('.tree')
    && ENTRY_NAME.test(file.name.slice(0, -5) + '.json') && !live.has(file.name.slice(0, -5) + '.json'));
  await Promise.allSettled([...removed, ...orphanedTrees].map(file => unlink(join(dir, file.name))));
}
