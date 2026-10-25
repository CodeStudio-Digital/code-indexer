import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { watch } from 'node:fs';
import { atomicWriteFile, fsyncDirectory } from '../atomic-file.js';

export const keyOf = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Immutable publication is atomic and never replaces another writer's record. */
export class CollaborationFiles {
  constructor(readonly root: string) {}
  async init(): Promise<void> {
    for (const name of ['participants', 'messages', 'receipts', 'links', 'waits', 'policies', 'checkpoints', 'networks', 'triggers', 'completions', 'spawn-slots', 'wake-slots']) {
      await mkdir(join(this.root, name), { recursive: true });
    }
  }
  path(kind: string, key: string): string { return join(this.root, kind, `${keyOf(key)}.json`); }
  async get<T>(kind: string, key: string): Promise<T | null> {
    return this.read<T>(this.path(kind, key));
  }
  async read<T>(path: string): Promise<T | null> {
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async put(kind: string, key: string, value: unknown): Promise<void> {
    await atomicWriteFile(this.path(kind, key), JSON.stringify(value));
  }
  async insert<T>(kind: string, key: string, value: T): Promise<T> {
    const destination = this.path(kind, key);
    const temporary = join(this.root, kind, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      try { await link(temporary, destination); await fsyncDirectory(join(this.root, kind)); return value; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.get<T>(kind, key);
        if (!existing) throw new Error('Collaboration record disappeared during publication');
        return existing;
      }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async remove(kind: string, key: string): Promise<void> {
    await unlink(this.path(kind, key)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  async list<T>(kind: string): Promise<T[]> {
    const names = (await readdir(join(this.root, kind))).filter(name => name.endsWith('.json'));
    const records: T[] = [];
    for (let offset = 0; offset < names.length; offset += 32) {
      const batch = await Promise.all(names.slice(offset, offset + 32).map(name => this.read<T>(join(this.root, kind, name))));
      for (const record of batch) if (record !== null) records.push(record);
    }
    return records;
  }
  subscribe(listener: () => void): () => void {
    const watchers = ['messages', 'receipts', 'participants', 'links', 'completions', 'triggers', 'networks'].map(kind => {
      const watcher = watch(join(this.root, kind), { persistent: false }, listener);
      watcher.on('error', listener);
      return watcher;
    });
    return () => watchers.forEach(watcher => watcher.close());
  }
}
