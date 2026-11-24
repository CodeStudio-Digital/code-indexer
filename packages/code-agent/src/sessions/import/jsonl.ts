import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ExternalSessionError, type ExternalSessionWarning } from './types.js';

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DISCOVERY_EDGE_BYTES = 128 * 1024;

interface Snapshot { size: number; mtimeMs: number }

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ExternalSessionError('source_not_found', `Source is not a file: ${path}`);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (error instanceof ExternalSessionError) throw error;
    throw new ExternalSessionError('source_not_found', `Source not found: ${path}`);
  }
}

function same(a: Snapshot, b: Snapshot): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export interface JsonlReadResult {
  records: unknown[];
  fingerprint: string;
  size_bytes: number;
  warnings: ExternalSessionWarning[];
}

async function readOnce(path: string, maxBytes: number): Promise<JsonlReadResult & { stable: boolean }> {
  const before = await snapshot(path);
  if (before.size > maxBytes) {
    throw new ExternalSessionError('source_too_large', `Source exceeds ${maxBytes} bytes`, {
      size_bytes: before.size,
      max_bytes: maxBytes,
    });
  }

  const records: unknown[] = [];
  const hash = createHash('sha256');
  const malformed: number[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  stream.on('data', (chunk) => hash.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed.push(lineNumber);
    }
  }
  const after = await snapshot(path);
  const warnings: ExternalSessionWarning[] = malformed.length > 0
    ? [{
        code: 'malformed_jsonl_lines',
        message: `${malformed.length} malformed or incomplete JSONL line(s) were ignored`,
        count: malformed.length,
      }]
    : [];
  return {
    records,
    fingerprint: hash.digest('hex'),
    size_bytes: after.size,
    warnings,
    stable: same(before, after),
  };
}

export async function readStableJsonl(path: string, maxBytes = DEFAULT_MAX_BYTES): Promise<JsonlReadResult> {
  const first = await readOnce(path, maxBytes);
  if (first.stable) return first;
  const second = await readOnce(path, maxBytes);
  if (!second.stable) {
    throw new ExternalSessionError('source_busy', 'Source changed while it was being read', { path });
  }
  return second;
}

export async function readJsonlHead(path: string, maxLines = 20): Promise<{ records: unknown[]; size_bytes: number; modified_at: string }> {
  const info = await snapshot(path);
  const records: unknown[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* tolerate an active final line */ }
    if (records.length >= maxLines) {
      lines.close();
      stream.destroy();
      break;
    }
  }
  return { records, size_bytes: info.size, modified_at: new Date(info.mtimeMs).toISOString() };
}

async function readJsonlWindow(file: FileHandle, offset: number, length: number, trimEnd: boolean): Promise<unknown[]> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, offset);
  let text = buffer.toString('utf8', 0, bytesRead);
  if (offset > 0) {
    const firstNewline = text.indexOf('\n');
    if (firstNewline === -1) return [];
    text = text.slice(firstNewline + 1);
  }
  if (trimEnd) text = text.slice(0, text.lastIndexOf('\n') + 1);
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Read the opening records and recent metadata without loading large transcripts. */
export async function readJsonlEdges(path: string): Promise<{ records: unknown[]; size_bytes: number; modified_at: string }> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const records = info.size <= 2 * DISCOVERY_EDGE_BYTES
      ? await readJsonlWindow(file, 0, info.size, false)
      : [
          ...await readJsonlWindow(file, 0, DISCOVERY_EDGE_BYTES, true),
          ...await readJsonlWindow(file, info.size - DISCOVERY_EDGE_BYTES, DISCOVERY_EDGE_BYTES, false),
        ];
    return { records, size_bytes: info.size, modified_at: info.mtime.toISOString() };
  } finally {
    await file.close();
  }
}

export async function walkFiles(
  root: string,
  accept: (name: string, depth: number) => boolean,
  maxDepth = 8,
): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && accept(entry.name, depth)) found.push(path);
    }));
  }
  await walk(root, 0);
  return found;
}
