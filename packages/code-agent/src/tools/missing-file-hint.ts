import type { IFilesystemPort } from '../ports/filesystem-port.js';

/** Bounded names from an already-authorized parent; never opens sibling files. */
export async function missingFileHint(
  fs: Pick<IFilesystemPort, 'iterateDirectory'>,
  parent: string,
  signal?: AbortSignal,
): Promise<string> {
  // Older/custom ports without streaming enumeration keep the original error.
  // Do not materialize a potentially huge remote directory just for a hint.
  if (!fs.iterateDirectory || signal?.aborted) return '';
  const names: string[] = [];
  let chars = 0;
  let limited = false;
  try {
    for await (const entry of fs.iterateDirectory(parent, signal)) {
      if (signal?.aborted) return '';
      const name = JSON.stringify(entry.name + (entry.isDirectory() ? '/' : ''));
      if (names.length >= 20 || chars + name.length > 1600) { limited = true; break; }
      names.push(name);
      chars += name.length;
    }
  } catch {
    return ''; // A hint must never hide the original read error.
  }
  if (!names.length) return '';
  return `\nDirectory entries in the requested parent (names only${limited ? ', partial listing' : ''}): ${names.sort().join(', ')}.\nUse an exact listed path or a focused file search before retrying.`;
}
