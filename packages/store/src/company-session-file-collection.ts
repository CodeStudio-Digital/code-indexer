import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  asSessionId,
  assertUuid,
  type EntityRecord,
  type SessionId,
} from '@mcp/session-storage';

interface CatalogEntryLike {
  session: { id: SessionId; kind: string };
  location: { bundle_path: string };
}

export interface CompanyOperationalSessionStore {
  catalog: {
    get(id: SessionId): CatalogEntryLike | null | undefined;
    list(): readonly CatalogEntryLike[];
  };
}

const LOCK_RETRY_MS = 5;
const LOCK_RETRIES = 400;
const LOCK_STALE_MS = 30_000;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(milliseconds: number): void {
  Atomics.wait(WAIT_ARRAY, 0, 0, milliseconds);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function ensureDirectoryNoLinks(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: false, mode: 0o700 });
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe Company session directory: ${path}`);
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
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
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function atomicWriteJsonSync(path: string, value: unknown): void {
  const parent = dirname(path);
  const temporary = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectoryBestEffort(parent);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (unlinkError) {
      if (!isMissing(unlinkError)) throw unlinkError;
    }
    throw error;
  }
}

function parseRecord<T extends object>(
  path: string,
  expectedKind: string,
): EntityRecord<T> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as EntityRecord<T>;
  const fileId = basename(path, '.json').toLowerCase();
  if (
    value.schemaVersion !== 1 ||
    value.id !== fileId ||
    value.kind !== expectedKind ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 1
  ) {
    throw new Error(`Invalid ${expectedKind} entity record: ${path}`);
  }
  assertUuid(value.id, `${expectedKind} entity id`);
  return value;
}

function sortedJsonFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(directory, entry.name))
    .sort();
}

export interface CompanyEntityCreateInput<T extends object> {
  id?: string;
  data: T;
  relations?: Record<string, string | string[]>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Synchronous entity facade for operational stores whose existing consumers
 * are synchronous (sandbox reconciliation and service-health projections).
 *
 * Every mutation is a temp+fsync+rename commit under a short, cross-process
 * per-session lock. Different sessions never share a lock or output file.
 */
export class CompanySessionFileCollection<T extends object> {
  constructor(
    private readonly sessions: CompanyOperationalSessionStore,
    private readonly namespace: string,
    private readonly kind: string,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(namespace)) {
      throw new TypeError(`Unsafe Company entity namespace: ${namespace}`);
    }
  }

  private entry(sessionId: string): CatalogEntryLike {
    const normalized = asSessionId(assertUuid(sessionId, 'Company session id'));
    const entry = this.sessions.catalog.get(normalized);
    if (!entry) {
      throw new Error(
        `Unknown filesystem Company session ${normalized}; catalog must be initialized`,
      );
    }
    if (
      entry.session.kind !== 'company' &&
      entry.session.kind !== 'app_studio'
    ) {
      throw new Error(
        `Session ${normalized} is ${entry.session.kind}, not Company/App Studio`,
      );
    }
    return entry;
  }

  private companyDirectory(sessionId: string): string {
    const bundle = resolve(this.entry(sessionId).location.bundle_path);
    const company = join(bundle, 'company');
    const directory = join(company, this.namespace);
    ensureDirectoryNoLinks(bundle);
    ensureDirectoryNoLinks(company);
    ensureDirectoryNoLinks(directory);
    const relative = directory.slice(bundle.length + 1);
    if (
      relative.startsWith(`..${sep}`) ||
      resolve(directory) !== directory
    ) {
      throw new Error(`Company entity directory escaped bundle: ${directory}`);
    }
    return directory;
  }

  private lockPath(sessionId: string): string {
    const bundle = resolve(this.entry(sessionId).location.bundle_path);
    const events = join(bundle, 'events');
    ensureDirectoryNoLinks(bundle);
    ensureDirectoryNoLinks(events);
    return join(events, 'company-operational.lock');
  }

  withSessionLock<R>(sessionId: string, task: () => R): R {
    const lockPath = this.lockPath(sessionId);
    let descriptor: number | undefined;
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
        writeFileSync(
          descriptor,
          `${JSON.stringify({
            schema_version: 1,
            pid: process.pid,
            acquired_at: new Date().toISOString(),
          })}\n`,
          'utf8',
        );
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        break;
      } catch (error) {
        if (descriptor !== undefined) {
          closeSync(descriptor);
          descriptor = undefined;
        }
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
        try {
          if (statSync(lockPath).mtimeMs + LOCK_STALE_MS <= Date.now()) {
            unlinkSync(lockPath);
            continue;
          }
        } catch (statError) {
          if (!isMissing(statError)) throw statError;
        }
        if (attempt === LOCK_RETRIES - 1) {
          throw new Error(
            `Timed out acquiring Company operational lock for ${sessionId}`,
          );
        }
        sleepSync(LOCK_RETRY_MS);
      }
    }
    try {
      return task();
    } finally {
      try {
        unlinkSync(lockPath);
        fsyncDirectoryBestEffort(dirname(lockPath));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  list(sessionId: string): EntityRecord<T>[] {
    return sortedJsonFiles(this.companyDirectory(sessionId))
      .map((path) => parseRecord<T>(path, this.kind))
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  }

  get(sessionId: string, id: string): EntityRecord<T> | null {
    const normalized = assertUuid(id, `${this.kind} id`);
    const path = join(this.companyDirectory(sessionId), `${normalized}.json`);
    if (!existsSync(path)) return null;
    return parseRecord<T>(path, this.kind);
  }

  create(
    sessionId: string,
    input: CompanyEntityCreateInput<T>,
  ): EntityRecord<T> {
    return this.withSessionLock(sessionId, () => {
      const directory = this.companyDirectory(sessionId);
      const id = assertUuid(input.id ?? randomUUID(), `${this.kind} id`);
      const path = join(directory, `${id}.json`);
      if (existsSync(path)) throw new Error(`${this.kind} ${id} already exists`);
      const existing = sortedJsonFiles(directory).map((file) =>
        parseRecord<T>(file, this.kind),
      );
      const seq = existing.reduce((max, record) => Math.max(max, record.seq), 0) + 1;
      const createdAt = new Date(input.createdAt ?? Date.now()).toISOString();
      const record: EntityRecord<T> = {
        schemaVersion: 1,
        id,
        kind: this.kind,
        seq,
        operationId: randomUUID(),
        createdAt,
        updatedAt: new Date(input.updatedAt ?? createdAt).toISOString(),
        relations: input.relations ?? {},
        data: input.data,
      };
      atomicWriteJsonSync(path, record);
      return record;
    });
  }

  /**
   * Atomically find-and-update or create one logical entity while holding the
   * session lock. Callbacks execute under that lock, which lets stores commit
   * a payload before publishing metadata without a duplicate-create race.
   */
  upsertFirst(
    sessionId: string,
    matches: (record: EntityRecord<T>) => boolean,
    onCreate: () => CompanyEntityCreateInput<T>,
    onUpdate: (record: EntityRecord<T>) => T,
  ): EntityRecord<T> {
    return this.withSessionLock(sessionId, () => {
      const directory = this.companyDirectory(sessionId);
      const records = sortedJsonFiles(directory).map((file) =>
        parseRecord<T>(file, this.kind),
      );
      const previous = records.find(matches);
      if (previous) {
        const next: EntityRecord<T> = {
          ...previous,
          operationId: randomUUID(),
          updatedAt: new Date().toISOString(),
          data: onUpdate(previous),
        };
        atomicWriteJsonSync(
          join(directory, `${previous.id}.json`),
          next,
        );
        return next;
      }

      const input = onCreate();
      const id = assertUuid(input.id ?? randomUUID(), `${this.kind} id`);
      const path = join(directory, `${id}.json`);
      if (existsSync(path)) throw new Error(`${this.kind} ${id} already exists`);
      const seq =
        records.reduce((max, record) => Math.max(max, record.seq), 0) + 1;
      const createdAt = new Date(input.createdAt ?? Date.now()).toISOString();
      const record: EntityRecord<T> = {
        schemaVersion: 1,
        id,
        kind: this.kind,
        seq,
        operationId: randomUUID(),
        createdAt,
        updatedAt: new Date(input.updatedAt ?? createdAt).toISOString(),
        relations: input.relations ?? {},
        data: input.data,
      };
      atomicWriteJsonSync(path, record);
      return record;
    });
  }

  update(
    sessionId: string,
    id: string,
    update: (record: EntityRecord<T>) => T,
  ): EntityRecord<T> {
    return this.withSessionLock(sessionId, () => {
      const normalized = assertUuid(id, `${this.kind} id`);
      const path = join(this.companyDirectory(sessionId), `${normalized}.json`);
      if (!existsSync(path)) throw new Error(`Unknown ${this.kind} ${normalized}`);
      const previous = parseRecord<T>(path, this.kind);
      const next: EntityRecord<T> = {
        ...previous,
        operationId: randomUUID(),
        updatedAt: new Date().toISOString(),
        data: update(previous),
      };
      atomicWriteJsonSync(path, next);
      return next;
    });
  }

  moveToTrash(sessionId: string, id: string): EntityRecord<T> | null {
    return this.withSessionLock(sessionId, () => {
      const normalized = assertUuid(id, `${this.kind} id`);
      const sourceDirectory = this.companyDirectory(sessionId);
      const source = join(sourceDirectory, `${normalized}.json`);
      if (!existsSync(source)) return null;
      const record = parseRecord<T>(source, this.kind);
      const bundle = resolve(this.entry(sessionId).location.bundle_path);
      const companyTrash = join(bundle, 'company', 'trash');
      const trashDirectory = join(companyTrash, this.namespace);
      ensureDirectoryNoLinks(companyTrash);
      ensureDirectoryNoLinks(trashDirectory);
      const target = join(trashDirectory, `${normalized}.json`);
      renameSync(source, target);
      fsyncDirectoryBestEffort(sourceDirectory);
      fsyncDirectoryBestEffort(trashDirectory);
      return record;
    });
  }

  purge(sessionId: string): number {
    return this.withSessionLock(sessionId, () => {
      const directory = this.companyDirectory(sessionId);
      const files = sortedJsonFiles(directory);
      for (const path of files) unlinkSync(path);
      if (files.length > 0) fsyncDirectoryBestEffort(directory);
      return files.length;
    });
  }

  listAcrossSessions(): Array<{
    sessionId: string;
    record: EntityRecord<T>;
  }> {
    const output: Array<{ sessionId: string; record: EntityRecord<T> }> = [];
    for (const entry of this.sessions.catalog.list()) {
      if (
        entry.session.kind !== 'company' &&
        entry.session.kind !== 'app_studio'
      ) {
        continue;
      }
      const sessionId = String(entry.session.id);
      for (const record of this.list(sessionId)) {
        output.push({ sessionId, record });
      }
    }
    return output;
  }
}
