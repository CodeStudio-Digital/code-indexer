import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { realpath } from 'node:fs/promises';

/** Treat paths as addresses within the admitted project, never process cwd. */
export function projectRelativePath(root: string, value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid project path');
  let path = value;
  if (isAbsolute(path)) path = relative(resolve(root), resolve(path));
  else if (win32.isAbsolute(path)) throw new Error('Path is outside the project root');
  if (isAbsolute(path) || win32.isAbsolute(path)) throw new Error('Path is outside the project root');
  const parts = path.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..' || p.includes(':'))) throw new Error('Path is outside the project root');
  return parts.join('/');
}

export async function projectReadPath(root: string, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root), target = await realpath(resolve(root, path));
  signal?.throwIfAborted();
  const rel = relative(canonicalRoot, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Path resolves outside the project root');
  return target;
}
