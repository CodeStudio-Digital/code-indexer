import { resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import {
  EntityFileRepository,
  type JsonValue,
} from '@mcp/session-storage';
import type {
  RuntimeEventEnvelope,
  RuntimeLogKind,
  RuntimeSessionId,
} from './runtime-event-types.js';

export interface PersistableRuntimeEvent {
  event: RuntimeEventEnvelope;
  line: string;
  bytes: number;
}

export interface RuntimeEventLogLocation {
  /** Absolute path of the already-existing session bundle. */
  bundlePath: string;
}

interface RuntimeEventData {
  kind: RuntimeLogKind;
  session_id: string;
  envelope: JsonValue;
}

export interface PersistedRuntimeEventRecord {
  id: string;
  revision: number;
  event: RuntimeEventEnvelope;
}

export interface PersistedRuntimeEventPage {
  items: PersistedRuntimeEventRecord[];
  nextCursor: string | null;
  totalCount: number | null;
}

interface PersistedRuntimeEventPageOptions {
  cursor?: string;
  limit: number;
  order?: 'asc' | 'desc';
}

const repositories = new Map<string, EntityFileRepository<RuntimeEventData>>();
const pendingWrites = new Set<Promise<void>>();
const writeFailures = new Map<string, Error>();

function repositoryFor(
  location: RuntimeEventLogLocation,
): EntityFileRepository<RuntimeEventData> {
  const bundlePath = resolve(location.bundlePath);
  let repository = repositories.get(bundlePath);
  if (!repository) {
    repository = new EntityFileRepository<RuntimeEventData>({
      sessionRoot: bundlePath,
      // Control-plane runtime events own `events/runtime/*.json`. The SSE
      // diagnostic stream is isolated one level below so both repositories
      // keep independent sequence/fencing domains while remaining inside the
      // canonical session events tree.
      namespace: 'events/runtime/stream',
      kind: 'session.runtime_event',
      immutable: true,
      journal: false,
    });
    repositories.set(bundlePath, repository);
  }
  return repository;
}

function eventAsJson(event: RuntimeEventEnvelope): JsonValue {
  // `prepareRuntimeEvent` already serialized the envelope. Parse that exact
  // representation so undefined object properties cannot enter strict JSON.
  return JSON.parse(JSON.stringify(event)) as JsonValue;
}

function asRuntimeEvent(value: JsonValue): RuntimeEventEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, JsonValue>;
  if (
    typeof row.event !== 'string'
    || typeof row.seq !== 'number'
    || typeof row.ts !== 'number'
    || (row.kind !== 'coder' && row.kind !== 'company')
    || typeof row.sessionId !== 'string'
  ) {
    return null;
  }
  return row as unknown as RuntimeEventEnvelope;
}

export function registerRuntimeEventLog(
  location: RuntimeEventLogLocation,
): () => void {
  const bundlePath = resolve(location.bundlePath);
  const stat = lstatSync(bundlePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe runtime-event session bundle: ${bundlePath}`);
  }
  // The repository validates the complete descendant path on read/write.
  // There is deliberately no global side-store fallback.
  repositoryFor(location);
  return () => undefined;
}

export function persistRuntimeEvent(
  prepared: PersistableRuntimeEvent,
  location: RuntimeEventLogLocation,
): void {
  const bundlePath = resolve(location.bundlePath);
  const write = repositoryFor(location)
    .create({
      data: {
        kind: prepared.event.kind,
        session_id: String(prepared.event.sessionId),
        envelope: eventAsJson(prepared.event),
      },
    })
    .then(() => {
      writeFailures.delete(bundlePath);
    })
    .catch((error) => {
      const failure =
        error instanceof Error ? error : new Error(String(error));
      writeFailures.set(bundlePath, failure);
      console.error(
        `[runtime-event-log] filesystem write failed for ${bundlePath}: ${failure.message}`,
      );
    })
    .finally(() => {
      pendingWrites.delete(write);
    });
  pendingWrites.add(write);
}

export async function readPersistedRuntimeEvents(
  kind: RuntimeLogKind,
  sessionId: RuntimeSessionId,
  location: RuntimeEventLogLocation,
): Promise<RuntimeEventEnvelope[]> {
  const bundlePath = resolve(location.bundlePath);
  const writeFailure = writeFailures.get(bundlePath);
  if (writeFailure) {
    throw new Error(
      `Runtime event persistence failed for session ${sessionId}`,
      { cause: writeFailure },
    );
  }

  const repository = repositoryFor(location);
  const events: RuntimeEventEnvelope[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list({
      order: 'asc',
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    for (const record of page.items) {
      if (
        record.data.kind !== kind
        || record.data.session_id !== String(sessionId)
      ) {
        throw new Error(
          `Runtime event identity mismatch in bundle ${bundlePath}`,
        );
      }
      const event = asRuntimeEvent(record.data.envelope);
      if (!event) {
        throw new Error(
          `Invalid runtime event record ${record.id} in bundle ${bundlePath}`,
        );
      }
      events.push(event);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return events;
}

/**
 * Bounded page reader for consumers such as the Session Workbench. The entity
 * cursor remains opaque to callers and is anchored to the last persisted
 * record returned, so a descending backfill does not drift when new events are
 * appended concurrently.
 */
export async function listPersistedRuntimeEventPage(
  kind: RuntimeLogKind,
  sessionId: RuntimeSessionId,
  location: RuntimeEventLogLocation,
  options: PersistedRuntimeEventPageOptions,
): Promise<PersistedRuntimeEventPage> {
  const bundlePath = resolve(location.bundlePath);
  const writeFailure = writeFailures.get(bundlePath);
  if (writeFailure) {
    throw new Error(
      `Runtime event persistence failed for session ${sessionId}`,
      { cause: writeFailure },
    );
  }

  const page = await repositoryFor(location).list({
    limit: options.limit,
    order: options.order ?? 'desc',
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  return {
    items: page.items.map((record) => {
      if (
        record.data.kind !== kind
        || record.data.session_id !== String(sessionId)
      ) {
        throw new Error(`Runtime event identity mismatch in bundle ${bundlePath}`);
      }
      const event = asRuntimeEvent(record.data.envelope);
      if (!event) {
        throw new Error(`Invalid runtime event record ${record.id} in bundle ${bundlePath}`);
      }
      return { id: record.id, revision: record.seq, event };
    }),
    nextCursor: page.nextCursor,
    totalCount: options.cursor ? null : await repositoryFor(location).count(),
  };
}

export async function flushRuntimeEventLogWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
}

export function resetRuntimeEventLogStorage(): void {
  repositories.clear();
  pendingWrites.clear();
  writeFailures.clear();
}
