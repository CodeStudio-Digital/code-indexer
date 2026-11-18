import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

// Independent discovery walks (watch budget, runner manifests, ignore rules)
// inspect many of the same directories during a single checkout switch. Share
// raw entries only. Each consumer applies its own traversal and ignore policy.
const pending = new Map<string, Promise<Dirent[]>>();
const recent = new Map<string, { entries: Dirent[]; expires: number }>();
const maxDirectories = 768;
const maxEntries = 16_384;
let entryCount = 0;

function forget(key: string): void {
  const previous = recent.get(key);
  if (previous) {
    entryCount -= previous.entries.length;
    recent.delete(key);
  }
}

export function readProjectDirectory(
  root: string, directory: string, version: string, fresh = false,
): Promise<Dirent[]> {
  const key = `${root}\0${version}\0${directory}`;
  if (!fresh) {
    const flight = pending.get(key);
    if (flight) return flight;
    const hit = recent.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.entries);
  }
  forget(key);
  const read = readdir(directory, { withFileTypes: true }).then(entries => {
    if (pending.get(key) === read && entries.length <= 512) {
      while (recent.size >= maxDirectories || entryCount + entries.length > maxEntries) {
        forget(recent.keys().next().value!);
      }
      recent.set(key, { entries, expires: Date.now() + 2_000 });
      entryCount += entries.length;
    }
    return entries;
  }).finally(() => {
    if (pending.get(key) === read) pending.delete(key);
  });
  pending.set(key, read);
  return read;
}
