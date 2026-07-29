import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertPathHasNoLinksSync,
  isUuid,
  newSessionId,
  type JsonValue,
  type SessionEntityDirectory,
  type SessionId,
} from '@mcp/session-storage';
import {
  requestKey,
  toJsonValue,
} from './conversation-codec.js';
import { FsSessionDirectory } from './session-directory.js';

export interface FsEntityEnvelope<T extends JsonValue = JsonValue> {
  schema_version: 1;
  id: string;
  seq: number;
  kind: string;
  revision: number;
  operation_id: string;
  operation_hash: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  operation_history: readonly FsEntityOperation[];
  data: T;
}

export interface FsEntityOperation {
  operation_id: string;
  operation_hash: string;
  revision: number;
}

export interface FsEntityWrite<T> {
  kind: string;
  data: T;
  operation_id?: string;
  operation_key?: unknown;
}

export interface FsEntityUpdateOptions {
  expected_revision?: number;
  operation_id?: string;
  operation_key?: unknown;
  delete?: boolean;
}

export interface FsPreparedEntityUpdate {
  record: FsEntityEnvelope<JsonValue>;
  changed: boolean;
}

export class FsEntityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FsEntityConflictError';
  }
}

function parseEnvelope<T extends JsonValue>(
  path: string,
  raw: string,
): FsEntityEnvelope<T> {
  const value = JSON.parse(raw) as FsEntityEnvelope<T>;
  if (
    value.schema_version !== 1 ||
    !isUuid(value.id) ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.kind !== 'string' ||
    typeof value.operation_id !== 'string' ||
    typeof value.operation_hash !== 'string' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string'
  ) {
    throw new Error(`Invalid filesystem entity ${path}`);
  }
  const operationHistory = Array.isArray(value.operation_history)
    ? value.operation_history
    : [
        {
          operation_id: value.operation_id,
          operation_hash: value.operation_hash,
          revision: value.revision,
        },
      ];
  if (
    operationHistory.some(
      (operation) =>
        typeof operation.operation_id !== 'string' ||
        typeof operation.operation_hash !== 'string' ||
        !Number.isSafeInteger(operation.revision) ||
        operation.revision < 1,
    )
  ) {
    throw new Error(`Invalid filesystem entity operation history ${path}`);
  }
  return { ...value, operation_history: operationHistory };
}

export class FsSessionEntityFiles {
  constructor(private readonly directory: FsSessionDirectory) {}

  async list<T extends JsonValue>(
    sessionId: SessionId | string,
    entityDirectory: SessionEntityDirectory,
    kind?: string,
    includeDeleted = false,
  ): Promise<FsEntityEnvelope<T>[]> {
    const entry = await this.directory.requireEntry(sessionId);
    const root = join(
      entry.location.bundle_path,
      ...entityDirectory.split('/'),
    );
    assertPathHasNoLinksSync(entry.location.bundle_path, root);
    return readdirSync(root)
      .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map((name) => {
        const path = join(root, name);
        assertPathHasNoLinksSync(entry.location.bundle_path, path);
        return parseEnvelope<T>(path, readFileSync(path, 'utf8'));
      })
      .filter((record) => (kind == null || record.kind === kind))
      .filter((record) => includeDeleted || record.deleted_at == null)
      .sort((left, right) => left.seq - right.seq);
  }

  async get<T extends JsonValue>(
    sessionId: SessionId | string,
    entityDirectory: SessionEntityDirectory,
    id: string,
    includeDeleted = false,
  ): Promise<FsEntityEnvelope<T> | null> {
    if (!isUuid(id)) return null;
    return (
      (await this.list<T>(
        sessionId,
        entityDirectory,
        undefined,
        includeDeleted,
      )).find((record) => record.id === id) ?? null
    );
  }

  async create<T>(
    sessionId: SessionId | string,
    entityDirectory: SessionEntityDirectory,
    input: FsEntityWrite<T>,
  ): Promise<FsEntityEnvelope<JsonValue>> {
    return this.directory.runMutation(
      sessionId,
      () => this.createWithinMutation(sessionId, entityDirectory, input),
    );
  }

  /**
   * Compound repositories use this while already holding the session mutation
   * queue. It intentionally skips a second queue acquisition, which would
   * deadlock behind the caller, while retaining the same writer lease, fsync
   * and operation-id checks as {@link create}.
   */
  async createWithinMutation<T>(
    sessionId: SessionId | string,
    entityDirectory: SessionEntityDirectory,
    input: FsEntityWrite<T>,
  ): Promise<FsEntityEnvelope<JsonValue>> {
    const entry = await this.directory.requireEntry(sessionId);
    const data = toJsonValue(input.data);
    const operationId = input.operation_id ?? `entity:${newSessionId()}`;
    const operationHash =
      input.operation_key === undefined
        ? requestKey({
            entityDirectory,
            kind: input.kind,
            data,
          })
        : requestKey({
            entityDirectory,
            kind: input.kind,
            operation_key: toJsonValue(input.operation_key),
          });
    const records = await this.list<JsonValue>(
      sessionId,
      entityDirectory,
      undefined,
      true,
    );
    const replay = records.find((record) =>
      record.operation_history.some(
        (operation) => operation.operation_id === operationId,
      ),
    );
    if (replay) {
      const previous = replay.operation_history.find(
        (operation) => operation.operation_id === operationId,
      )!;
      if (previous.operation_hash !== operationHash) {
        throw new FsEntityConflictError(
          `operation_id ${operationId} has different entity input`,
        );
      }
      return replay;
    }
    const now = new Date().toISOString();
    const record: FsEntityEnvelope<JsonValue> = {
      schema_version: 1,
      id: newSessionId(),
      seq: (records.at(-1)?.seq ?? 0) + 1,
      kind: input.kind,
      revision: 1,
      operation_id: operationId,
      operation_hash: operationHash,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      operation_history: [
        {
          operation_id: operationId,
          operation_hash: operationHash,
          revision: 1,
        },
      ],
      data,
    };
    await this.directory.repository.writeEntity(
      entry.location,
      entityDirectory,
      record.id,
      toJsonValue(record),
    );
    return record;
  }

  async update<T>(
    sessionId: SessionId | string,
    entityDirectory: SessionEntityDirectory,
    id: string,
    update: (current: T) => T,
    options: FsEntityUpdateOptions = {},
  ): Promise<FsEntityEnvelope<JsonValue> | null> {
    if (!isUuid(id)) return null;
    return this.directory.runMutation(
      sessionId,
      () =>
        this.updateWithinMutation(
          sessionId,
          entityDirectory,
          id,
          update,
          options,
        ),
    );
  }

  /** See {@link createWithinMutation}. */
  async updateWithinMutation<T>(
    sessionId: SessionId | string,
    entityDirectory: SessionEntityDirectory,
    id: string,
    update: (current: T) => T,
    options: FsEntityUpdateOptions = {},
  ): Promise<FsEntityEnvelope<JsonValue> | null> {
    if (!isUuid(id)) return null;
    const entry = await this.directory.requireEntry(sessionId);
    const current = await this.get<JsonValue>(
      sessionId,
      entityDirectory,
      id,
      true,
    );
    if (!current || current.deleted_at != null) return null;
    const prepared = this.prepareUpdate(
      current,
      entityDirectory,
      update,
      options,
    );
    if (!prepared) return null;
    if (!prepared.changed) return prepared.record;
    await this.directory.repository.writeEntity(
      entry.location,
      entityDirectory,
      id,
      toJsonValue(prepared.record),
    );
    return prepared.record;
  }

  /**
   * Build an idempotent entity projection without touching the filesystem.
   * Compound mutations can list each directory once, prepare every affected
   * envelope, and publish them together through updateProjectionBatch.
   */
  prepareUpdate<T>(
    current: FsEntityEnvelope<JsonValue>,
    entityDirectory: SessionEntityDirectory,
    update: (current: T) => T,
    options: FsEntityUpdateOptions = {},
  ): FsPreparedEntityUpdate | null {
    if (current.deleted_at != null) return null;
    const operationId =
      options.operation_id ?? `entity-update:${newSessionId()}`;
    const previousOperation = options.operation_id
      ? current.operation_history.find(
          (operation) => operation.operation_id === options.operation_id,
        )
      : undefined;
    if (previousOperation) {
      if (options.operation_key !== undefined) {
        const replayHash = requestKey({
          entityDirectory,
          kind: current.kind,
          operation_key: toJsonValue(options.operation_key),
        });
        if (replayHash !== previousOperation.operation_hash) {
          throw new FsEntityConflictError(
            `operation_id ${operationId} has different entity update input`,
          );
        }
      }
      return { record: current, changed: false };
    }
    if (
      options.expected_revision != null &&
      current.revision !== options.expected_revision
    ) {
      throw new FsEntityConflictError(
        `entity ${current.id} expected revision ${options.expected_revision}, got ${current.revision}`,
      );
    }
    const data = toJsonValue(update(current.data as T));
    const operationHash =
      options.operation_key !== undefined
        ? requestKey({
            entityDirectory,
            kind: current.kind,
            operation_key: toJsonValue(options.operation_key),
          })
        : requestKey({
            id: current.id,
            data,
            delete: options.delete === true,
          });
    const now = new Date().toISOString();
    const next: FsEntityEnvelope<JsonValue> = {
      ...current,
      revision: current.revision + 1,
      operation_id: operationId,
      operation_hash: operationHash,
      updated_at: now,
      deleted_at: options.delete ? now : null,
      operation_history: [
        ...current.operation_history,
        {
          operation_id: operationId,
          operation_hash: operationHash,
          revision: current.revision + 1,
        },
      ],
      data,
    };
    return { record: next, changed: true };
  }
}
