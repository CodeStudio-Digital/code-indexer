import { createRequire } from 'node:module';
import { readdir } from 'node:fs/promises';
import { join, toNamespacedPath } from 'node:path';

export interface ListedFile {
  relativePath: string;
  metadata?: { size: number; mtimeMs: number };
}

function bindDirectorySearch() {
  const koffi: typeof import('koffi') = createRequire(import.meta.url)('koffi');
  const kernel = koffi.load('kernel32.dll');
  return {
    first: kernel.func('intptr_t __stdcall FindFirstFileExW(str16, int, void *, int, void *, uint32_t)'),
    next: kernel.func('int __stdcall FindNextFileW(intptr_t, void *)'),
    close: kernel.func('int __stdcall FindClose(intptr_t)'),
    error: kernel.func('uint32_t __stdcall GetLastError()'),
  };
}

let binding: ReturnType<typeof bindDirectorySearch> | null | undefined;

export function windowsDirectorySearch() {
  if (process.platform !== 'win32') return null;
  if (binding === undefined) {
    try { binding = bindDirectorySearch(); } catch { binding = null; }
  }
  return binding;
}

/** WIN32_FIND_DATAW includes FILETIME and 64-bit length in the directory
 * record. Only reparse files need a separate stat to resolve their target. */
export async function* listWindowsFiles(
  api: ReturnType<typeof bindDirectorySearch>, root: string, prune: (directory: string) => boolean,
  unavailable: () => void, priority?: () => Promise<void>,
): AsyncGenerator<ListedFile> {
  const directories = [''];
  const record = Buffer.alloc(592);
  const epoch = 116444736000000000n;
  let lastYield = performance.now();
  while (directories.length) {
    const directory = directories.pop()!;
    const pattern = toNamespacedPath(join(root, directory, '*'));
    const handle: number | bigint = api.first(pattern, 1, record, 0, null, 0);
    if (handle === -1 || handle === -1n) {
      const error = api.error();
      if (error === 2) continue; // ERROR_FILE_NOT_FOUND for an empty directory
      // Some redirectors cannot supply FindExInfoBasic. Keep the same
      // per-file stat fallback as other platforms on those mounts.
      try {
        for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const path = directory ? directory + '/' + entry.name : entry.name;
          if (entry.isDirectory()) {
            if (!prune(path)) directories.push(path);
          } else if (entry.isFile() || entry.isSymbolicLink()) yield { relativePath: path };
        }
      } catch { unavailable(); }
      continue;
    }
    try {
      do {
        if (performance.now() - lastYield >= 12) {
          await new Promise<void>(resolve => setImmediate(resolve));
          await priority?.();
          lastYield = performance.now();
        }
        const end = record.indexOf('\0', 44, 'utf16le');
        const name = record.toString('utf16le', 44, end);
        if (name.startsWith('.')) continue;
        const path = directory ? directory + '/' + name : name;
        const attributes = record.readUInt32LE(0);
        const reparse = (attributes & 0x400) !== 0;
        if ((attributes & 0x10) !== 0) {
          if (!reparse && !prune(path)) directories.push(path);
        } else if (reparse) {
          yield { relativePath: path };
        } else {
          const ticks = record.readBigUInt64LE(20) - epoch;
          const mtimeMs = Math.trunc(Number(ticks / 10000000n) * 1000 + Number(ticks % 10000000n) / 10000);
          const size = record.readUInt32LE(28) * 0x100000000 + record.readUInt32LE(32);
          yield { relativePath: path, metadata: { size, mtimeMs } };
        }
      } while (api.next(handle, record));
      if (api.error() !== 18) unavailable(); // ERROR_NO_MORE_FILES
    } finally {
      api.close(handle);
    }
  }
}
