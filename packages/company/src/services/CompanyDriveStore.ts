/**
 * Bundle-local shared drive for one root Company session.
 *
 * Metadata is one JSON entity per logical file under `company/drive/`.
 * Payloads are independent files under `company/drive-payloads/`. A payload is
 * durably committed before its metadata entity, so a crash can leave an
 * unreferenced payload but never a confirmed reference to missing bytes.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import { assertRelativePath, DRIVE_WRITE_CAP_BYTES } from '@mcp/company/tools/file-path-core.js';
import {
  CompanySessionFileCollection,
  type CompanyOperationalSessionStore,
} from '@mcp/store/company-session-file-collection.js';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { asSessionId, type CompanySessionId } from '@mcp/session-storage';

export interface CompanyDriveStoreDeps {
  sessionStore: FsSessionStore;
  companySessionId: CompanySessionId | string;
  publisher?: IMetaBusPublisher;
}

export interface DriveFileMeta {
  id: string;
  seq: number;
  scopeKey: string;
  path: string;
  sizeBytes: number;
  mime: string;
  ownerRole: string | null;
  ownerAgentRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DriveFileWithContent {
  meta: DriveFileMeta;
  content: string;
  truncated: boolean;
}

export interface DriveOwnerRef {
  role?: string | null;
  agentRunId?: string | null;
}

export interface DriveListFilters {
  prefix?: string;
  ownerRole?: string;
}

export interface DriveReadOpts {
  offset?: number;
  maxBytes?: number;
}

interface DriveFileData {
  [key: string]: unknown;
  record_type: 'drive-file';
  path: string;
  payload_file: string;
  size_bytes: number;
  mime: string;
  owner_role: string | null;
  owner_agent_run_id: string | null;
}

const MAX_WRITE_BYTES = DRIVE_WRITE_CAP_BYTES;
const DEFAULT_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;

function validatePath(path: string): void {
  assertRelativePath(path, { traversal: 'segment' });
}

function ensureDirectoryNoLinks(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe Company drive directory: ${path}`);
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

function atomicWrite(path: string, content: Buffer): void {
  const temporary = join(
    dirname(path),
    `.${randomUUID()}.${process.pid}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectoryBestEffort(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort: a recovery sweep may collect an unreferenced temp file.
    }
    throw error;
  }
}

export class CompanyDriveStore {
  private readonly companySessionId: CompanySessionId;
  private readonly rootSessionId: CompanySessionId;
  private readonly files: CompanySessionFileCollection<DriveFileData>;
  private readonly bundlePath: string;
  private readonly publisher: IMetaBusPublisher | null;

  constructor(deps: CompanyDriveStoreDeps) {
    const requestedFiles = new CompanySessionFiles({
      companySessionId: deps.companySessionId,
      sessionStore: deps.sessionStore,
    });
    const requested = requestedFiles.getSession();
    this.companySessionId = requested.id;
    this.rootSessionId = requested.parent_session_id ?? requested.id;
    const rootEntry = deps.sessionStore.catalog.get(
      asSessionId(this.rootSessionId),
    );
    if (!rootEntry) {
      throw new Error(`Unknown root Company session ${this.rootSessionId}`);
    }
    this.bundlePath = resolve(rootEntry.location.bundle_path);
    this.files = new CompanySessionFileCollection(
      deps.sessionStore as CompanyOperationalSessionStore,
      'drive',
      'company.drive-file',
    );
    this.publisher = deps.publisher ?? null;
    this.payloadDirectory();
  }

  static fromSessionContext(
    ctx: SessionContext,
    opts: { publisher?: IMetaBusPublisher } = {},
  ): CompanyDriveStore {
    return new CompanyDriveStore({
      sessionStore: ctx.companyFiles.sessionStore,
      companySessionId: ctx.companySessionId,
      publisher: opts.publisher,
    });
  }

  resolveScopeKey(): string {
    return `session:${this.rootSessionId}`;
  }

  private assertScope(scopeKey: string): void {
    if (scopeKey !== this.resolveScopeKey()) {
      throw new Error(
        `Drive scope ${scopeKey} does not belong to Company session ${this.companySessionId}`,
      );
    }
  }

  private payloadDirectory(): string {
    ensureDirectoryNoLinks(this.bundlePath);
    const company = join(this.bundlePath, 'company');
    const payloads = join(company, 'drive-payloads');
    ensureDirectoryNoLinks(company);
    ensureDirectoryNoLinks(payloads);
    if (
      resolve(payloads) !== payloads ||
      payloads.slice(this.bundlePath.length + 1).startsWith(`..${sep}`)
    ) {
      throw new Error(`Company drive payload directory escaped bundle: ${payloads}`);
    }
    return payloads;
  }

  private payloadPath(payloadFile: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(payloadFile)) {
      throw new Error(`Invalid Company drive payload id: ${payloadFile}`);
    }
    return join(this.payloadDirectory(), payloadFile.toLowerCase());
  }

  private emit(
    event: 'drive.file_added' | 'drive.file_updated' | 'drive.file_deleted',
    data: unknown,
  ): void {
    if (!this.publisher) return;
    try {
      this.publisher.publish(event, data);
    } catch (error) {
      console.error('[CompanyDriveStore] publish failed:', error);
    }
  }

  private record(path: string) {
    return (
      this.files
        .list(this.rootSessionId)
        .find(
          (record) =>
            record.data.record_type === 'drive-file' &&
            record.data.path === path,
        ) ?? null
    );
  }

  private meta(record: NonNullable<ReturnType<CompanyDriveStore['record']>>): DriveFileMeta {
    return {
      id: record.id,
      seq: record.seq,
      scopeKey: this.resolveScopeKey(),
      path: record.data.path,
      sizeBytes: record.data.size_bytes,
      mime: record.data.mime,
      ownerRole: record.data.owner_role,
      ownerAgentRunId: record.data.owner_agent_run_id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  write(
    scopeKey: string,
    path: string,
    content: string,
    owner: DriveOwnerRef = {},
    expectedVersion?: string | null,
  ): DriveFileMeta {
    this.assertScope(scopeKey);
    validatePath(path);
    const payload = Buffer.from(content, 'utf8');
    if (payload.byteLength > MAX_WRITE_BYTES) {
      throw new Error(
        `content exceeds ${MAX_WRITE_BYTES} bytes (got ${payload.byteLength})`,
      );
    }
    let created = false;
    const record = this.files.upsertFirst(
      this.rootSessionId,
      (candidate) => candidate.data.path === path,
      () => {
        if (typeof expectedVersion === 'string') throw new Error('Document version conflict: document was removed; read again');
        created = true;
        const payloadFile = randomUUID();
        atomicWrite(this.payloadPath(payloadFile), payload);
        return {
          data: {
            record_type: 'drive-file',
            path,
            payload_file: payloadFile,
            size_bytes: payload.byteLength,
            mime: 'text/plain',
            owner_role: owner.role ?? null,
            owner_agent_run_id: owner.agentRunId ?? null,
          },
        };
      },
      (previous) => {
        if (expectedVersion !== undefined) {
          const version = createHash('sha256').update(readFileSync(this.payloadPath(previous.data.payload_file))).digest('hex');
          if (expectedVersion !== version) throw new Error('Document version conflict: another session updated it; read again');
        }
        atomicWrite(this.payloadPath(previous.data.payload_file), payload);
        return {
          ...previous.data,
          size_bytes: payload.byteLength,
          owner_role: owner.role ?? null,
          owner_agent_run_id: owner.agentRunId ?? null,
        };
      },
    );
    const meta = this.meta(record);
    this.emit(created ? 'drive.file_added' : 'drive.file_updated', { meta });
    return meta;
  }

  append(
    scopeKey: string,
    path: string,
    content: string,
    owner: DriveOwnerRef = {},
  ): DriveFileMeta {
    this.assertScope(scopeKey);
    validatePath(path);
    const suffix = Buffer.from(content, 'utf8');
    let created = false;
    const record = this.files.upsertFirst(
      this.rootSessionId,
      (candidate) => candidate.data.path === path,
      () => {
        created = true;
        if (suffix.byteLength > MAX_WRITE_BYTES) {
          throw new Error(
            `content exceeds ${MAX_WRITE_BYTES} bytes (got ${suffix.byteLength})`,
          );
        }
        const payloadFile = randomUUID();
        atomicWrite(this.payloadPath(payloadFile), suffix);
        return {
          data: {
            record_type: 'drive-file',
            path,
            payload_file: payloadFile,
            size_bytes: suffix.byteLength,
            mime: 'text/plain',
            owner_role: owner.role ?? null,
            owner_agent_run_id: owner.agentRunId ?? null,
          },
        };
      },
      (previous) => {
        const payloadPath = this.payloadPath(previous.data.payload_file);
        const current = readFileSync(payloadPath);
        const size = current.byteLength + suffix.byteLength;
        if (size > MAX_WRITE_BYTES) {
          throw new Error(
            `append would exceed ${MAX_WRITE_BYTES} bytes (got ${size})`,
          );
        }
        atomicWrite(payloadPath, Buffer.concat([current, suffix]));
        return {
          ...previous.data,
          size_bytes: size,
          owner_role: owner.role ?? previous.data.owner_role,
          owner_agent_run_id:
            owner.agentRunId ?? previous.data.owner_agent_run_id,
        };
      },
    );
    const meta = this.meta(record);
    this.emit(created ? 'drive.file_added' : 'drive.file_updated', { meta });
    return meta;
  }

  read(
    scopeKey: string,
    path: string,
    opts: DriveReadOpts = {},
  ): DriveFileWithContent {
    this.assertScope(scopeKey);
    validatePath(path);
    const record = this.record(path);
    if (!record) throw new Error(`shared file not found: ${path}`);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const maxBytes = Math.max(
      1,
      Math.min(
        MAX_READ_BYTES,
        Math.floor(opts.maxBytes ?? DEFAULT_READ_BYTES),
      ),
    );
    const payload = readFileSync(this.payloadPath(record.data.payload_file));
    const slice = payload.subarray(offset, offset + maxBytes);
    return {
      meta: this.meta(record),
      content: slice.toString('utf8'),
      truncated: offset + slice.byteLength < payload.byteLength,
    };
  }

  list(scopeKey: string, filters: DriveListFilters = {}): DriveFileMeta[] {
    this.assertScope(scopeKey);
    return this.files
      .list(this.rootSessionId)
      .filter(
        (record) =>
          record.data.record_type === 'drive-file' &&
          (!filters.prefix || record.data.path.startsWith(filters.prefix)) &&
          (!filters.ownerRole ||
            record.data.owner_role === filters.ownerRole),
      )
      .map((record) => this.meta(record))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  delete(scopeKey: string, path: string): boolean {
    this.assertScope(scopeKey);
    validatePath(path);
    const record = this.record(path);
    if (!record) return false;
    const trashed = this.files.moveToTrash(this.rootSessionId, record.id);
    if (!trashed) return false;

    const payload = this.payloadPath(record.data.payload_file);
    if (existsSync(payload)) {
      const companyTrash = join(this.bundlePath, 'company', 'trash');
      const payloadTrash = join(companyTrash, 'drive-payloads');
      ensureDirectoryNoLinks(companyTrash);
      ensureDirectoryNoLinks(payloadTrash);
      renameSync(payload, join(payloadTrash, record.data.payload_file));
      fsyncDirectoryBestEffort(dirname(payload));
      fsyncDirectoryBestEffort(payloadTrash);
    }
    this.emit('drive.file_deleted', {
      scopeKey,
      path,
      id: record.id,
      seq: record.seq,
    });
    return true;
  }

  reconcileSize(scopeKey: string, path: string): DriveFileMeta {
    this.assertScope(scopeKey);
    validatePath(path);
    const record = this.record(path);
    if (!record) throw new Error(`shared file not found: ${path}`);
    const size = statSync(this.payloadPath(record.data.payload_file)).size;
    const updated = this.files.update(
      this.rootSessionId,
      record.id,
      (previous) => ({ ...previous.data, size_bytes: size }),
    );
    return this.meta(updated);
  }
}
