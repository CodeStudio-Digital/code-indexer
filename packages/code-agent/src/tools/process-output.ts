import { createWriteStream, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync, rmSync, type WriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mcpDataDir } from '@mcp/shared/utils/config.js';

const LIMIT = 8 * 1024 * 1024;
const TTL = 10 * 60_000;
const entries = new Map<string, ProcessOutput>();
function ownerDirectory(owner: string): string {
  return join(mcpDataDir(), 'process-output', createHash('sha256').update(owner).digest('hex'));
}
interface OutputManifest {
  version: 1; id: string; key: string; bytes: number; observed: number;
  complete: boolean; finished: boolean; updatedAt: number; expiresAt: number;
}

/** A bounded spool of decoded UTF-8 output; bytes refer to this representation. */
export class ProcessOutput {
  readonly id: string;
  readonly path: string;
  private stream?: WriteStream;
  private key = randomBytes(32).toString('base64url');
  private finished = false;
  private expiresAt = Date.now() + TTL;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private bytes = 0;
  private observed = 0;
  private omitted = false;
  private failed = false;
  private expired = false;
  constructor(readonly owner: string, recovered?: OutputManifest) {
    if (entries.size >= 64) throw new Error('Process output quota reached; wait for retained outputs to expire');
    const directory = ownerDirectory(owner);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.id = recovered?.id ?? randomUUID();
    this.path = join(directory, this.id + '.log');
    if (recovered) {
      this.key = recovered.key; this.bytes = Math.min(recovered.bytes, statSync(this.path).size);
      this.observed = Math.max(recovered.observed, this.bytes); this.finished = recovered.finished;
      this.omitted = !recovered.complete || !recovered.finished || this.bytes !== recovered.bytes;
      this.expiresAt = recovered.expiresAt;
      this.scheduleExpiry();
    } else {
      // Expired outputs only. Never evict an unexpired receipt to admit a job.
      for (const name of readdirSync(directory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
        try {
          const file = join(directory, name);
          const manifest = JSON.parse(readFileSync(file, 'utf8')) as OutputManifest;
          if (manifest.expiresAt < Date.now()) {
            rmSync(join(directory, name.replace(/\.json$/, '.log')), { force: true });
            rmSync(file, { force: true });
          }
        } catch { /* Unknown/corrupt records are not guessed or replayed. */ }
      }
      if (readdirSync(directory).filter(n => n.endsWith('.json')).length >= 64) throw new Error('Retained output quota reached for this session');
      this.stream = createWriteStream(this.path, { flags: 'wx', mode: 0o600 });
      this.stream.on('error', () => { this.failed = true; });
      this.persist();
    }
    entries.set(this.id, this);
  }
  private sign(value: string): string { return createHmac('sha256', Buffer.from(this.key, 'base64url')).update(value).digest('base64url'); }
  private persist(): void {
    if (this.expired) return;
    const manifest: OutputManifest = { version: 1, id: this.id, key: this.key, bytes: this.bytes - this.queued,
      observed: this.observed, complete: !this.omitted && !this.failed, finished: this.finished,
      updatedAt: Date.now(), expiresAt: this.expiresAt };
    const path = this.path.replace(/\.log$/, '.json');
    try {
      writeFileSync(path + '.tmp', JSON.stringify(manifest), { mode: 0o600 });
      renameSync(path + '.tmp', path);
    } catch { this.failed = true; }
  }
  private scheduleExpiry(): void {
    const timer = setTimeout(() => {
      this.expired = true; entries.delete(this.id);
      void Promise.all([rm(this.path, { force: true }), rm(this.path.replace(/\.log$/, '.json'), { force: true })]).catch(() => undefined);
    }, Math.max(1, this.expiresAt - Date.now()));
    timer.unref();
  }
  append(text: string): void {
    const data = Buffer.from(text);
    this.observed += data.length;
    // Preserve a contiguous prefix. Once a gap occurs, never claim a later
    // byte belongs to the same lossless snapshot.
    if (!this.stream || this.finished || this.omitted || this.failed || this.expired || this.queued > 256 * 1024) { this.omitted = true; return; }
    let end = Math.min(data.length, LIMIT - this.bytes);
    while (end > 0 && end < data.length && (data[end] & 0xc0) === 0x80) end--;
    if (end < data.length) this.omitted = true;
    if (!end) return;
    const chunk = data.subarray(0, end);
    this.bytes += chunk.length; this.queued += chunk.length;
    this.tail = new Promise(resolve => this.stream!.write(chunk, () => {
      this.queued -= chunk.length;
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => { this.persistTimer = undefined; this.expiresAt = Date.now() + TTL; this.persist(); }, 250);
        this.persistTimer.unref();
      }
      resolve();
    }));
  }
  finish(): void {
    if (this.finished || !this.stream) return;
    this.finished = true;
    this.tail = new Promise(resolve => this.stream!.end(() => {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = undefined; this.expiresAt = Date.now() + TTL;
      this.persist(); this.scheduleExpiry(); resolve();
    }));
  }
  evidence() { return { outputRef: this.id, retainedBytes: this.bytes, observedBytes: this.observed, complete: !this.omitted && !this.failed, retentionMsAfterExit: TTL, executionState: this.stream ? (this.finished ? 'finished' : 'running') : (this.finished ? 'finished' : 'interrupted') }; }
  async page(cursor?: string, limit = 64 * 1024) {
    await this.tail;
    if (this.failed || this.expired) throw new Error('Process output is unavailable');
    let offset = 0, end = this.bytes;
    if (cursor) {
      const [value, signature] = cursor.split('.');
      if (!value || cursor.length > 4096 || this.sign(value) !== signature) throw new Error('Invalid output cursor');
      const state = JSON.parse(Buffer.from(value, 'base64url').toString());
      if (state.id !== this.id || !Number.isSafeInteger(state.offset) || !Number.isSafeInteger(state.end) || state.offset < 0 || state.offset > state.end || state.end > this.bytes) throw new Error('Invalid output scope');
      offset = state.offset; end = state.end;
    }
    const handle = await open(this.path, 'r');
    try {
      const size = Math.min(Math.max(4, Math.min(64 * 1024, Math.floor(limit) || 64 * 1024)), end - offset);
      const buffer = Buffer.alloc(size + 3);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(size + 3, end - offset), offset);
      let take = Math.min(size, bytesRead);
      while (take > 0 && take < bytesRead && (buffer[take] & 0xc0) === 0x80) take--;
      const next = offset + take;
      const value = Buffer.from(JSON.stringify({ id: this.id, offset: next, end })).toString('base64url');
      return { text: buffer.subarray(0, take).toString('utf8'), offset, end: next, snapshotBytes: end,
        nextCursor: next < end ? `${value}.${this.sign(value)}` : null, ...this.evidence() };
    } finally { await handle.close(); }
  }
}
export function readProcessOutput(owner: string, id: string, cursor?: string, limit?: number) {
  let output = entries.get(id);
  if (!output && /^[a-f0-9-]{36}$/.test(id)) {
    try {
      const path = join(ownerDirectory(owner), id + '.json');
      if (statSync(path).size > 4096) throw new Error('Invalid manifest');
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as OutputManifest;
      if (manifest.version !== 1 || manifest.id !== id || manifest.expiresAt < Date.now()
        || typeof manifest.key !== 'string' || manifest.key.length !== 43
        || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > LIMIT) throw new Error('Expired or invalid manifest');
      output = new ProcessOutput(owner, manifest);
    } catch { /* Return the same scoped-not-found response, no path disclosure. */ }
  }
  if (!output || output.owner !== owner) throw new Error('Output not found for this session or retention expired');
  return output.page(cursor, limit);
}
