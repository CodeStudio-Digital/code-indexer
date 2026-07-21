import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeEventEnvelope, RuntimeLogKind } from './runtime-event-log.js';

export interface PersistableRuntimeEvent {
  event: RuntimeEventEnvelope;
  line: string;
  bytes: number;
}

const MAX_FILE_BYTES = readPositiveInt('MCP_RUNTIME_LOG_MAX_SESSION_MB', 8, 1) * 1024 * 1024;
const MAX_TOTAL_BYTES = readPositiveInt('MCP_RUNTIME_LOG_MAX_TOTAL_MB', 256, 16) * 1024 * 1024;
const RETENTION_MS = readPositiveInt('MCP_RUNTIME_LOG_RETENTION_DAYS', 7, 1) * 24 * 60 * 60_000;

const writeChains = new Map<string, Promise<void>>();
const ensuredDirs = new Set<string>();
const fileSizes = new Map<string, number>();
const activeLogRefs = new Map<string, number>();
let retentionStarted = false;

export function registerRuntimeEventLog(kind: RuntimeLogKind, sessionId: number): () => void {
  const key = `${kind}:${sessionId}`;
  activeLogRefs.set(key, (activeLogRefs.get(key) ?? 0) + 1);
  if (!retentionStarted) {
    retentionStarted = true;
    void pruneRuntimeEventLogs().catch(() => undefined);
  }
  return () => {
    const refs = (activeLogRefs.get(key) ?? 1) - 1;
    if (refs > 0) activeLogRefs.set(key, refs);
    else activeLogRefs.delete(key);
  };
}

export function persistRuntimeEvent(prepared: PersistableRuntimeEvent): void {
  const file = logFile(prepared.event.kind, prepared.event.sessionId);
  const dir = path.dirname(file);
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }

  const previous = writeChains.get(file) ?? Promise.resolve();
  const next = previous.then(async () => {
    let currentBytes = fileSizes.get(file);
    if (currentBytes == null) {
      try { currentBytes = (await stat(file)).size; }
      catch { currentBytes = 0; }
    }

    if (currentBytes > MAX_FILE_BYTES) {
      // Legacy unbounded file: do not preserve a multi-hundred-MB rotation.
      await rm(file, { force: true });
      await rm(rotatedLogFile(file), { force: true });
      currentBytes = 0;
    } else if (currentBytes > 0 && currentBytes + prepared.bytes > MAX_FILE_BYTES) {
      const rotated = rotatedLogFile(file);
      await rm(rotated, { force: true });
      try { await rename(file, rotated); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      currentBytes = 0;
    }

    await appendFile(file, prepared.line, 'utf8');
    fileSizes.set(file, currentBytes + prepared.bytes);
  }).catch(() => undefined);

  writeChains.set(file, next);
  void next.finally(() => {
    if (writeChains.get(file) === next) writeChains.delete(file);
  });
}

export function readPersistedRuntimeEvents(
  kind: RuntimeLogKind,
  sessionId: number,
): RuntimeEventEnvelope[] {
  const events: RuntimeEventEnvelope[] = [];
  const current = logFile(kind, sessionId);
  for (const file of [rotatedLogFile(current), current]) {
    if (!existsSync(file)) continue;
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line) continue;
        try { events.push(JSON.parse(line) as RuntimeEventEnvelope); }
        catch { /* ignore a partial/corrupt diagnostic row */ }
      }
    } catch {
      // Best-effort diagnostics must never break the session/export route.
    }
  }
  return events;
}

async function pruneRuntimeEventLogs(now = Date.now()): Promise<void> {
  const root = runtimeLogDir();
  const candidates: Array<{ file: string; bytes: number; mtimeMs: number }> = [];
  const activeFiles = new Set<string>();
  for (const key of activeLogRefs.keys()) {
    const [kind, rawSessionId] = key.split(':');
    const file = logFile(kind as RuntimeLogKind, Number(rawSessionId));
    activeFiles.add(file);
    activeFiles.add(rotatedLogFile(file));
  }

  for (const kind of ['coder', 'company'] as const) {
    const dir = path.join(root, kind);
    let names: string[];
    try { names = await readdir(dir); }
    catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (!activeFiles.has(file) && now - info.mtimeMs > RETENTION_MS) {
          await rm(file, { force: true });
          fileSizes.delete(file);
          continue;
        }
        candidates.push({ file, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch { /* file disappeared during cleanup */ }
    }
  }

  let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (totalBytes <= MAX_TOTAL_BYTES) return;
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const candidate of candidates) {
    if (totalBytes <= MAX_TOTAL_BYTES) break;
    if (activeFiles.has(candidate.file)) continue;
    await rm(candidate.file, { force: true });
    fileSizes.delete(candidate.file);
    totalBytes -= candidate.bytes;
  }
}

function logFile(kind: RuntimeLogKind, sessionId: number): string {
  return path.join(runtimeLogDir(), kind, `${sessionId}.jsonl`);
}

function rotatedLogFile(file: string): string {
  return file.replace(/\.jsonl$/i, '.1.jsonl');
}

function runtimeLogDir(): string {
  return process.env.MCP_RUNTIME_EVENT_LOG_DIR
    ? path.resolve(process.env.MCP_RUNTIME_EVENT_LOG_DIR)
    : path.join(process.cwd(), '.mcp-indexer', 'runtime-event-logs');
}

function readPositiveInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

export async function flushRuntimeEventLogWrites(): Promise<void> {
  await Promise.all(Array.from(writeChains.values()));
}

export function resetRuntimeEventLogStorage(): void {
  writeChains.clear();
  ensuredDirs.clear();
  fileSizes.clear();
  activeLogRefs.clear();
  retentionStarted = false;
}
