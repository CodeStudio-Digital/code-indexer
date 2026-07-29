import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function ensureInside(root: string, candidate: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(normalizedRoot, rel) !== normalizedCandidate) {
    throw new Error(`path escapes root: root=${normalizedRoot} candidate=${normalizedCandidate}`);
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function syncParentDirectory(path: string): void {
  syncDirectory(dirname(path));
}

export function atomicWriteFile(path: string, content: string | Buffer, mode = 0o600): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temp = join(parent, `.${Date.now()}-${process.pid}-${sha256Bytes(path).slice(0, 8)}.tmp`);
  const fd = openSync(temp, 'wx', mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  syncDirectory(parent);
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function copyFileVerified(source: string, destination: string): {
  sha256: string;
  size: number;
} {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const sourceSize = statSync(source).size;
  const destinationSize = statSync(destination).size;
  const sourceHash = fileHash(source);
  const destinationHash = fileHash(destination);
  if (sourceSize !== destinationSize || sourceHash !== destinationHash) {
    throw new Error(`copy hash mismatch: ${source} -> ${destination}`);
  }
  return { sha256: destinationHash, size: destinationSize };
}

export function fileHash(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function existingFileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}
