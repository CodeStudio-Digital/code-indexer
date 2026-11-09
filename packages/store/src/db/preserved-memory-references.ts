import type { ReferencedFileSnapshot } from './agent-memory-types.js';

/** Explicit historical baselines must not be replaced with today's file hashes. */
export function validatePreservedMemoryReferences(refs: readonly ReferencedFileSnapshot[]): ReferencedFileSnapshot[] {
  if (refs.length > 1000) throw new Error('Too many referenced files');
  const byPath = new Map<string, ReferencedFileSnapshot>();
  for (const ref of refs) {
    if (!ref || typeof ref.path !== 'string' || ref.path.length > 4096 || !ref.path
      || ref.path.includes('\0') || ref.path.includes('\\') || ref.path.startsWith('/')
      || /^[A-Za-z]:/.test(ref.path) || ref.path.split('/').some(part => !part || part === '.' || part === '..')
      || (ref.hash !== null && (typeof ref.hash !== 'string' || ref.hash.length > 256 || !ref.hash || /[\s\0]/.test(ref.hash)))) {
      throw new Error('Invalid historical file reference');
    }
    const previous = byPath.get(ref.path);
    if (previous && previous.hash !== ref.hash) throw new Error('Conflicting historical file references');
    byPath.set(ref.path, { path: ref.path, hash: ref.hash });
  }
  return [...byPath.values()];
}
