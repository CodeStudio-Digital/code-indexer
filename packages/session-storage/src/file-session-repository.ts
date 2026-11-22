import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ArtifactStore,
  type ArtifactReader,
} from './artifact-store.js';
import { recoverSessionArtifacts } from './artifact-recovery.js';
import {
  atomicCopyFile,
  atomicWriteFile,
  atomicWriteJson,
  canonicalJson,
  durableRename,
} from './atomic-file.js';
import {
  assertContainedPath,
  assertPathHasNoLinks,
  assertPathHasNoLinksSync,
  assertSafeFileName,
  ensureDirectoryTreeNoLinks,
  removeTreeNoLinks,
  UnsafeSessionPathError,
} from './path-safety.js';
import { SessionLocator } from './session-locator.js';
import { removeSideChatFile } from './side-chat-file.js';
import { readSessionProjection } from './read-session-projection.js';
import {
  emptySessionMetricsSummary,
  readSessionMetricsSummarySync,
  rebuildSessionMetricsSummary,
  calculateSessionMetricsProjection,
  appendSessionMetric,
  type SessionMetricsProjection,
} from './metrics-summary.js';
import {
  initialSessionMetadata,
  initialSessionState,
} from './session-initial-state.js';
import {
  computeRequestHash,
  readConversation,
  readConversationSync,
  SessionLeaseHeldError,
  SessionWriter,
  type SessionWriterOptions,
  type WriterProjection,
} from './session-writer.js';
import {
  newSessionId,
  asSessionId,
  isUuid,
  type CatalogEntry,
  type CommitTurnInput,
  type ConversationCommit,
  type CreateSessionInput,
  type JsonValue,
  type SessionLocation,
  type SessionMetadata,
  type SessionMetricsSummary,
  type SessionRepositoryEvent,
  type SessionState,
  type SessionStorageFaultInjector,
  type ToolOutputInput,
  type ToolOutputRecord,
} from './types.js';

import { DiagnosticQueue } from './diagnostic-queue.js';
import { traceStorageOperation } from './storage-timing.js';

export const SESSION_LAYOUT_VERSION = 1 as const;

export const SESSION_BUNDLE_DIRECTORIES = [
  'attachments',
  'tools_outputs',
  'snapshots',
  'metrics',
  'metrics/turns',
  'metrics/provider_attempts',
  'metrics/pipeline_stages',
  'events',
  'checkpoints',
  'chapters',
  'plans',
  'tasks',
  'inputs',
  'memory',
  'subagents',
  'company',
] as const;

export type SessionEntityDirectory =
  | 'snapshots'
  | 'events'
  | 'checkpoints'
  | 'chapters'
  | 'plans'
  | 'tasks'
  | 'inputs'
  | 'memory'
  | 'subagents'
  | 'company'
  | 'metrics/turns'
  | 'metrics/provider_attempts'
  | 'metrics/pipeline_stages';

export interface FileSessionRepositoryOptions {
  readonly locator: SessionLocator;
  /** Opaque coordinator identity copied into every writer lease. */
  readonly writerOwnerId?: string;
  readonly leaseTtlMs?: number;
  readonly faultInjector?: SessionStorageFaultInjector;
  /**
   * Defaults to a module-global process registry. Tests may inject a fresh set
   * to model a process restart without spawning another Node process.
   */
  readonly artifactRecoveryRegistry?: Set<string>;
}

export interface TrashResult {
  readonly location: SessionLocation;
  readonly trash_path: string;
  readonly trash_name: string;
  readonly trashed_at: string;
}

export interface SessionProjectionEntityWrite {
  readonly directory: SessionEntityDirectory;
  readonly id: string;
  readonly value: JsonValue;
}

export interface SessionProjectionBatchInput {
  readonly update_session?: (
    current: SessionMetadata,
  ) => SessionMetadata;
  readonly update_state?: (
    current: SessionState,
  ) => SessionState;
  readonly entities?: readonly SessionProjectionEntityWrite[];
  readonly metrics_summary?: SessionMetricsSummary;
}

export interface SessionProjectionBatchResult {
  readonly session: SessionMetadata | null;
  readonly state: SessionState | null;
}

export interface RestoreResult extends CatalogEntry {
  readonly restored_from: string;
}

export interface TrashedSessionEntry {
  readonly trash_name: string;
  readonly trash_path: string;
  readonly trashed_at: string;
  readonly scope: SessionLocation['scope'];
  readonly metadata: SessionMetadata;
}

const UUID_FRAGMENT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TRASH_BUNDLE_NAME = new RegExp(
  `^(${UUID_FRAGMENT})-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)-(${UUID_FRAGMENT})$`,
);

function parseTrashBundleName(
  value: string,
): { readonly session_id: SessionLocation['session_id']; readonly trashed_at: string } {
  assertSafeFileName(value, 'trash bundle name');
  const match = TRASH_BUNDLE_NAME.exec(value);
  if (!match) {
    throw new UnsafeSessionPathError('Invalid trash bundle name');
  }
  const [, rawSessionId, rawTimestamp] = match;
  const timestamp = rawTimestamp.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1$2:$3:$4.$5',
  );
  const parsedTimestamp = new Date(timestamp);
  if (!Number.isFinite(parsedTimestamp.getTime())) {
    throw new UnsafeSessionPathError('Invalid trash bundle timestamp');
  }
  return {
    session_id: asSessionId(rawSessionId),
    trashed_at: parsedTimestamp.toISOString(),
  };
}

function cacheKey(location: SessionLocation): string {
  const value = resolve(location.bundle_path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function parseJsonFileSync<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
}

function assertSerializable(value: unknown): void {
  canonicalJson(value);
}

const PROCESS_ARTIFACT_RECOVERY_REGISTRY = new Set<string>();

export class FileSessionRepository {
  readonly #locator: SessionLocator;
  readonly #leaseTtlMs?: number;
  readonly #writerOwnerId?: string;
  readonly #faultInjector?: SessionStorageFaultInjector;
  readonly #writers = new Map<string, Promise<SessionWriter>>();
  readonly #projectionMutations = new Map<string, Promise<void>>();
  readonly #metricProjections = new WeakMap<SessionWriter, SessionMetricsProjection>();
  readonly #sessionCache = new Map<string, SessionMetadata>();
  readonly #stateCache = new Map<string, SessionState>();
  readonly #metricsCache = new Map<
    string,
    {
      readonly mtimeMs: number;
      readonly ctimeMs: number;
      readonly size: number;
      readonly summary: SessionMetricsSummary;
    }
  >();
  readonly #listeners = new Set<(event: SessionRepositoryEvent) => void>();
  readonly #moving = new Set<string>();
  readonly #artifactRecoveryRegistry: Set<string>;
  readonly #diagnostics = new DiagnosticQueue(error => {
    console.warn('[session-storage] diagnostic write failed:', error instanceof Error ? error.message : String(error));
  });

  constructor(options: FileSessionRepositoryOptions) {
    this.#locator = options.locator;
    this.#writerOwnerId = options.writerOwnerId;
    this.#leaseTtlMs = options.leaseTtlMs;
    this.#faultInjector = options.faultInjector;
    this.#artifactRecoveryRegistry =
      options.artifactRecoveryRegistry ??
      PROCESS_ARTIFACT_RECOVERY_REGISTRY;
  }

  get locator(): SessionLocator {
    return this.#locator;
  }

  subscribe(listener: (event: SessionRepositoryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: SessionRepositoryEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async createSession(input: CreateSessionInput): Promise<CatalogEntry> {
    assertSerializable(input);
    const id =
      input.id === undefined
        ? newSessionId()
        : asSessionId(String(input.id));
    const ensuredRoot = await this.#locator.ensureSessionRoot(input.scope);
    const location: SessionLocation = {
      session_id: id,
      scope: input.scope,
      session_root: ensuredRoot,
      bundle_path: join(ensuredRoot, id),
    };
    assertContainedPath(ensuredRoot, location.bundle_path);

    const stagingName = `.creating-${id}-${randomUUID()}`;
    const stagingPath = join(ensuredRoot, stagingName);
    assertContainedPath(ensuredRoot, stagingPath);
    const now = new Date().toISOString();
    const session = initialSessionMetadata(input, id, now);
    const state = initialSessionState(input, now);

    await mkdir(stagingPath, { mode: 0o700 });
    try {
      await Promise.all(
        SESSION_BUNDLE_DIRECTORIES.map((relativeDirectory) =>
          mkdir(join(stagingPath, ...relativeDirectory.split('/')), {
            recursive: true,
            mode: 0o700,
          }),
        ),
      );
      const atomicOptions = {
        faultInjector: this.#faultInjector,
        context: { session_id: id },
      };
      // These projections are independent and the staging directory is not
      // visible until durableRename publishes it. Persist them concurrently so
      // a slow project volume pays one fsync wave instead of five serial ones.
      await Promise.all([
        atomicWriteJson(join(stagingPath, 'session.json'), session, atomicOptions),
        atomicWriteJson(join(stagingPath, 'state.json'), state, atomicOptions),
        atomicWriteFile(join(stagingPath, 'conversation.jsonl'), '', atomicOptions),
        atomicWriteJson(
          join(stagingPath, 'metrics', 'summary.json'),
          emptySessionMetricsSummary(now),
          atomicOptions,
        ),
        atomicWriteJson(
          join(stagingPath, 'migration.json'),
          {
            schema_version: 1,
            source: input.migration?.source ?? 'native',
            completed_at: input.migration?.completed_at ?? now,
            ...(input.migration?.legacy_id === undefined ? {} : { legacy_id: input.migration.legacy_id }),
          },
          atomicOptions,
        ),
      ]);
      await this.#faultInjector?.({
        point: 'session:before-publish',
        session_id: id,
        path: stagingPath,
      });
      await durableRename(stagingPath, location.bundle_path, atomicOptions);
    } catch (error) {
      if (existsSync(stagingPath)) {
        await removeTreeNoLinks(ensuredRoot, stagingPath).catch(() => undefined);
      }
      throw error;
    }

    this.#sessionCache.set(cacheKey(location), session);
    this.#stateCache.set(cacheKey(location), state);
    // A bundle created by this process has no pre-existing orphan blobs. Mark
    // it before callers can perform a direct put that will be referenced by a
    // later mutation.
    this.#artifactRecoveryRegistry.add(cacheKey(location));
    this.#emit({ type: 'created', location });
    return { location, session, state };
  }

  /**
   * Clone the immutable coder transcript projections into a freshly-created
   * target bundle. Artifact/entity files become durable first and the journal
   * is published last, so an interrupted copy never exposes commits whose
   * referenced files are missing. The target must not have opened a writer.
   */
  async cloneConversationProjection(
    source: SessionLocation,
    target: SessionLocation,
    commits: readonly ConversationCommit[],
  ): Promise<void> {
    this.#assertReadableLocation(source);
    this.#assertReadableLocation(target);
    if (cacheKey(source) === cacheKey(target)) {
      throw new Error('Conversation clone target must differ from its source');
    }
    if (this.#writers.has(cacheKey(target))) {
      throw new Error(
        `Cannot clone into session ${target.session_id} after its writer has opened`,
      );
    }

    const atomicOptions = {
      faultInjector: this.#faultInjector,
      context: { session_id: target.session_id },
    };
    const copyTree = async (
      sourceDirectory: string,
      targetDirectory: string,
    ): Promise<void> => {
      await assertPathHasNoLinks(source.bundle_path, sourceDirectory);
      await ensureDirectoryTreeNoLinks(target.bundle_path, targetDirectory);
      const entries = await readdir(sourceDirectory, { withFileTypes: true });
      // Bound fan-out so Windows volumes can overlap independent fsyncs without
      // exhausting file handles on sessions with thousands of tool artifacts.
      for (let offset = 0; offset < entries.length; offset += 16) {
        await Promise.all(entries.slice(offset, offset + 16).map(async (entry) => {
          assertSafeFileName(entry.name, 'conversation projection path');
          const sourcePath = join(sourceDirectory, entry.name);
          const targetPath = join(targetDirectory, entry.name);
          assertContainedPath(source.bundle_path, sourcePath);
          assertContainedPath(target.bundle_path, targetPath);
          const sourceStat = await lstat(sourcePath);
          if (sourceStat.isSymbolicLink()) {
            throw new UnsafeSessionPathError(
              `Refusing to clone symbolic link: ${sourcePath}`,
            );
          }
          if (sourceStat.isDirectory()) {
            await copyTree(sourcePath, targetPath);
            return;
          }
          if (!sourceStat.isFile()) {
            throw new UnsafeSessionPathError(
              `Refusing to clone non-file projection: ${sourcePath}`,
            );
          }
          await atomicCopyFile(sourcePath, targetPath, atomicOptions);
        }));
      }
    };

    // These directories are precisely the projections produced by the old
    // message-by-message replay path. Plans/tasks/memory/runtime events remain
    // intentionally session-local.
    await Promise.all(
      ['attachments', 'tools_outputs', 'metrics', 'chapters'].map((directory) =>
        copyTree(
          join(source.bundle_path, directory),
          join(target.bundle_path, directory),
        ),
      ),
    );
    const conversation = commits.length === 0
      ? ''
      : `${commits.map((commit) => JSON.stringify(commit)).join('\n')}\n`;
    await atomicWriteFile(
      join(target.bundle_path, 'conversation.jsonl'),
      conversation,
      atomicOptions,
    );
    this.#metricsCache.delete(cacheKey(target));
    this.#emit({ type: 'updated', location: target });
  }

  assertLocationMatchesResolver(location: SessionLocation): void {
    const expected = this.#locator.locate(location.scope, location.session_id);
    if (
      resolve(expected.bundle_path) !== resolve(location.bundle_path) ||
      resolve(expected.session_root) !== resolve(location.session_root)
    ) {
      throw new UnsafeSessionPathError(`Session location does not match resolver: ${location.bundle_path}`);
    }
    assertContainedPath(location.session_root, location.bundle_path);
  }

  #assertReadableLocation(location: SessionLocation): void {
    this.assertLocationMatchesResolver(location);
    assertPathHasNoLinksSync(location.session_root, location.bundle_path);
    const stat = lstatSync(location.bundle_path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new UnsafeSessionPathError(`Unsafe session bundle: ${location.bundle_path}`);
    }
  }

  readSessionSync(location: SessionLocation): SessionMetadata {
    this.#assertReadableLocation(location);
    const path = join(location.bundle_path, 'session.json');
    assertPathHasNoLinksSync(location.bundle_path, path);
    const session = parseJsonFileSync<SessionMetadata>(path);
    if (session.id !== location.session_id) {
      throw new Error(`session.json id does not match bundle ${location.bundle_path}`);
    }
    this.#sessionCache.set(cacheKey(location), session);
    return session;
  }

  readStateSync(location: SessionLocation): SessionState {
    this.#assertReadableLocation(location);
    const path = join(location.bundle_path, 'state.json');
    assertPathHasNoLinksSync(location.bundle_path, path);
    const state = parseJsonFileSync<SessionState>(path);
    this.#stateCache.set(cacheKey(location), state);
    return state;
  }

  readConversationSync(location: SessionLocation): readonly ConversationCommit[] {
    this.#assertReadableLocation(location);
    const path = join(location.bundle_path, 'conversation.jsonl');
    assertPathHasNoLinksSync(location.bundle_path, path);
    return readConversationSync(path);
  }

  async readConversation(
    location: SessionLocation,
  ): Promise<readonly ConversationCommit[]> {
    this.#assertReadableLocation(location);
    const path = join(location.bundle_path, 'conversation.jsonl');
    assertContainedPath(location.bundle_path, path);
    await assertPathHasNoLinks(location.bundle_path, path);
    return readConversation(path);
  }

  readMetricsSummarySync(location: SessionLocation): SessionMetricsSummary {
    this.#assertReadableLocation(location);
    const path = join(location.bundle_path, 'metrics', 'summary.json');
    assertPathHasNoLinksSync(location.bundle_path, path);
    const stat = statSync(path);
    const key = cacheKey(location);
    const cached = this.#metricsCache.get(key);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs &&
      cached.size === stat.size
    ) {
      return cached.summary;
    }
    const summary = readSessionMetricsSummarySync(location.bundle_path);
    this.#metricsCache.set(key, {
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      size: stat.size,
      summary,
    });
    return summary;
  }

  getCachedSession(location: SessionLocation): SessionMetadata | null {
    return this.#sessionCache.get(cacheKey(location)) ?? null;
  }

  getCachedState(location: SessionLocation): SessionState | null {
    return this.#stateCache.get(cacheKey(location)) ?? null;
  }

  /**
   * Re-read projections written by another authority (for example a coder
   * worker) and notify the in-memory catalog without acquiring the writer
   * lease in this process.
   */
  refreshSessionProjection(location: SessionLocation): void {
    this.readSessionSync(location);
    this.readStateSync(location);
    this.#emit({ type: 'updated', location });
  }

  async refreshSessionProjectionAsync(location: SessionLocation): Promise<void> {
    const projection = await readSessionProjection(this.#locator, location);
    this.#sessionCache.set(cacheKey(location), projection.session);
    this.#stateCache.set(cacheKey(location), projection.state);
    this.#emit({ type: 'updated', location, projection });
  }

  #writer(
    location: SessionLocation,
    options: { readonly allowMoving?: boolean } = {},
  ): Promise<SessionWriter> {
    const key = cacheKey(location);
    if (this.#moving.has(key) && options.allowMoving !== true) {
      return Promise.reject(new Error(`Session ${location.session_id} is being moved to trash`));
    }
    const existing = this.#writers.get(key);
    if (existing) return existing;

    const writerOptions: SessionWriterOptions = {
      bundlePath: location.bundle_path,
      sessionId: location.session_id,
      ...(this.#writerOwnerId ? { ownerId: this.#writerOwnerId } : {}),
      leaseTtlMs: this.#leaseTtlMs,
      faultInjector: this.#faultInjector,
    };
    const opening = this.#locator
      .assertSafeLocation(location, { mustExist: true })
      .then(async () => {
        const writer = await SessionWriter.open(writerOptions);
        try {
          if (!this.#artifactRecoveryRegistry.has(key)) {
            await writer.runExclusive(() =>
              recoverSessionArtifacts({
                bundlePath: location.bundle_path,
                sessionId: location.session_id,
                faultInjector: this.#faultInjector,
              }),
            );
            this.#artifactRecoveryRegistry.add(key);
          }
          return writer;
        } catch (error) {
          await writer.close().catch(() => undefined);
          throw error;
        }
      })
      .catch((error) => {
        this.#writers.delete(key);
        throw error;
      });
    this.#writers.set(key, opening);
    return opening;
  }

  async primeSession(location: SessionLocation): Promise<void> {
    await this.#writer(location);
  }

  async readWriterProjection<T>(location: SessionLocation, projection: WriterProjection<T>): Promise<T> {
    const writer = await this.#writer(location);
    return writer.readProjection(projection);
  }

  async artifactStore(location: SessionLocation): Promise<ArtifactStore> {
    await this.primeSession(location);
    return new ArtifactStore({
      bundlePath: location.bundle_path,
      sessionId: location.session_id,
      faultInjector: this.#faultInjector,
    });
  }

  artifactReader(location: SessionLocation): ArtifactReader {
    this.#assertReadableLocation(location);
    return new ArtifactStore({
      bundlePath: location.bundle_path,
      sessionId: location.session_id,
      faultInjector: this.#faultInjector,
    });
  }

  async commitTurn(location: SessionLocation, input: CommitTurnInput): Promise<ConversationCommit> {
    assertSerializable(input.payload);
    const artifactStore = new ArtifactStore({
      bundlePath: location.bundle_path,
      sessionId: location.session_id,
      faultInjector: this.#faultInjector,
    });
    const descriptions = (input.artifacts ?? []).map((artifact) => artifactStore.describe(artifact));
    const requestHash = computeRequestHash({ payload: input.payload, artifacts: descriptions });
    const writer = await this.#writer(location);
    const record = await writer.commitTurn({
      operation_id: input.operation_id,
      request_hash: requestHash,
      payload: input.payload,
      prepare_artifacts: async () =>
        Promise.all((input.artifacts ?? []).map((artifact) => artifactStore.put(artifact))),
    });
    if (input.touch_session !== false) {
      await this.#touchSession(location, writer);
    }
    this.#emit({ type: 'updated', location });
    return record;
  }

  async #touchSession(location: SessionLocation, writer: SessionWriter): Promise<void> {
    await writer.runExclusive(async () => {
      const session = this.readSessionSync(location);
      const next: SessionMetadata = { ...session, updated_at: new Date().toISOString() };
      await atomicWriteJson(join(location.bundle_path, 'session.json'), next, {
        faultInjector: this.#faultInjector,
        context: { session_id: location.session_id },
      });
      this.#sessionCache.set(cacheKey(location), next);
    });
  }

  /** Company metadata is edited by both HTTP and its worker. Keep its lease
   * only for the atomic mutation; coder journals retain their long-lived owner.
   * Retry acquisition only, never a callback whose write may already have run. */
  #withProjectionWriter<T>(
    location: SessionLocation,
    mutate: (writer: SessionWriter) => Promise<T>,
  ): Promise<T> {
    const kind = this.readSessionSync(location).kind;
    if (kind !== 'company' && kind !== 'app_studio') {
      return this.#writer(location).then(mutate);
    }
    const key = cacheKey(location);
    const previous = this.#projectionMutations.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      const deadline = Date.now() + 5_000;
      let writer: SessionWriter;
      for (;;) {
        try { writer = await this.#writer(location); break; }
        catch (error) {
          if (!(error instanceof SessionLeaseHeldError) || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 25 + Math.random() * 25));
        }
      }
      try { return await mutate(writer); }
      finally { await this.closeSession(location); }
    });
    const settled = result.then(() => undefined, () => undefined);
    this.#projectionMutations.set(key, settled);
    void settled.then(() => {
      if (this.#projectionMutations.get(key) === settled) this.#projectionMutations.delete(key);
    });
    return result;
  }

  async updateSession(
    location: SessionLocation,
    update: (current: SessionMetadata) => SessionMetadata,
  ): Promise<SessionMetadata> {
    const next = await this.#withProjectionWriter(location, writer => writer.runExclusive(async () => {
      const current = this.readSessionSync(location);
      const updated = update(current);
      if (updated.id !== current.id || updated.schema_version !== 1) {
        throw new Error('Session metadata update cannot change id or schema_version');
      }
      const value = { ...updated, updated_at: new Date().toISOString() };
      assertSerializable(value);
      await atomicWriteJson(join(location.bundle_path, 'session.json'), value, {
        faultInjector: this.#faultInjector,
        context: { session_id: location.session_id },
      });
      this.#sessionCache.set(cacheKey(location), value);
      return value;
    }));
    this.#emit({ type: 'updated', location });
    return next;
  }

  async updateState(
    location: SessionLocation,
    update: (current: SessionState) => SessionState,
  ): Promise<SessionState> {
    const next = await this.#withProjectionWriter(location, writer => writer.runExclusive(async () => {
      const current = this.readStateSync(location);
      const updated = update(current);
      if (updated.schema_version !== 1) throw new Error('State update cannot change schema_version');
      const value = { ...updated, updated_at: new Date().toISOString() };
      assertSerializable(value);
      await atomicWriteJson(join(location.bundle_path, 'state.json'), value, {
        faultInjector: this.#faultInjector,
        context: { session_id: location.session_id },
      });
      this.#stateCache.set(cacheKey(location), value);
      return value;
    }));
    this.#emit({ type: 'updated', location });
    return next;
  }

  /**
   * Publish independent projections from one canonical mutation in a single
   * durability wave. The per-session writer still fences the whole batch, but
   * each temp+fsync+rename can progress concurrently because the files do not
   * overlap. A crash may expose only part of the projection batch; replaying
   * the canonical journal operation repairs it idempotently.
   */
  async updateProjectionBatch(
    location: SessionLocation,
    input: SessionProjectionBatchInput,
  ): Promise<SessionProjectionBatchResult> {
    const writer = await this.#writer(location);
    const result = await writer.runExclusive(async () => {
      if (input.metrics_summary || input.entities?.some((entity) =>
        entity.directory === 'metrics/turns' || entity.directory === 'metrics/provider_attempts')) {
        this.#metricProjections.delete(writer);
      }
      const updatedAt = new Date().toISOString();
      let session: SessionMetadata | null = null;
      let state: SessionState | null = null;

      if (input.update_session) {
        const current = this.readSessionSync(location);
        const updated = input.update_session(current);
        if (updated.id !== current.id || updated.schema_version !== 1) {
          throw new Error('Session metadata update cannot change id or schema_version');
        }
        session = { ...updated, updated_at: updatedAt };
        assertSerializable(session);
      }
      if (input.update_state) {
        const current = this.readStateSync(location);
        const updated = input.update_state(current);
        if (updated.schema_version !== 1) {
          throw new Error('State update cannot change schema_version');
        }
        state = { ...updated, updated_at: updatedAt };
        assertSerializable(state);
      }

      const writes: Array<{ readonly target: string; readonly value: JsonValue }> = [];
      if (session) {
        writes.push({
          target: join(location.bundle_path, 'session.json'),
          value: session as unknown as JsonValue,
        });
      }
      if (state) {
        writes.push({
          target: join(location.bundle_path, 'state.json'),
          value: state as unknown as JsonValue,
        });
      }
      for (const entity of input.entities ?? []) {
        assertSafeFileName(entity.id, 'entity id');
        assertSerializable(entity.value);
        const entityDirectory = join(
          location.bundle_path,
          ...entity.directory.split('/'),
        );
        assertContainedPath(location.bundle_path, entityDirectory);
        assertPathHasNoLinksSync(location.bundle_path, entityDirectory);
        const target = join(entityDirectory, `${entity.id}.json`);
        assertContainedPath(entityDirectory, target);
        writes.push({ target, value: entity.value });
      }
      if (input.metrics_summary) {
        if (input.metrics_summary.schema_version !== 1) {
          throw new Error('Metrics summary update cannot change schema_version');
        }
        assertSerializable(input.metrics_summary);
        writes.push({
          target: join(location.bundle_path, 'metrics', 'summary.json'),
          value: input.metrics_summary as unknown as JsonValue,
        });
      }
      if (writes.length === 0) {
        throw new Error('Projection batch must contain at least one write');
      }
      const targets = new Set(writes.map((write) => resolve(write.target)));
      if (targets.size !== writes.length) {
        throw new Error('Projection batch contains duplicate target files');
      }

      const atomicOptions = {
        faultInjector: this.#faultInjector,
        context: { session_id: location.session_id },
      };
      await Promise.all(
        writes.map((write) =>
          atomicWriteJson(write.target, write.value, atomicOptions),
        ),
      );
      if (session) this.#sessionCache.set(cacheKey(location), session);
      if (state) this.#stateCache.set(cacheKey(location), state);
      if (input.metrics_summary) this.#metricsCache.delete(cacheKey(location));
      return { session, state };
    });
    this.#emit({ type: 'updated', location });
    return result;
  }

  /**
   * Serialize an operational entity mutation behind the session writer lease.
   * This lets independent Company/App Studio entity files retain their
   * own atomic writes while sharing one fencing boundary for the bundle.
   */
  async runExclusive<T>(
    location: SessionLocation,
    operation: () => Promise<T>,
  ): Promise<T> {
    const writer = await this.#writer(location);
    const result = await writer.runExclusive(async () => {
      const value = await operation();
      const current = this.readSessionSync(location);
      const next: SessionMetadata = {
        ...current,
        updated_at: new Date().toISOString(),
      };
      await atomicWriteJson(join(location.bundle_path, 'session.json'), next, {
        faultInjector: this.#faultInjector,
        context: { session_id: location.session_id },
      });
      this.#sessionCache.set(cacheKey(location), next);
      return value;
    });
    this.#emit({ type: 'updated', location });
    return result;
  }

  archiveSession(location: SessionLocation): Promise<SessionState> {
    return this.updateState(location, (current) => ({
      ...current,
      archived_at: current.archived_at ?? new Date().toISOString(),
    })).then((state) => {
      this.#emit({ type: 'archived', location });
      return state;
    });
  }

  async writeToolOutput(location: SessionLocation, input: ToolOutputInput): Promise<ToolOutputRecord> {
    assertSerializable(input.metadata ?? {});
    const writer = await this.#writer(location);
    return writer.runExclusive(async () => {
      const artifactStore = new ArtifactStore({
        bundlePath: location.bundle_path,
        sessionId: location.session_id,
        faultInjector: this.#faultInjector,
      });
      const result = await artifactStore.putToolOutput(input);
      this.#emit({ type: 'updated', location });
      return result;
    });
  }

  async writeEntity(
    location: SessionLocation,
    directory: SessionEntityDirectory,
    id: string,
    value: JsonValue,
    beforePublish?: () => void,
  ): Promise<string> {
    assertSafeFileName(id, 'entity id');
    assertSerializable(value);
    const writer = await this.#writer(location);
    return writer.runExclusive(async () => {
      const entityDirectory = join(location.bundle_path, ...directory.split('/'));
      await ensureDirectoryTreeNoLinks(location.bundle_path, entityDirectory);
      const target = join(entityDirectory, `${id}.json`);
      assertContainedPath(entityDirectory, target);
      const newMetric = !existsSync(target);
      const metricDirectory = directory === 'metrics/turns' || directory === 'metrics/provider_attempts';
      try {
        await atomicWriteJson(target, value, {
          beforePublish,
          faultInjector: this.#faultInjector,
          context: { session_id: location.session_id },
        });
        if (metricDirectory) {
          const previous = this.#metricProjections.get(writer);
          const projection = (newMetric && previous ? appendSessionMetric(previous, directory, value) : null)
            ?? calculateSessionMetricsProjection(location.bundle_path);
          const before = previous?.summary;
          const after = projection.summary;
          const totalsUnchanged = before !== undefined
            && before.turns === after.turns && before.tool_calls === after.tool_calls
            && before.provider_attempts === after.provider_attempts
            && before.tokens.input === after.tokens.input && before.tokens.output === after.tokens.output
            && before.tokens.cache_read === after.tokens.cache_read
            && before.tokens.cache_creation === after.tokens.cache_creation;
          // Diagnostic turn rows have zero accounting contribution. Their own
          // file is durable above; rewriting and fsyncing identical summary
          // totals would hold the same writer queue used by the conversation.
          if (totalsUnchanged) projection.summary = before;
          else await atomicWriteJson(join(location.bundle_path, 'metrics', 'summary.json'), after, {
            faultInjector: this.#faultInjector,
            context: { session_id: location.session_id },
          });
          this.#metricProjections.set(writer, projection);
        }
      } catch (error) {
        // Even an entity write can fail after rename. Its durable outcome is
        // ambiguous, so the next metric must rebuild instead of incrementing
        // a projection that may have missed an already-published record.
        if (metricDirectory) this.#metricProjections.delete(writer);
        throw error;
      } finally {
        if (metricDirectory) this.#metricsCache.delete(cacheKey(location));
      }
      this.#emit({ type: 'updated', location });
      return target;
    });
  }

  async rebuildMetricsSummary(
    location: SessionLocation,
  ): Promise<SessionMetricsSummary> {
    const writer = await this.#writer(location);
    return writer.runExclusive(async () => {
      this.#metricProjections.delete(writer);
      const summary = await rebuildSessionMetricsSummary(
        location.bundle_path,
        location.session_id,
        this.#faultInjector,
      );
      this.#metricsCache.delete(cacheKey(location));
      return summary;
    });
  }

  async closeSession(location: SessionLocation): Promise<void> {
    await this.#diagnostics.flush();
    const key = cacheKey(location);
    const writer = this.#writers.get(key);
    if (!writer) return;
    this.#writers.delete(key);
    await (await writer).close();
  }

  async trashSession(location: SessionLocation): Promise<TrashResult> {
    await this.#diagnostics.flush();
    const key = cacheKey(location);
    if (this.#moving.has(key)) throw new Error(`Session ${location.session_id} is already being moved`);
    this.#moving.add(key);
    let writer: SessionWriter | null = null;
    let trashPath: string | null = null;
    try {
      writer = await this.#writer(location, { allowMoving: true });
      await this.#locator.assertSafeLocation(location, { mustExist: true });
      const trashRoot = join(location.session_root, '.trash');
      await ensureDirectoryTreeNoLinks(location.session_root, trashRoot);
      const trashedAt = new Date();
      const timestamp = trashedAt.toISOString().replace(/[:.]/g, '-');
      const trashName = `${location.session_id}-${timestamp}-${randomUUID()}`;
      trashPath = join(trashRoot, trashName);
      assertContainedPath(trashRoot, trashPath);
      await writer.moveExclusive(async () => {
        await durableRename(location.bundle_path, trashPath!, {
          faultInjector: this.#faultInjector,
          context: { session_id: location.session_id },
        });
      });
      this.#writers.delete(key);
      await writer.closeAfterMove(trashPath);
      this.#sessionCache.delete(key);
      this.#stateCache.delete(key);
      this.#metricsCache.delete(key);
      this.#artifactRecoveryRegistry.delete(key);
      this.#emit({ type: 'trashed', location, trash_path: trashPath });
      return {
        location,
        trash_path: trashPath,
        trash_name: trashName,
        trashed_at: trashedAt.toISOString(),
      };
    } catch (error) {
      this.#writers.delete(key);
      if (writer) {
        if (
          trashPath !== null &&
          !existsSync(location.bundle_path) &&
          existsSync(trashPath)
        ) {
          await writer.closeAfterMove(trashPath).catch(() => undefined);
          this.#sessionCache.delete(key);
          this.#stateCache.delete(key);
          this.#metricsCache.delete(key);
          this.#artifactRecoveryRegistry.delete(key);
        } else {
          await writer.close().catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.#moving.delete(key);
    }
  }

  async restoreTrashedSession(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<RestoreResult> {
    const trashed = await this.getTrashedSession(scope, trashName);
    const { metadata, trash_path: trashPath } = trashed;
    const sessionId = asSessionId(String(metadata.id));
    const location = this.#locator.locate(scope, sessionId);
    const key = cacheKey(location);
    if (this.#moving.has(key)) {
      throw new Error(`Session ${sessionId} is already being moved`);
    }
    if (existsSync(location.bundle_path)) {
      throw new Error(`Cannot restore session ${sessionId}: destination already exists`);
    }

    this.#moving.add(key);
    try {
      // A bundle moved by an interrupted older runtime may retain its inert
      // lease file. It cannot guard a trash path, and carrying it back would
      // permanently block the restored session.
      const inertLease = join(trashPath, 'events', 'writer.lease');
      try {
        assertPathHasNoLinksSync(trashPath, inertLease);
        await unlink(inertLease);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      await durableRename(trashPath, location.bundle_path, {
        faultInjector: this.#faultInjector,
        context: { session_id: sessionId },
      });
      const session = this.readSessionSync(location);
      const state = this.readStateSync(location);
      this.#artifactRecoveryRegistry.delete(key);
      this.#sessionCache.set(key, session);
      this.#stateCache.set(key, state);
      this.#emit({ type: 'restored', location });
      return {
        location,
        session,
        state,
        restored_from: trashPath,
      };
    } finally {
      this.#moving.delete(key);
    }
  }

  async listTrashedSessions(
    scope: SessionLocation['scope'],
  ): Promise<readonly TrashedSessionEntry[]> {
    const sessionRoot = await this.#locator.ensureSessionRoot(scope);
    const trashRoot = join(sessionRoot, '.trash');
    if (!existsSync(trashRoot)) return [];
    assertPathHasNoLinksSync(sessionRoot, trashRoot);
    const trashStat = lstatSync(trashRoot);
    if (trashStat.isSymbolicLink() || !trashStat.isDirectory()) {
      throw new UnsafeSessionPathError(`Trash root is not a safe directory: ${trashRoot}`);
    }

    const entries = await readdir(trashRoot, { withFileTypes: true });
    const output: TrashedSessionEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new UnsafeSessionPathError(
          `Trash root contains an unsafe entry: ${join(trashRoot, entry.name)}`,
        );
      }
      output.push(await this.getTrashedSession(scope, entry.name));
    }
    return output.sort((left, right) =>
      right.trashed_at.localeCompare(left.trashed_at) ||
      left.trash_name.localeCompare(right.trash_name));
  }

  async getTrashedSession(
    scope: SessionLocation['scope'],
    trashName: string,
  ): Promise<TrashedSessionEntry> {
    const token = parseTrashBundleName(trashName);
    const sessionRoot = await this.#locator.ensureSessionRoot(scope);
    const trashRoot = join(sessionRoot, '.trash');
    const trashPath = join(trashRoot, trashName);
    assertContainedPath(trashRoot, trashPath);
    assertPathHasNoLinksSync(sessionRoot, trashPath);
    const trashStat = lstatSync(trashPath);
    if (trashStat.isSymbolicLink() || !trashStat.isDirectory()) {
      throw new UnsafeSessionPathError(
        `Trash bundle is not a safe directory: ${trashPath}`,
      );
    }
    const metadataPath = join(trashPath, 'session.json');
    assertPathHasNoLinksSync(trashPath, metadataPath);
    const metadataStat = lstatSync(metadataPath);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      throw new UnsafeSessionPathError(
        `Trash bundle metadata is not a safe file: ${metadataPath}`,
      );
    }
    const metadata = parseJsonFileSync<SessionMetadata>(metadataPath);
    if (
      metadata.schema_version !== 1 ||
      !isUuid(metadata.id) ||
      metadata.id !== token.session_id ||
      metadata.storage_scope.kind !== scope.kind ||
      (scope.kind === 'project' &&
        (metadata.storage_scope.kind !== 'project' ||
          metadata.storage_scope.project_id !== scope.project_id))
    ) {
      throw new Error(`Trash bundle metadata does not match restore scope: ${trashPath}`);
    }
    return {
      trash_name: trashName,
      trash_path: trashPath,
      trashed_at: token.trashed_at,
      scope,
      metadata,
    };
  }

  async purgeTrashedSession(scope: SessionLocation['scope'], trashName: string): Promise<void> {
    const trashed = await this.getTrashedSession(scope, trashName);
    const sessionRoot = this.#locator.sessionRoot(scope);
    const trashRoot = join(sessionRoot, '.trash');
    assertContainedPath(trashRoot, trashed.trash_path);
    await removeSideChatFile(sessionRoot, trashed.metadata.id);
    await removeTreeNoLinks(trashRoot, trashed.trash_path);
  }

  async close(): Promise<void> {
    await this.#diagnostics.close();
    await Promise.all(this.#projectionMutations.values());
    const writers = [...this.#writers.values()];
    this.#writers.clear();
    await Promise.allSettled(writers.map(async (writer) => (await writer).close()));
  }

  /** Never use for conversation, tool outcomes, usage accounting or authority. */
  enqueueDiagnostic(location: SessionLocation, directory: 'metrics/turns' | 'metrics/pipeline_stages', id: string, value: JsonValue): boolean {
    const snapshot = JSON.stringify(value);
    if (snapshot.length > 128 * 1024) return false;
    return this.#diagnostics.enqueue(`${cacheKey(location)}:${directory}:${id}`,
      () => traceStorageOperation({ sessionId: location.session_id, operationId: `diagnostic:${id}` },
        () => this.writeEntity(location, directory, id, JSON.parse(snapshot) as JsonValue)));
  }

  flushDiagnostics(): Promise<void> { return this.#diagnostics.flush(); }
}
