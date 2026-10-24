import { existsSync, readdirSync, rmSync } from 'node:fs';
import { close as closeCallback } from 'node:fs';
import { closeSync } from 'node:fs';
import { fdatasync as fdatasyncCallback } from 'node:fs';
import { fdatasyncSync } from 'node:fs';
import { open as openCallback } from 'node:fs';
import { openSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { write as writeCallback } from 'node:fs';
import { writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { open as openAsync } from 'node:fs/promises';
import { readFile as readFileAsync } from 'node:fs/promises';
import { rename as renameAsync } from 'node:fs/promises';
import { unlink as unlinkAsync } from 'node:fs/promises';
import type { RunManifest } from './persistent-diagnostics-types.js';
import { SCHEMA_VERSION } from './persistent-diagnostics-constants.js';

export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function safeTimestamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function writeFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writeSync(fd, buffer, offset, buffer.byteLength - offset, null);
    if (written <= 0) throw new Error('diagnostics write made no progress');
    offset += written;
  }
}

export function writeFullyAsync(fd: number, buffer: Buffer): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    let offset = 0;
    const next = (): void => {
      if (offset >= buffer.byteLength) {
        resolveWrite();
        return;
      }
      writeCallback(fd, buffer, offset, buffer.byteLength - offset, null, (error, written) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        if (written <= 0) {
          rejectWrite(new Error('diagnostics write made no progress'));
          return;
        }
        offset += written;
        next();
      });
    };
    next();
  });
}

export function openFdAsync(path: string): Promise<number> {
  return new Promise((resolveOpen, rejectOpen) => {
    openCallback(path, 'a', 0o600, (error, fd) => error ? rejectOpen(error) : resolveOpen(fd));
  });
}

export function closeFdAsync(fd: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    closeCallback(fd, (error) => error ? rejectClose(error) : resolveClose());
  });
}

export function syncFdAsync(fd: number): Promise<void> {
  return new Promise((resolveSync, rejectSync) => {
    fdatasyncCallback(fd, (error) => error ? rejectSync(error) : resolveSync());
  });
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFully(fd, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, path);
  } catch (error) {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(temporary); } catch { /* ignore */ }
    throw error;
  }
}

export async function writeJsonAtomicAsync(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file: Awaited<ReturnType<typeof openAsync>> | null = null;
  try {
    file = await openAsync(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await renameAsync(temporary, path);
  } catch (error) {
    if (file) {
      try { await file.close(); } catch { /* ignore */ }
    }
    try { await unlinkAsync(temporary); } catch { /* ignore */ }
    throw error;
  }
}

export async function readJsonAsync(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFileAsync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

export function manifestFrom(path: string): RunManifest | null {
  const value = readJson(path);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION || typeof value.id !== 'string') return null;
  if (typeof value.startedAt !== 'number' || typeof value.pid !== 'number') return null;
  return value as unknown as RunManifest;
}

export async function readFileTail(path: string, maxBytes: number): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  const file = await openAsync(path, 'r');
  try {
    const stat = await file.stat();
    const bytesToRead = Math.min(stat.size, maxBytes);
    const position = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, position);
    let text = buffer.subarray(0, result.bytesRead).toString('utf8');
    if (position > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return { text, bytesRead: result.bytesRead, truncated: position > 0 };
  } finally {
    await file.close();
  }
}

export function prunePerfRuns(rootDir: string, keep: number): void {
    let dirs: Array<{ dir: string; startedAt: number; pid: number; closed: boolean }> = [];
    try {
      dirs = readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const dir = join(rootDir, entry.name);
          const manifest = manifestFrom(join(dir, 'manifest.json'));
          return manifest ? {
            dir,
            startedAt: manifest.startedAt,
            pid: manifest.pid,
            closed: existsSync(join(dir, 'closed.json')),
          } : null;
        })
        .filter((entry): entry is { dir: string; startedAt: number; pid: number; closed: boolean } => !!entry)
        .sort((a, b) => b.startedAt - a.startedAt);
    } catch {
      return;
    }
    for (const stale of dirs.slice(keep)) {
      // A second application instance may share this data directory. Never
      // prune a marker-less run whose owning PID is still alive.
      if (!stale.closed && pidIsAlive(stale.pid)) continue;
      // `stale.dir` came directly from a child directory enumeration under the
      // resolved diagnostics root; never accept caller-provided paths here.
      try { rmSync(stale.dir, { recursive: true, force: true }); } catch { /* retention is best-effort */ }
    }
  }
