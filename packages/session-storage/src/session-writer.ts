import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { measureStorage, measureStorageSync, recordStorageElapsed } from './storage-timing.js';
import { archiveChapterMessages, ChapterArchiveReader, decodeChapterCommit, detachCommitReplay, type ChapterSpan } from './chapter-transcript.js';
import { ActiveChatTranscript } from './active-chat-transcript.js';
import { CHAT_TRANSCRIPT, CODER_JOURNAL, sessionJournalPath } from './session-journal-path.js';
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
  readonly coderTranscript?: boolean;
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

function validateRecord(record: ConversationCommit, expectedSeq: number, expectedPreviousHash: string | null, metadataOnly: boolean): void {
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
  if (!/^[0-9a-f]{64}$/.test(hash) || (!metadataOnly && hash !== commitHash(unsigned))) {
    throw new ConversationCorruptionError(`Conversation commit hash mismatch at seq ${record.seq}`);
  }
}

export function parseJournalRecord(line: string, bundle: string, seq: number, previousHash: string | null,
  mode: 'full' | 'metadata', reader: ChapterArchiveReader): ConversationCommit {
  let raw: ConversationCommit;
  try { raw = JSON.parse(line) as ConversationCommit; }
  catch (error) { throw new ConversationCorruptionError(`Invalid committed JSON at conversation seq ${seq}: ${(error as Error).message}`); }
  const { commit, metadataOnly } = decodeChapterCommit(raw, bundle, mode, reader);
  validateRecord(commit, seq, previousHash, metadataOnly);
  return commit;
}

function* committedRecords(buffer: Buffer, path: string, mode: 'full' | 'metadata' = 'full'): Generator<ConversationCommit> {
  let previousHash: string | null = null;
  const operationIds = new Set<string>();
  const reader = new ChapterArchiveReader();
  let start = 0;
  for (let seq = 1; start < buffer.length; seq++) {
    const newline = buffer.indexOf(0x0a, start);
    if (newline < 0) return; // An unterminated crash suffix is uncommitted.
    if (newline === start) throw new ConversationCorruptionError(`Blank conversation line at seq ${seq}`);
    const record = parseJournalRecord(buffer.toString('utf8', start, newline), dirname(path), seq, previousHash, mode, reader);
    if (operationIds.has(record.operation_id)) {
      throw new ConversationCorruptionError(`Duplicate operation_id at conversation seq ${record.seq}`);
    }
    operationIds.add(record.operation_id);
    previousHash = record.hash;
    start = newline + 1;
    yield record;
  }
}

export function readConversationSync(conversationPath: string, mode: 'full' | 'metadata' = 'full'): readonly ConversationCommit[] {
  if (!existsSync(conversationPath)) return [];
  return Array.from(committedRecords(readFileSync(conversationPath), conversationPath, mode));
}

/** The binary snapshot and its logical commits must describe the same instant, even if a worker appends during a fork. */
export function readConversationSnapshotSync(path: string) {
  const file = readFileSync(path);
  const bytes = file.subarray(0, file.lastIndexOf(0x0a) + 1);
  return { bytes, commits: Array.from(committedRecords(bytes, path)), detached: path === join(dirname(path), CODER_JOURNAL) };
}

/**
 * Read committed conversation records without blocking the host event loop.
 * Unlike recovery this is read-only: an incomplete crash suffix is ignored but
 * never truncated by an ordinary query.
 */
export async function readConversation(
  conversationPath: string,
  mode: 'full' | 'metadata' = 'full',
): Promise<readonly ConversationCommit[]> {
  let buffer: Buffer;
  try {
    buffer = await readFile(conversationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const records: ConversationCommit[] = [];
  // Only a missing journal can mean an empty conversation. A missing chapter
  // referenced by a committed record must reach the caller as a read error.
  const sliceMs = 6;
  let deadline = performance.now() + sliceMs;
  for (const record of committedRecords(buffer, conversationPath, mode)) {
    records.push(record);
    if (performance.now() >= deadline) {
      await yieldToEventLoop();
      deadline = performance.now() + sliceMs;
    }
  }
  return records;
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

  const records = Array.from(committedRecords(bytes, conversationPath));
  const committedBytes = bytes.lastIndexOf(0x0a) + 1;
  if (bytes.length > committedBytes) {
    const handle = await open(conversationPath, 'r+');
    try {
      await handle.truncate(committedBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return records;
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
  #conversationPath: string;
  readonly #chat?: ActiveChatTranscript;
  #chatNeedsRepair = false;
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
    this.#conversationPath = sessionJournalPath(options.bundlePath);
    if (options.coderTranscript || this.#conversationPath === join(options.bundlePath, CODER_JOURNAL)) {
      this.#chat = new ActiveChatTranscript(options.bundlePath, {
        faultInjector: options.faultInjector, context: { session_id: options.sessionId }, beforePublish: () => this.#assertLease(),
      });
    }
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

  static async open(options: SessionWriterOptions, onProgress?: () => void): Promise<SessionWriter> {
    const writer = new SessionWriter(options);
    await writer.#initialize(onProgress);
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
      if (this.#chatNeedsRepair) await this.refreshChatTranscript();
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

  async #initialize(onProgress?: () => void): Promise<void> {
    await ensureDirectoryTreeNoLinks(this.#bundlePath, join(this.#bundlePath, 'events'));
    await assertPathHasNoLinks(this.#bundlePath, this.#conversationPath);
    await this.#acquireLease();
    try {
      this.#conversationPath = sessionJournalPath(this.#bundlePath);
      await collectSessionTransientFiles(this.#bundlePath, onProgress);
      await this.#reloadConversation();
      onProgress?.();
      if (this.#chat) {
        const spans = this.#chat.checkpoints();
        if (this.#conversationPath === join(this.#bundlePath, CHAT_TRANSCRIPT)) {
          const journal = join(this.#bundlePath, CODER_JOURNAL);
          await archiveChapterMessages(journal, spans, {
            faultInjector: this.#faultInjector, context: { session_id: this.#sessionId },
          }, async () => { await this.#assertLease(); await this.#assertConversationUnchanged(); }, this.#records, onProgress);
          this.#conversationPath = journal;
          await this.#reloadConversation();
        } else if (spans.length) {
          // A previous process may have committed the checkpoint and exited before moving the records.
          await this.#archive(spans, onProgress);
        }
        await this.#chat.rebuild(this.#records);
      }
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
    return measureStorage('lease.refresh', () => this.#refreshLeaseCore());
  }

  #refreshLeaseCore(): Promise<void> {
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
      const expiresAt = Date.parse(current.expires_at);
      if (!Number.isFinite(expiresAt)) {
        throw new SessionFenceLostError(`Writer ${this.#token} lease ${this.#fence} expired for session ${this.#sessionId}`);
      }
      if (expiresAt <= now) {
        // A suspended event loop or slow disk can delay the heartbeat. TTL is
        // a liveness hint, not a transfer of authority: acquisition refuses to
        // steal from a live process and isolate recovery requires observed exit.
        // Renew only our exact last lease with its durable fence still intact.
        // A replacement, external edit, or revoked fence remains terminal.
        const known = this.#lease;
        if (!known || current.expires_at !== known.expires_at
          || current.acquired_at !== known.acquired_at
          || current.pid !== process.pid || current.owner_host !== hostname()
          || current.owner_id !== this.#ownerId
          || await this.#readFence() !== this.#fence) {
          throw new SessionFenceLostError(`Writer ${this.#token} lease ${this.#fence} expired for session ${this.#sessionId}`);
        }
      }
      // Keep validating ownership on every mutation, but renew a healthy lease
      // only once per heartbeat interval. Rewriting/fsyncing the same lease for
      // every output and metric serialized redundant disk flushes into turns.
      if (expiresAt - now > this.#leaseTtlMs * 2 / 3) return;
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
    return measureStorage('lease.assert', () => this.#assertLeaseCore());
  }

  async #assertLeaseCore(): Promise<void> {
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
    if (!Number.isFinite(expiresAt)) {
      throw new SessionFenceLostError(
        `Writer ${this.#token} lease ${this.#fence} expired for session ${this.#sessionId}`,
      );
    }
    if (expiresAt <= Date.now()) await this.#refreshLease();
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
    const queuedAt = performance.now();
    const run = () => {
      recordStorageElapsed('writer.queue', queuedAt);
      return task();
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      await this.#refreshLease();
      if (this.#chatNeedsRepair) await this.refreshChatTranscript();
      const result = await task();
      await this.#assertLease();
      return result;
    });
  }

  archiveChapters(spans: readonly ChapterSpan[]): Promise<void> {
    return this.#enqueue(async () => {
      await this.#assertLease();
      await this.#assertConversationUnchanged();
      await this.#archive(spans);
      await this.refreshChatTranscript();
    });
  }

  /** Called inside the existing writer queue after changing chapter/state boundaries. */
  async refreshChatTranscript(): Promise<void> {
    if (!this.#chat) return;
    this.#chatNeedsRepair = true;
    this.#chat.checkpoints();
    await this.#chat.rebuild(this.#records);
    this.#chatNeedsRepair = false;
  }

  async #archive(spans: readonly ChapterSpan[], onProgress?: () => void): Promise<void> {
    try {
      if (await archiveChapterMessages(this.#conversationPath, spans, {
        faultInjector: this.#faultInjector, context: { session_id: this.#sessionId },
      }, async () => { await this.#assertLease(); await this.#assertConversationUnchanged(); }, undefined, onProgress)) {
        this.#journalStamp = await lstat(this.#conversationPath);
      }
    } catch (error) {
      // The rename may already have succeeded when a later fsync fails.
      await this.#assertLease();
      await this.#reloadConversation();
      throw error;
    }
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
      if (this.#chatNeedsRepair) await this.refreshChatTranscript();
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
      const record: ConversationCommit = { ...unsigned, hash: measureStorageSync('journal.hash', () => commitHash(unsigned)) };
      const physical = this.#chat ? await detachCommitReplay(this.#bundlePath, record, {
        faultInjector: this.#faultInjector, context: { session_id: this.#sessionId },
      }) : record;
      const line = this.#chat ? await this.#chat.encode(physical) : measureStorageSync('journal.serialize', () => `${JSON.stringify(physical)}\n`);
      // Retain only the replay reference in the writer's long-lived operation
      // and projection caches, including for turns committed in this process.
      const committed = physical === record ? record : decodeChapterCommit(physical, this.#bundlePath, 'full', new ChapterArchiveReader()).commit;

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
      const handle = await measureStorage('journal.open', () => open(this.#conversationPath, 'a', 0o600));
      try {
        await measureStorage('journal.write', () => handle.writeFile(line));
        await measureStorage('journal.fsync', async () => {
          await this.#faultInjector?.({
          point: 'conversation:after-write-before-fsync',
          session_id: this.#sessionId,
          path: this.#conversationPath,
          operation_id: input.operation_id,
          });
          await handle.sync();
        });
        await this.#assertLease();
      } catch (error) {
        await handle.close().catch(() => undefined);
        this.#chatNeedsRepair = !!this.#chat;
        await this.#reloadConversation();
        throw error;
      }
      await handle.close();

      this.#records.push(committed);
      this.#operations.set(committed.operation_id, committed);
      this.#journalStamp = await lstat(this.#conversationPath);
      if (this.#chat) {
        this.#chatNeedsRepair = true;
        try { await this.#chat.appended(committed, this.#records); }
        catch (error) { this.#projections.clear(); throw error; }
        this.#chatNeedsRepair = false;
      }
      if (this.#records.length > 100_000 || this.#journalStamp.size > 32 * 1024 * 1024) {
        this.#projections.clear();
      } else {
        for (const [projection, cached] of this.#projections) {
          try { projection.apply(cached.state, committed); }
          catch { this.#projections.delete(projection); }
        }
      }
      await this.#faultInjector?.({
        point: 'conversation:after-append',
        session_id: this.#sessionId,
        path: this.#conversationPath,
        operation_id: input.operation_id,
      });
      return committed;
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
