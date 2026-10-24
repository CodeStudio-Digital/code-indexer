import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { projectReadPath } from './project-read-path.js';

const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.mcp-indexer', '.cache', '.turbo', 'coverage']);
interface DiskDirectoryPage { items: string[]; total: number; nextOffset?: number; totalExact?: boolean }

/** Stream directory handles, stopping after one lookahead item. No complete
 * readdir array or synchronous recursive walk is retained on the MCP loop.
 * Disk order is filesystem order; restart at zero if the directory changes. */
export async function diskDirectoryPage(root: string, prefix: string, depth: number,
  offset: number, limit: number, signal?: AbortSignal): Promise<DiskDirectoryPage> {
  signal?.throwIfAborted();
  let abs: string;
  try { abs = await projectReadPath(root, prefix, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], total: 0 }; throw error; }
  const info = await stat(abs); signal?.throwIfAborted();
  if (!info.isDirectory()) {
    if (!info.isFile()) throw new Error('Path is not a regular file or directory');
    return { items: offset ? [] : [`${prefix} (${info.size}B)`], total: 1 };
  }
  const items: string[] = []; let seen = 0, more = false;
  async function walk(directory: string, rel: string, level: number): Promise<void> {
    const handle = await opendir(directory, { bufferSize: 32 });
    try {
      while (true) {
        signal?.throwIfAborted();
        const entry = await handle.read(); signal?.throwIfAborted();
        if (!entry) break;
        if (ignored.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.env.example')) continue;
        if (!entry.isDirectory() && !entry.isFile()) continue; // Includes links and special devices.
        const child = rel ? rel + '/' + entry.name : entry.name;
        if (seen++ >= offset) {
          if (items.length === limit) { more = true; break; }
          if (entry.isDirectory()) items.push(child + '/');
          else {
            const file = await stat(join(directory, entry.name)); signal?.throwIfAborted();
            items.push(`${child} (${file.size}B)`);
          }
        }
        if (entry.isDirectory() && level < depth) {
          // Recheck the canonical address before descending: a directory may
          // have been replaced with a junction after its dirent was read.
          const canonical = await projectReadPath(root, child, signal);
          await walk(canonical, child, level + 1);
          if (more) break;
        }
      }
    } finally { await handle.close(); }
  }
  await walk(abs, prefix, 0);
  signal?.throwIfAborted();
  return { items, total: seen, ...(more ? { nextOffset: offset + items.length, totalExact: false } : { totalExact: true }) };
}
