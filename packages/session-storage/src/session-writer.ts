import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  atomicWriteFile,
  atomicWriteJson,
  canonicalJson,
  fsyncDirectory,
} from './atomic-file.js';
import {
  assertPathHasNoLinks,
  collectSessionTransientFiles,
  ensureDirectoryTreeNoLinks,
  UnsafeSessionPathError,
} from './path-safety.js';
import type {
  ArtifactRef,
  ConversationCommit,
  JsonValue,
  SessionId,
  SessionStorageFaultInjector,
} from './types.js';

interface WriterLeaseFile {
  readonly schema_version: 1;
  readonly token: string;
  readonly fence: number;
  readonly pid: number;
  /** Opaque isolate identity used for coordinator-verified worker recovery. */
  readonly owner_id?: string;
  readonly owner_host: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

interface WriterFenceFile {
  readonly schema_version: 1;
  readonly fence: number;
  readonly updated_at: string;
}

export class SessionLeaseHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLeaseHeldError';
  }
}

export class SessionFenceLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionFenceLostError';
  }
}

export class SessionOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionOperationConflictError';
  }
}

export class ConversationCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationCorruptionError';
  }
}

export interface SessionWriterOptions {
  readonly bundlePath: string;
  readonly sessionId: SessionId;
  readonly ownerId?: string;
  readonly leaseTtlMs?: number;
  readonly faultInjector?: SessionStorageFaultInjector;
}

export interface WriterCommitInput {
  readonly operation_id: string;
  readonly request_hash: string;
  readonly payload: JsonValue;
  readonly prepare_artifacts?: () => Promise<readonly ArtifactRef[]>;
}

interface ParsedConversation {
  readonly records: ConversationCommit[];
  readonly committedBytes: number;
  readonly discardedBytes: number;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function commitHash(record: Omit<ConversationCommit, 'hash'>): string {
  return sha256Text(canonicalJson(record));
}

export function computeRequestHash(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function validateOperationId(value: string): void {
  if (value.trim().length === 0 || value.length > 512 || value.includes('\0')) {
    throw new TypeError('operation_id must be a non-empty opaque string of at most 512 characters');
  }
}

function validateRecord(record: ConversationCommit, expectedSeq: number, expectedPreviousHash: string | null): void {
  if (record.schema_version !== 1) {
    throw new ConversationCorruptionError(`Unsupported conversation schema at seq ${expectedSeq}`);
  }
  if (!Number.isSafeInteger(record.seq) || record.seq !== expectedSeq) {
    throw new ConversationCorruptionError(`Conversation sequence mismatch: expected ${expectedSeq}, got ${record.seq}`);
  }
  validateOperationId(record.operation_id);
  if (record.prev_hash !== expectedPreviousHash) {
    throw new ConversationCorruptionError(`Conversation hash chain mismatch at seq ${record.seq}`);
  }
  const { hash, ...unsigned } = record;
  const expectedHash = commitHash(unsigned);
  if (hash !== expectedHash) {
    throw new ConversationCorruptionError(`Conversation commit hash mismatch at seq ${record.seq}`);
  }
}

function parseConversationBytes(bytes: Uint8Array): ParsedConversation {
  const buffer = Buffer.from(bytes);
  const finalNewline = buffer.lastIndexOf(0x0a);
  const committedBytes = finalNewline < 0 ? 0 : finalNewline + 1;
  const discardedBytes = buffer.byteLength - committedBytes;
  const committedText = buffer.subarray(0, committedBytes).toString('utf8');
  const lines = committedText.length === 0 ? [] : committedText.split('\n').slice(0, -1);
  const records: ConversationCommit[] = [];
  let previousHash: string | null = null;
  const operationIds = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) throw new ConversationCorruptionError(`Blank conversation line at seq ${index + 1}`);
    let record: ConversationCommit;
    try {
      record = JSON.parse(line) as ConversationCommit;
    } catch (error) {
      throw new ConversationCorruptionError(
        `Invalid committed JSON at conversation seq ${index + 1}: ${(error as Error).message}`,
      );
    }
    validateRecord(record, index + 1, previousHash);
    if (operationIds.has(record.operation_id)) {
      throw new ConversationCorruptionError(`Duplicate operation_id at conversation seq ${record.seq}`);
    }
    operationIds.add(record.operation_id);
    previousHash = record.hash;
    records.push(record);
  }
  return { records, committedBytes, discardedBytes };
}

export function readConversationSync(conversationPath: string): readonly ConversationCommit[] {
  if (!existsSync(conversationPath)) return [];
  return parseConversationBytes(readFileSync(conversationPath)).records;
}

/**
 * Read committed conversation records without blocking the host event loop.
 * Unlike recovery this is read-only: an incomplete crash suffix is ignored but
 * never truncated by an ordinary query.
 */
export async function readConversation(
  conversationPath: string,
): Promise<readonly ConversationCommit[]> {
  try {
    return parseConversationBytes(await readFile(conversationPath)).records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function recoverConversation(conversationPath: string): Promise<readonly ConversationCommit[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(conversationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    const handle = await open(conversationPath, 'wx', 0o600);
    await handle.sync();
    await handle.close();
    return [];
  }

  const parsed = parseConversationBytes(bytes);
  if (parsed.discardedBytes > 0) {
    const handle = await open(conversationPath, 'r+');
    try {
      await handle.truncate(parsed.committedBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return parsed.records;
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SessionLeaseHeldError(`Cannot parse ${label}: ${(error as Error).message}`);
  }
}

/**
 * A TTL alone cannot safely fence a paused writer: it may resume after a
 * contender steals the lease and append with an obsolete fence. We only
 * reclaim a valid expired lease after proving that its local owner process is
 * gone. Unknown/remote owners remain fail-closed and require maintenance.
 */
function ownerProcessIsDefinitelyDead(lease: WriterLeaseFile): boolean {
  if (
    lease.owner_host !== hostname() ||
    !Number.isSafeInteger(lease.pid) ||
    lease.pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(lease.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

/**
 * Reclaim a lease only after an external coordinator has observed the exact
 * worker isolate exit. PID liveness is insufficient for worker_threads because
 * every isolate shares the Electron PID; the opaque owner id is minted by the
 * pool and written into the lease by that worker alone.
 */
export async function releaseSessionWriterLeaseForOwner(options: {
  readonly bundlePath: string;
  readonly ownerId: string;
}): Promise<boolean> {
  if (
    options.ownerId.trim().length === 0
    || options.ownerId.length > 256
    || options.ownerId.includes('\0')
  ) {
    throw new TypeError('ownerId must be a non-empty opaque string of at most 256 characters');
  }
  const leasePath = join(options.bundlePath, 'events', 'writer.lease');

  let identity: { readonly dev: number; readonly ino: number };
  let lease: WriterLeaseFile;
  try {
    // An isolate may exit before opening its writer/events directory. There
    // is no lease to reclaim in that case; still reject links when it exists.
    await assertPathHasNoLinks(options.bundlePath, dirname(leasePath));
    const leaseStat = await lstat(leasePath);
    if (leaseStat.isSymbolicLink() || !leaseStat.isFile()) {
      throw new UnsafeSessionPathError(`Writer lease must be a regular file: ${leasePath}`);
    }
    identity = { dev: leaseStat.dev, ino: leaseStat.ino };
    lease = parseJson<WriterLeaseFile>(await readFile(leasePath, 'utf8'), 'writer lease');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  if (lease.owner_id !== options.ownerId) return false;

  // Refuse to rename a lease that changed between validation and recovery.
  const current = await lstat(leasePath).catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  });
  if (
    !current
    || current.isSymbolicLink()
    || !current.isFile()
    || current.dev !== identity.dev
    || current.ino !== identity.ino
  ) {
    return false;
  }
  const releasePath = join(
    dirname(leasePath),
    `.writer.lease.dead-owner-${randomUUID()}`,
  );
  try {
    await rename(leasePath, releasePath);
    await unlink(releasePath);
    await fsyncDirectory(dirname(leasePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

export interface WriterProjection<T> {
  create(): T;
  apply(state: T, commit: ConversationCommit): void;
}

export class SessionWriter {
  readonly #bundlePath: string;
  readonly #sessionId: SessionId;
  readonly #conversationPath: string;
  readonly #leasePath: string;
  readonly #fencePath: string;
  readonly #leaseTtlMs: number;
  readonly #ownerId?: string;
  readonly #faultInjector?: SessionStorageFaultInjector;
  readonly #token = randomUUID();

  #fence = 0;
  #lease: WriterLeaseFile | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #heartbeatFailure: Error | null = null;
  #leaseRefreshQueue: Promise<void> = Promise.resolve();
  #queue: Promise<unknown> = Promise.resolve();
  #records: ConversationCommit[] = [];
  #journalStamp: Stats | null = null;
  readonly #projections = new Map<WriterProjection<unknown>, { state: unknown }>();
  #operations = new Map<string, ConversationCommit>();
  #closing = false;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  private constructor(options: SessionWriterOptions) {
    this.#bundlePath = options.bundlePath;
    this.#sessionId = options.sessionId;
    this.#conversationPath = join(options.bundlePath, 'conversation.jsonl');
    this.#leasePath = join(options.bundlePath, 'events', 'writer.lease');
    this.#fencePath = join(options.bundlePath, 'events', 'writer.fence.json');
    this.#leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 30_000);
    if (
      options.ownerId !== undefined
      && (
        options.ownerId.trim().length === 0
        || options.ownerId.length > 256
        || options.ownerId.includes('\0')
      )
    ) {
      throw new TypeError('writer ownerId must be a non-empty opaque string of at most 256 characters');
    }
    this.#ownerId = options.ownerId;
    this.#faultInjector = options.faultInjector;
  }

  static async open(options: SessionWriterOptions): Promise<SessionWriter> {
    const writer = new SessionWriter(options);
    await writer.#initialize();
    return writer;
  }

  get fence(): number {
    return this.#fence;
  }

  get recordsSnapshot(): readonly ConversationCommit[] {
    return this.#records.slice();
  }

  /** Projection lifetime is exactly this fenced writer. It is rebuilt once on
   * recovery and advanced only after a journal commit. Read paths remain free
   * to use the full validator; no cache crosses a writer/authority boundary. */
  readProjection<T>(projection: WriterProjection<T>): Promise<T> {
    return this.#enqueue(async () => {
      await this.#assertLease();
      await this.#assertConversationUnchanged();
      const cached = this.#projections.get(projection);
      if (cached) return cached.state as T;
      const state = projection.create();
      for (const record of this.#records) projection.apply(state, record);
      // Extra indices are bounded independently of the durable history. Above
      // these limits rebuild on demand instead of retaining another hot copy.
      if (this.#records.length <= 100_000 && (this.#journalStamp?.size ?? 0) <= 32 * 1024 * 1024) {
        if (this.#projections.size >= 4) this.#projections.clear();
        this.#projections.set(projection, { state });
      }
      return state;
    });
  }

  async #assertConversationUnchanged(): Promise<void> {
    const stat = await lstat(this.#conversationPath);
    const previous = this.#journalStamp;
    if (!previous || !stat.isFile() || stat.isSymbolicLink()
      || stat.size !== previous.size || stat.mtimeMs !== previous.mtimeMs
      || stat.ctimeMs !== previous.ctimeMs || stat.ino !== previous.ino || stat.dev !== previous.dev) {
      this.#projections.clear();
      this.#heartbeatFailure = new ConversationCorruptionError('Journal changed outside its authorized writer');
      throw this.#heartbeatFailure;
    }
  }

  async #initialize(): Promise<void> {
    await ensureDirectoryTreeNoLinks(this.#bundlePath, join(this.#bundlePath, 'events'));
    await assertPathHasNoLinks(this.#bundlePath, this.#conversationPath);
    await this.#acquireLease();
    try {
      await collectSessionTransientFiles(this.#bundlePath);
      await this.#reloadConversation();
      const heartbeatMs = Math.max(500, Math.floor(this.#leaseTtlMs / 3));
      this.#heartbeat = setInterval(() => {
        void this.#refreshLease().catch((error) => {
          this.#heartbeatFailure = error instanceof Error ? error : new Error(String(error));
        });
      }, heartbeatMs);
      this.#heartbeat.unref?.();
    } catch (error) {
      await this.#releaseLease().catch(() => undefined);
      throw error;
    }
  }

  async #readFence(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.#fencePath, 'utf8')) as WriterFenceFile;
      return Number.isSafeInteger(parsed.fence) && parsed.fence >= 0 ? parsed.fence : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async #acquireLease(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const fence = (await this.#readFence()) + 1;
      const now = Date.now();
      const lease: WriterLeaseFile = {
        schema_version: 1,
        token: this.#token,
        fence,
        pid: process.pid,
        ...(this.#ownerId ? { owner_id: this.#ownerId } : {}),
        owner_host: hostname(),
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.#leaseTtlMs).toISOString(),
      };
      let handle;
      let createdLeaseIdentity: { readonly dev: number; readonly ino: number } | null = null;
      try {
        handle = await open(this.#leasePath, 'wx', 0o600);
        const opened = await handle.stat();
        createdLeaseIdentity = { dev: opened.dev, ino: opened.ino };
        await handle.writeFile(`${JSON.stringify(lease)}\n`);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fsyncDirectory(dirname(this.#leasePath));
        await atomicWriteJson(
          this.#fencePath,
          {
            schema_version: 1,
            fence,
            updated_at: new Date().toISOString(),
          } satisfies WriterFenceFile,
          {
            faultInjector: this.#faultInjector,
            context: { session_id: this.#sessionId },
          },
        );
        this.#fence = fence;
        this.#lease = lease;
        return;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (createdLeaseIdentity) {
          try {
            const current = await lstat(this.#leasePath);
            if (
              !current.isSymbolicLink() &&
              current.isFile() &&
              current.dev === createdLeaseIdentity.dev &&
              current.ino === createdLeaseIdentity.ino
            ) {
              await unlink(this.#leasePath);
              await fsyncDirectory(dirname(this.#leasePath));
            }
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              throw cleanupError;
            }
          }
          throw error;
        }
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;

        let stale = false;
        let holder = 'unknown';
        try {
          const leaseStat = await lstat(this.#leasePath);
          if (leaseStat.isSymbolicLink()) {
            throw new UnsafeSessionPathError(`Writer lease cannot be a symbolic link: ${this.#leasePath}`);
          }
          const existing = parseJson<WriterLeaseFile>(await readFile(this.#leasePath, 'utf8'), 'writer lease');
          stale = Date.parse(existing.expires_at) <= Date.now();
          holder = `${existing.pid}/${existing.token}`;
          if (stale && !ownerProcessIsDefinitelyDead(existing)) {
            throw new SessionLeaseHeldError(
              `Expired writer ${holder} for session ${this.#sessionId} is still alive or cannot be proven dead`,
            );
          }
        } catch (parseError) {
          if (parseError instanceof SessionLeaseHeldError) throw parseError;
          if ((parseError as NodeJS.ErrnoException)?.code === 'ENOENT') {
            continue;
          }
          throw new SessionLeaseHeldError(
            `Cannot safely validate writer lease for session ${this.#sessionId}; maintenance is required`,
          );
        }
        if (!stale) {
          throw new SessionLeaseHeldError(`Session ${this.#sessionId} is leased by writer ${holder}`);
        }

        const stalePath = join(dirname(this.#leasePath), `.writer.lease.stale-${randomUUID()}`);
        try {
          await rename(this.#leasePath, stalePath);
          await unlink(stalePath);
          await fsyncDirectory(dirname(this.#leasePath));
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw new SessionLeaseHeldError(`Could not fence stale writer for session ${this.#sessionId}`);
          }
        }
      }
    }
    throw new SessionLeaseHeldError(`Could not acquire writer lease for session ${this.#sessionId}`);
  }

  #refreshLease(): Promise<void> {
    this.#leaseRefreshQueue = this.#leaseRefreshQueue.then(async () => {
      const leaseStat = await lstat(this.#leasePath);
      if (leaseStat.isSymbolicLink()) {
        throw new SessionFenceLostError(`Writer lease became a symbolic link for session ${this.#sessionId}`);
      }
      const current = JSON.parse(await readFile(this.#leasePath, 'utf8')) as WriterLeaseFile;
      if (current.token !== this.#token || current.fence !== this.#fence) {
        throw new SessionFenceLostError(
          `Writer ${this.#token} lost fence ${this.#fence} for session ${this.#sessionId}`,
        );
      }
      const now = Date.now();
      const lease: WriterLeaseFile = {
        ...this.#lease!,
        expires_at: new Date(now + this.#leaseTtlMs).toISOString(),
      };
      await atomicWriteFile(
        this.#leasePath,
        `${JSON.stringify(lease)}\n`,
        {
          faultInjector: this.#faultInjector,
          context: { session_id: this.#sessionId },
        },
      );
      this.#lease = lease;
    });
    return this.#leaseRefreshQueue;
  }

  async #assertLease(): Promise<void> {
    if (this.#closed || !this.#lease) throw new SessionFenceLostError(`Writer for ${this.#sessionId} is closed`);
    if (this.#heartbeatFailure) throw this.#heartbeatFailure;

    let current: WriterLeaseFile;
    try {
      current = JSON.parse(await readFile(this.#leasePath, 'utf8')) as WriterLeaseFile;
    } catch (error) {
      throw new SessionFenceLostError(`Writer lease disappeared for session ${this.#sessionId}: ${(error as Error).message}`);
    }
    if (current.token !== this.#token || current.fence !== this.#fence) {
      throw new SessionFenceLostError(`Writer ${this.#token} lost fence ${this.#fence} for session ${this.#sessionId}`);
    }
    const expiresAt = Date.parse(current.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SessionFenceLostError(
        `Writer ${this.#token} lease ${this.#fence} expired for session ${this.#sessionId}`,
      );
    }
  }

  async #reloadConversation(): Promise<void> {
    const records = [...(await recoverConversation(this.#conversationPath))];
    this.#records = records;
    this.#operations = new Map(records.map((record) => [record.operation_id, record]));
    this.#journalStamp = await lstat(this.#conversationPath);
    this.#projections.clear();
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) {
      return Promise.reject(new SessionFenceLostError(`Writer for ${this.#sessionId} is closed`));
    }
    const result = this.#queue.then(task, task);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      await this.#refreshLease();
      const result = await task();
      await this.#assertLease();
      return result;
    });
  }

  /**
   * Drain the session queue, retain the lease while the bundle is renamed, and
   * reject all later work. Unlike a normal mutation there is intentionally no
   * post-operation lease read: the lease path moves with the bundle.
   */
  moveExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) {
      return Promise.reject(
        new SessionFenceLostError(`Writer for ${this.#sessionId} is closed`),
      );
    }
    this.#closing = true;
    const result = this.#queue.then(async () => {
      await this.#refreshLease();
      await this.#assertLease();
      return task();
    });
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  commitTurn(input: WriterCommitInput): Promise<ConversationCommit> {
    validateOperationId(input.operation_id);
    return this.#enqueue(async () => {
      await this.#assertLease();
      await this.#assertConversationUnchanged();
      const previous = this.#operations.get(input.operation_id);
      if (previous) {
        if (previous.request_hash !== input.request_hash) {
          throw new SessionOperationConflictError(
            `operation_id ${input.operation_id} was already committed with different input`,
          );
        }
        return previous;
      }

      await this.#refreshLease();
      const artifacts = [...((await input.prepare_artifacts?.()) ?? [])];
      await this.#assertLease();

      const unsigned: Omit<ConversationCommit, 'hash'> = {
        schema_version: 1,
        seq: this.#records.length + 1,
        operation_id: input.operation_id,
        request_hash: input.request_hash,
        committed_at: new Date().toISOString(),
        prev_hash: this.#records.at(-1)?.hash ?? null,
        payload: input.payload,
        artifacts,
      };
      const record: ConversationCommit = { ...unsigned, hash: commitHash(unsigned) };
      const line = `${JSON.stringify(record)}\n`;

      await this.#faultInjector?.({
        point: 'conversation:before-append',
        session_id: this.#sessionId,
        path: this.#conversationPath,
        operation_id: input.operation_id,
      });

      // The fault hook may pause long enough for the lease to expire. Recheck
      // immediately before opening the append handle; stale writers never
      // reach the journal even if they passed the earlier artifact boundary.
      await this.#assertLease();
      const handle = await open(this.#conversationPath, 'a', 0o600);
      try {
        await handle.writeFile(line);
        await this.#faultInjector?.({
          point: 'conversation:after-write-before-fsync',
          session_id: this.#sessionId,
          path: this.#conversationPath,
          operation_id: input.operation_id,
        });
        await handle.sync();
        await this.#assertLease();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await this.#reloadConversation();
        throw error;
      }
      await handle.close();

      this.#records.push(record);
      this.#operations.set(record.operation_id, record);
      this.#journalStamp = await lstat(this.#conversationPath);
      if (this.#records.length > 100_000 || this.#journalStamp.size > 32 * 1024 * 1024) {
        this.#projections.clear();
      } else {
        for (const [projection, cached] of this.#projections) {
          try { projection.apply(cached.state, record); }
          catch { this.#projections.delete(projection); }
        }
      }
      await this.#faultInjector?.({
        point: 'conversation:after-append',
        session_id: this.#sessionId,
        path: this.#conversationPath,
        operation_id: input.operation_id,
      });
      return record;
    });
  }

  async #releaseLease(leasePath = this.#leasePath): Promise<void> {
    if (!this.#lease) return;
    await this.#leaseRefreshQueue.catch(() => undefined);
    let current: WriterLeaseFile | null = null;
    try {
      current = JSON.parse(await readFile(leasePath, 'utf8')) as WriterLeaseFile;
    } catch {
      current = null;
    }
    if (current?.token === this.#token && current.fence === this.#fence) {
      const releasePath = join(dirname(leasePath), `.writer.lease.release-${this.#token}`);
      try {
        await rename(leasePath, releasePath);
        await unlink(releasePath);
        await fsyncDirectory(dirname(leasePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    }
    this.#lease = null;
  }

  closeAfterMove(movedBundlePath: string): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      this.#closing = true;
      if (this.#heartbeat) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = null;
      }
      await this.#queue.catch(() => undefined);
      this.#closed = true;
      await this.#releaseLease(
        join(movedBundlePath, 'events', 'writer.lease'),
      );
    })();
    return this.#closePromise;
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = (async () => {
      if (this.#closed) return;
      this.#closing = true;
      if (this.#heartbeat) {
        clearInterval(this.#heartbeat);
        this.#heartbeat = null;
      }
      await this.#queue.catch(() => undefined);
      await this.#refreshLease().catch(() => undefined);
      this.#closed = true;
      await this.#releaseLease();
    })();
    return this.#closePromise;
  }
}
