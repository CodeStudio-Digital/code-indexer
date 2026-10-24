import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { retryTransientRename } from '../atomic-file.js';
import type { JsonValue } from '../types.js';

export type EntityRelations = Readonly<
  Record<string, string | readonly string[]>
>;

export interface EntityRecord<T extends object> {
  schemaVersion: 1;
  id: string;
  kind: string;
  seq: number;
  operationId: string;
  createdAt: string;
  updatedAt: string;
  relations: Record<string, string | string[]>;
  data: T;
}

export interface EntityCreateInput<T extends object> {
  id?: string;
  seq?: number;
  operationId?: string;
  createdAt?: string;
  updatedAt?: string;
  relations?: EntityRelations;
  data: T;
}

export interface EntityUpdateInput<T extends object> {
  operationId?: string;
  updatedAt?: string;
  relations?: EntityRelations;
  data?: T;
}

export interface EntityListOptions {
  cursor?: string;
  limit?: number;
  order?: 'asc' | 'desc';
  relation?: {
    name: string;
    id: string;
  };
}

export interface EntityPage<T extends object> {
  items: EntityRecord<T>[];
  nextCursor: string | null;
}

export interface EntityTrashResult<T extends object> {
  record: EntityRecord<T>;
  relativeTrashPath: string;
}

export interface EntityFileRepositoryOptions {
  /**
   * Absolute path of an existing session bundle. The repository deliberately
   * refuses to create the bundle, so an unavailable project root cannot
   * silently turn into a central-storage fallback.
   */
  sessionRoot: string;
  /**
   * Safe, relative namespace below the session bundle, for example
   * `company/board-items` or `company/app-studio/decisions`.
   */
  namespace: string;
  kind?: string;
  /**
   * Optional well-known file name for a singleton repository.
   */
  singletonFileName?: string;
  journal?: boolean;
  immutable?: boolean;
  now?: () => Date | string;
  idFactory?: () => string;
}

interface EntityCursor {
  version: 1;
  order: 'asc' | 'desc';
  seq: number;
  id: string;
}

interface MutationJournalEntry {
  schemaVersion: 1;
  operation: 'create' | 'update' | 'trash';
  operationId: string;
  entityId: string;
  entityKind: string;
  entitySeq: number;
  at: string;
  sha256: string;
  trashPath?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_RELATION_NAME_RE = /^[a-z][a-z0-9._-]*$/i;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function assertUuid(value: string, label = 'UUID'): string {
  if (!isUuid(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return value.toLowerCase();
}

export function assertSafeRelativePath(
  value: string,
  label = 'relative path',
): string {
  if (!value || isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty relative path`);
  }
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        !SAFE_SEGMENT_RE.test(segment),
    )
  ) {
    throw new TypeError(`${label} contains an unsafe path segment`);
  }
  return segments.join('/');
}

function normalizeJson(
  value: unknown,
  seen: Set<object>,
  path: string,
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Entity JSON contains a non-finite number at ${path}`);
    }
    return value;
  }
  if (
    typeof value === 'undefined' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    typeof value === 'bigint'
  ) {
    throw new TypeError(
      `Entity JSON contains unsupported ${typeof value} at ${path}`,
    );
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Entity JSON contains an unsupported value at ${path}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`Entity JSON contains a cycle at ${path}`);
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        normalizeJson(item, seen, `${path}[${index}]`),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = prototype?.constructor?.name ?? 'unknown';
      throw new TypeError(
        `Entity JSON contains non-plain object ${name} at ${path}`,
      );
    }
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      output[key] = normalizeJson(
        (value as Record<string, unknown>)[key],
        seen,
        `${path}.${key}`,
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function strictJson<T>(value: T): T {
  return normalizeJson(value, new Set(), '$') as T;
}

function cloneRelations(
  relations: EntityRelations | undefined,
): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const name of Object.keys(relations ?? {}).sort()) {
    if (!SAFE_RELATION_NAME_RE.test(name)) {
      throw new TypeError(`Unsafe relation name "${name}"`);
    }
    const raw = relations?.[name];
    if (typeof raw === 'string') {
      output[name] = assertUuid(raw, `relation ${name}`);
      continue;
    }
    if (!Array.isArray(raw)) {
      throw new TypeError(`Relation "${name}" must contain UUIDs`);
    }
    output[name] = [...new Set(raw.map((id) => assertUuid(id, `relation ${name}`)))].sort();
  }
  return output;
}

function isoTimestamp(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (
      code !== 'EISDIR' &&
      code !== 'EINVAL' &&
      code !== 'ENOTSUP' &&
      code !== 'EPERM' &&
      code !== 'EACCES'
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function atomicWriteEntityJson(
  file: string,
  value: unknown,
): Promise<void> {
  const directory = resolve(file, '..');
  const temp = join(
    directory,
    `.${file.slice(file.lastIndexOf(sep) + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const body = serialize(strictJson(value));
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await retryTransientRename(() => rename(temp, file));
    await fsyncDirectoryBestEffort(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function appendJsonLine(file: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(strictJson(value))}\n`;
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function encodeCursor(cursor: EntityCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): EntityCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<EntityCursor>;
    if (
      parsed.version !== 1 ||
      (parsed.order !== 'asc' && parsed.order !== 'desc') ||
      !Number.isSafeInteger(parsed.seq) ||
      (parsed.seq ?? 0) < 1 ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('invalid cursor payload');
    }
    return {
      version: 1,
      order: parsed.order,
      seq: parsed.seq as number,
      id: assertUuid(parsed.id, 'cursor id'),
    };
  } catch (error) {
    throw new TypeError(`Invalid entity cursor: ${(error as Error).message}`);
  }
}

async function assertDirectoryWithoutSymlinks(
  root: string,
  childSegments: readonly string[],
  createChild: boolean,
): Promise<void> {
  let current = root;
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`Session root does not exist: ${root}`);
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Session root must be a real directory: ${root}`);
  }

  for (const segment of childSegments) {
    current = join(current, segment);
    try {
      const currentStat = await lstat(current);
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
        throw new Error(`Unsafe repository path component: ${current}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!createChild) return;
      await mkdir(current, { mode: 0o700 });
      const createdStat = await lstat(current);
      if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
        throw new Error(`Unsafe repository path component: ${current}`);
      }
    }
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel === '.') return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Resolved path escapes session root: ${candidate}`);
  }
}

/**
 * A session-local repository that stores one independent JSON file per
 * operational entity. It intentionally has no SQLite dependency and no
 * global persistent index.
 */
export class EntityFileRepository<T extends object> {
  readonly sessionRoot: string;
  readonly namespace: string;
  readonly kind: string;

  private readonly namespaceSegments: string[];
  private readonly directory: string;
  private readonly journal: boolean;
  private readonly immutable: boolean;
  private readonly singletonFileName?: string;
  private readonly now: () => Date | string;
  private readonly idFactory: () => string;
  private nextSequence: number | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: EntityFileRepositoryOptions) {
    if (!isAbsolute(options.sessionRoot)) {
      throw new TypeError('sessionRoot must be absolute');
    }
    this.sessionRoot = resolve(options.sessionRoot);
    this.namespace = assertSafeRelativePath(options.namespace, 'namespace');
    this.namespaceSegments = this.namespace.split('/');
    this.directory = resolve(this.sessionRoot, ...this.namespaceSegments);
    assertContained(this.sessionRoot, this.directory);
    this.kind = options.kind ?? this.namespace;
    if (options.singletonFileName) {
      if (
        options.singletonFileName.startsWith('.') ||
        !options.singletonFileName.endsWith('.json') ||
        options.singletonFileName.includes('/') ||
        options.singletonFileName.includes('\\') ||
        !SAFE_SEGMENT_RE.test(options.singletonFileName)
      ) {
        throw new TypeError('singletonFileName must be a safe JSON file name');
      }
      this.singletonFileName = options.singletonFileName;
    }
    this.journal = options.journal ?? false;
    this.immutable = options.immutable ?? false;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private enqueueMutation<R>(operation: () => Promise<R>): Promise<R> {
    const pending = this.mutationTail.then(operation, operation);
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async ensureReady(create = true): Promise<void> {
    await assertDirectoryWithoutSymlinks(
      this.sessionRoot,
      this.namespaceSegments,
      create,
    );
  }

  private entityPath(id: string): string {
    const normalized = assertUuid(id, 'entity id');
    const target = resolve(
      this.directory,
      this.singletonFileName ?? `${normalized}.json`,
    );
    assertContained(this.directory, target);
    return target;
  }

  private async assertSafeEntityFile(file: string): Promise<void> {
    try {
      const fileStat = await lstat(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`Unsafe entity file: ${file}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  private timestamp(value?: string): string {
    return isoTimestamp(value ?? this.now(), 'entity timestamp');
  }

  private async readRecordFile(
    file: string,
    expectedId?: string,
  ): Promise<EntityRecord<T>> {
    await this.assertSafeEntityFile(file);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) throw error;
      throw new Error(`Unable to read entity file ${file}`, { cause: error });
    }
    let parsed: EntityRecord<T>;
    try {
      parsed = JSON.parse(raw) as EntityRecord<T>;
    } catch (error) {
      throw new Error(`Invalid JSON in entity file ${file}`, { cause: error });
    }
    if (
      parsed.schemaVersion !== 1 ||
      parsed.kind !== this.kind ||
      !Number.isSafeInteger(parsed.seq) ||
      parsed.seq < 1
    ) {
      throw new Error(`Invalid entity envelope in ${file}`);
    }
    parsed.id = assertUuid(parsed.id, 'persisted entity id');
    parsed.operationId = assertUuid(
      parsed.operationId,
      'persisted operation id',
    );
    if (expectedId && parsed.id !== expectedId) {
      throw new Error(`Entity id/file-name mismatch in ${file}`);
    }
    parsed.createdAt = isoTimestamp(parsed.createdAt, 'createdAt');
    parsed.updatedAt = isoTimestamp(parsed.updatedAt, 'updatedAt');
    parsed.relations = cloneRelations(parsed.relations);
    parsed.data = strictJson(parsed.data);
    return parsed;
  }

  private async recordFiles(): Promise<string[]> {
    await this.ensureReady(false);
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        (entry.isFile() && entry.name.endsWith('.json') && entry.name.startsWith('.'))
      ) {
        if (entry.isSymbolicLink()) {
          throw new Error(
            `Symbolic links are forbidden in entity repositories: ${join(this.directory, entry.name)}`,
          );
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (this.singletonFileName) {
        if (entry.name === this.singletonFileName) {
          files.push(join(this.directory, entry.name));
        }
        continue;
      }
      const id = entry.name.slice(0, -'.json'.length);
      assertUuid(id, `entity filename ${entry.name}`);
      files.push(join(this.directory, entry.name));
    }
    return files;
  }

  private async lastSequence(): Promise<number> {
    let max = 0;
    for (const file of await this.recordFiles()) {
      const record = await this.readRecordFile(file);
      max = Math.max(max, record.seq);
    }
    return max;
  }

  private async reserveSequence(requested?: number): Promise<number> {
    if (this.nextSequence == null) {
      this.nextSequence = (await this.lastSequence()) + 1;
    }
    const next = requested ?? this.nextSequence;
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new TypeError('Entity seq must be a positive safe integer');
    }
    if (requested != null) {
      for (const file of await this.recordFiles()) {
        const record = await this.readRecordFile(file);
        if (record.seq === requested) {
          throw new Error(
            `Entity seq ${requested} is already used by ${record.id}`,
          );
        }
      }
    }
    this.nextSequence = Math.max(this.nextSequence, next + 1);
    return next;
  }

  private async appendMutation(
    operation: MutationJournalEntry['operation'],
    record: EntityRecord<T>,
    trashPath?: string,
  ): Promise<void> {
    if (!this.journal) return;
    const canonical = JSON.stringify(strictJson(record));
    const entry: MutationJournalEntry = {
      schemaVersion: 1,
      operation,
      operationId: record.operationId,
      entityId: record.id,
      entityKind: record.kind,
      entitySeq: record.seq,
      at: record.updatedAt,
      sha256: sha256(canonical),
      ...(trashPath ? { trashPath } : {}),
    };
    await appendJsonLine(join(this.directory, '.journal.jsonl'), entry);
  }

  async create(input: EntityCreateInput<T>): Promise<EntityRecord<T>> {
    return this.enqueueMutation(async () => {
      await this.ensureReady();
      const id = assertUuid(input.id ?? this.idFactory(), 'entity id');
      const operationId = assertUuid(
        input.operationId ?? this.idFactory(),
        'operation id',
      );
      const file = this.entityPath(id);
      await this.assertSafeEntityFile(file);

      try {
        const existing = await this.readRecordFile(file, id);
        if (existing.operationId === operationId) return existing;
        throw new Error(`Entity ${id} already exists`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }

      const createdAt = this.timestamp(input.createdAt);
      const updatedAt = input.updatedAt
        ? this.timestamp(input.updatedAt)
        : createdAt;
      if (updatedAt < createdAt) {
        throw new TypeError('updatedAt cannot precede createdAt');
      }
      const record: EntityRecord<T> = {
        schemaVersion: 1,
        id,
        kind: this.kind,
        seq: await this.reserveSequence(input.seq),
        operationId,
        createdAt,
        updatedAt,
        relations: cloneRelations(input.relations),
        data: strictJson(input.data),
      };
      await atomicWriteEntityJson(file, record);
      await this.appendMutation('create', record);
      return record;
    });
  }

  async get(id: string): Promise<EntityRecord<T> | null> {
    await this.ensureReady(false);
    const normalized = assertUuid(id, 'entity id');
    const file = this.entityPath(normalized);
    try {
      const record = await this.readRecordFile(file);
      return record.id === normalized ? record : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async require(id: string): Promise<EntityRecord<T>> {
    const record = await this.get(id);
    if (!record) throw new Error(`Unknown ${this.kind} entity ${id}`);
    return record;
  }

  async update(
    id: string,
    input: EntityUpdateInput<T>,
  ): Promise<EntityRecord<T>> {
    return this.enqueueMutation(async () => {
      if (this.immutable) {
        throw new Error(`${this.kind} entities are immutable`);
      }
      await this.ensureReady();
      const normalized = assertUuid(id, 'entity id');
      const file = this.entityPath(normalized);
      const existing = await this.require(normalized);
      const operationId = assertUuid(
        input.operationId ?? this.idFactory(),
        'operation id',
      );
      if (existing.operationId === operationId) return existing;
      const updatedAt = this.timestamp(input.updatedAt);
      if (updatedAt < existing.createdAt) {
        throw new TypeError('updatedAt cannot precede createdAt');
      }
      const record: EntityRecord<T> = {
        ...existing,
        operationId,
        updatedAt,
        relations:
          input.relations == null
            ? existing.relations
            : cloneRelations(input.relations),
        data:
          input.data == null ? existing.data : strictJson(input.data),
      };
      await atomicWriteEntityJson(file, record);
      await this.appendMutation('update', record);
      return record;
    });
  }

  async list(options: EntityListOptions = {}): Promise<EntityPage<T>> {
    const order = options.order ?? 'asc';
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new TypeError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    if (cursor && cursor.order !== order) {
      throw new TypeError('Entity cursor order does not match list order');
    }
    const relation = options.relation
      ? {
          name: options.relation.name,
          id: assertUuid(options.relation.id, 'relation filter id'),
        }
      : null;
    if (relation && !SAFE_RELATION_NAME_RE.test(relation.name)) {
      throw new TypeError(`Unsafe relation name "${relation.name}"`);
    }

    const records = await Promise.all(
      (await this.recordFiles()).map((file) => this.readRecordFile(file)),
    );
    records.sort((left, right) => {
      const bySeq = left.seq - right.seq;
      const natural = bySeq || left.id.localeCompare(right.id);
      return order === 'asc' ? natural : -natural;
    });

    const filtered = records.filter((record) => {
      if (cursor) {
        const natural =
          record.seq - cursor.seq || record.id.localeCompare(cursor.id);
        if ((order === 'asc' && natural <= 0) || (order === 'desc' && natural >= 0)) {
          return false;
        }
      }
      if (relation) {
        const value = record.relations[relation.name];
        if (
          value !== relation.id &&
          !(Array.isArray(value) && value.includes(relation.id))
        ) {
          return false;
        }
      }
      return true;
    });
    const page = filtered.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        filtered.length > page.length && last
          ? encodeCursor({
              version: 1,
              order,
              seq: last.seq,
              id: last.id,
            })
          : null,
    };
  }

  async count(): Promise<number> {
    return (await this.recordFiles()).length;
  }

  async moveToTrash(id: string): Promise<EntityTrashResult<T>> {
    return this.enqueueMutation(async () => {
      await this.ensureReady();
      const normalized = assertUuid(id, 'entity id');
      const record = await this.require(normalized);
      const source = this.entityPath(normalized);
      const stamp = record.updatedAt.replaceAll(':', '-');
      const trashSegments = [
        '.trash',
        'entities',
        ...this.namespaceSegments,
      ];
      await assertDirectoryWithoutSymlinks(
        this.sessionRoot,
        trashSegments,
        true,
      );
      const trashDirectory = resolve(this.sessionRoot, ...trashSegments);
      assertContained(this.sessionRoot, trashDirectory);
      const target = resolve(
        trashDirectory,
        `${normalized}.${stamp}.${randomUUID()}.json`,
      );
      assertContained(trashDirectory, target);
      await retryTransientRename(() => rename(source, target));
      await fsyncDirectoryBestEffort(this.directory);
      await fsyncDirectoryBestEffort(trashDirectory);
      const relativeTrashPath = relative(this.sessionRoot, target).replaceAll(
        sep,
        '/',
      );
      await this.appendMutation('trash', record, relativeTrashPath);
      return { record, relativeTrashPath };
    });
  }
}
