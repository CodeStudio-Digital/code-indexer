import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export interface ProjectFilePolicy {
  fileRoot?: string;
  allowAbsoluteFiles?: boolean;
  signal?: AbortSignal;
  beforeRead?: () => void;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel);
}

/** Bounded, cancellable reads; reject symlink escapes and path replacement
 * before using acquired bytes. The handle is closed on every exit. */
export async function readProjectFile(path: string, policy: ProjectFilePolicy = {}, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const check = () => { policy.signal?.throwIfAborted(); policy.beforeRead?.(); };
  check();
  if (!policy.allowAbsoluteFiles && !policy.fileRoot) throw new Error('file-backed request bodies are not permitted here');
  const root = policy.fileRoot ? await realpath(resolve(policy.fileRoot)) : undefined;
  const candidate = resolve(policy.fileRoot ?? '.', path);
  if (!policy.allowAbsoluteFiles && !inside(resolve(policy.fileRoot!), candidate)) throw new Error('attached file path escapes the project root');
  const canonical = await realpath(candidate);
  if (!policy.allowAbsoluteFiles && !inside(root!, canonical)) throw new Error('attached file path escapes the project root');
  check();
  const handle = await open(canonical, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error('Attached path must be a regular file');
    if (initial.size > maxBytes) throw new Error(`Attached file exceeds ${maxBytes} byte limit`);
    const verify = async () => {
      const current = await realpath(candidate);
      if (current !== canonical) throw new Error('Attached file path changed during read');
      const currentStat = await stat(current);
      if (currentStat.dev !== initial.dev || currentStat.ino !== initial.ino || currentStat.size !== initial.size
        || currentStat.mtimeMs !== initial.mtimeMs) throw new Error('Attached file changed during read');
      check();
    };
    await verify();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      check();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      check();
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Attached file exceeds ${maxBytes} byte limit`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    await verify();
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
