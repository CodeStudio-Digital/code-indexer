import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { NativeSessionReader } from '@mcp/agent-runtime-host';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import { queryConversationProjection, type FsSessionStore,
  type FsConversationProjectionQuery } from '@mcp/session-storage/fs-store/index.js';
import { nativeRecordId } from './native-attempt-preparation.js';
import { loadProductNativeRuntimePackage } from './native-runtime-package.js';
import { isNativeSnapshotChanged, readNativeHistorySnapshot } from './native-history-snapshot.js';
import { runtimeRequestId } from './runtime-attempt-ledger.js';
import { createNativeHistoryProjection, type NativeHistoryProjection as Projection } from './native-history-projection.js';
import { getNativeHistoryWriter, type NativeHistoryWriter } from './native-history-writer.js';
import { resolveNativeProductOutcome } from './native-history-outcome.js';

type Projector = ReturnType<typeof createNativeHistoryProjection>;

/** Rebuildable projection. Active reads use the authorized writer in its worker. */
export function installNativeSessionHistory(sessions: FsSessionStore, dataDirectory: string,
  readActive?: (sessionId: string, query?: FsConversationProjectionQuery) => Promise<Projection | undefined>) {
  const rootPath = join(dataDirectory, 'native-sessions');
  let cached: { sessionId: string; reader: NativeSessionReader; value: Projection } | undefined;
  let live: { writer: NativeHistoryWriter; projection: Projector } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let runtimePackage: ReturnType<typeof loadProductNativeRuntimePackage> | undefined;
  let outcomeRepository: { sessionId: string; repository: ControlPlaneFileRepository } | undefined;
  const resolveOutcome = async (sessionId: string, value: Projection | undefined) => {
    const current = value?.runtime_outcome;
    if (!value || !current || current.status === 'cancelled') return value;
    if (outcomeRepository?.sessionId !== sessionId) {
      const location = await sessions.getSessionLocation(sessionId);
      if (!location) throw new Error('Native history has no product session');
      outcomeRepository = { sessionId, repository: new ControlPlaneFileRepository({ sessionRoot: location.bundle_path }) };
    }
    const resolved = await resolveNativeProductOutcome(outcomeRepository.repository, sessionId, current);
    return resolved === current ? value : { ...value, runtime_outcome: resolved };
  };
  const loadLive = async (sessionId: string, query?: FsConversationProjectionQuery): Promise<Projection | undefined> => {
    const writer = getNativeHistoryWriter(sessionId);
    if (live && live.writer !== writer) { live.projection.close(); live = undefined; }
    if (!writer) return undefined;
    live ??= { writer, projection: await prepareProjection(sessions, sessionId, writer.attemptId) };
    const value = await writer.runtime.readCommittedHistory(store => live!.projection.consume(store, query));
    if (!value) { live.projection.close(); live = undefined; }
    return value;
  };
  const select = (value: Projection, query?: FsConversationProjectionQuery): Projection =>
    query ? { ...queryConversationProjection(value, query), usage: value.usage } : value;
  const load = async (sessionId: string, query?: FsConversationProjectionQuery): Promise<Projection | undefined> => {
    if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error('Invalid native history session');
    const active = await readActive?.(sessionId, query) ?? await loadLive(sessionId, query);
    if (active) return active;
    try { await stat(join(rootPath, sessionId, 'session.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (cached?.sessionId === sessionId) {
      try { await cached.reader.assertCurrent(); return select(cached.value, query); }
      catch (error) {
        await cached.reader.close().catch(() => undefined); cached = undefined;
        if (!isNativeSnapshotChanged(error)) throw error;
      }
    }
    if (cached) { await cached.reader.close(); cached = undefined; }
    runtimePackage ??= loadProductNativeRuntimePackage();
    const verifiedPackage = await runtimePackage;
    const snapshot = await readNativeHistorySnapshot(
      () => NativeSessionReader.open(verifiedPackage, { rootPath, sessionId }), async reader => {
        const projection = await prepareProjection(sessions, sessionId, reader.state.authority!.writerId);
        try { return await projection.consume(reader.store); }
        finally { projection.close(); }
      });
    cached = { sessionId, ...snapshot };
    return select(snapshot.value, query);
  };
  const enqueue = <T>(operation: () => Promise<T>) => {
    const pending = tail.then(operation); tail = pending.catch(() => undefined); return pending;
  };
  // Resolve outside the immutable snapshot cache: terminalizing the product run
  // need not append another Rust journal record (for example after cancellation).
  sessions.setConversationProjectionLoader((id, query) => enqueue(async () => resolveOutcome(id, await load(id, query))));
  return Object.assign(async () => {
    await tail; await cached?.reader.close(); cached = undefined;
    live?.projection.close(); live = undefined;
  }, { readLive: (sessionId: string, query?: FsConversationProjectionQuery) =>
    enqueue(async () => resolveOutcome(sessionId, await loadLive(sessionId, query))) });
}

async function prepareProjection(sessions: FsSessionStore, sessionId: string, writerId: string): Promise<Projector> {
  const location = await sessions.getSessionLocation(sessionId);
  const session = await sessions.getSession(sessionId);
  if (!location || !session) throw new Error('Native history has no product session');
  const repository = new ControlPlaneFileRepository({ sessionRoot: location.bundle_path });
  const preparation = await repository.get('nativePreparation', nativeRecordId(writerId, 'prepare'));
  if (!preparation || preparation.relations.session !== sessionId
    || typeof preparation.data.encodedPrepare !== 'string') throw new Error('Native history lacks product preparation');
  const prepared = fromBinary(agentV1Runtime.PrepareAttemptSchema, Buffer.from(preparation.data.encodedPrepare, 'base64'));
  const identity = prepared.identity;
  if (!identity || identity.sessionId !== sessionId || identity.attemptId !== writerId
    || identity.attemptId !== preparation.relations.attempt) throw new Error('Native history preparation identity diverged');
  const route = await repository.get('runtimeRoute', writerId);
  if (!route || (route.data.route as { runtimeGeneration?: string } | undefined)?.runtimeGeneration !== 'rust_v1') {
    throw new Error('Native history lacks its committed runtime route');
  }
  return createNativeHistoryProjection(sessionId, session.created_at, async (attemptId) => {
    const source = await repository.get('nativePreparation', nativeRecordId(attemptId, 'prepare'));
    if (!source || typeof source.data.encodedPrepare !== 'string') throw new Error('Native history command preparation missing');
    const prepared = fromBinary(agentV1Runtime.PrepareAttemptSchema, Buffer.from(source.data.encodedPrepare, 'base64'));
    const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, prepared.encodedSpec);
    if (spec.identity?.sessionId !== sessionId || spec.identity.attemptId !== attemptId) throw new Error('Native history command authority changed');
    if (spec.checkpointInput?.kind !== 'product-continuation') return false;
    const command = await repository.get('command', spec.identity.commandId);
    const provenance = await repository.get('runtimeRequest', runtimeRequestId(attemptId, 'continuation:source'));
    if (command?.data.commandType !== 'resume' || spec.trigger !== agentV1Runtime.AttemptTrigger.SESSION_CONTINUATION
      || !provenance?.data.continuation || provenance.relations.attempt !== attemptId) {
      throw new Error('Native continuation history lacks its accepted command');
    }
    return true;
  });
}

export async function projectNativeSessionHistory(reader: NativeSessionReader,
  sessionId: string, createdAt: string, isContinuation?: (attemptId: string) => Promise<boolean>): Promise<Projection> {
  const projection = createNativeHistoryProjection(sessionId, createdAt, isContinuation);
  try { return await projection.consume(reader.store); }
  finally { projection.close(); }
}
