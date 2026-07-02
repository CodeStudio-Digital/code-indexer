/**
 * CompanyDriveStore — shared file drive between agents of a company.
 *
 * Use case: subordinate A wants to deliver a multi-page spec / data dump
 * to the master or to a peer without inflating the inbox/board with the
 * full payload. Instead of copy-pasting the content into a message, the
 * agent calls `write_shared_file({ path: 'specs/auth.md', content: ... })`
 * and references the path in a small message.
 *
 * Scope:
 *   - When a session has a `template_id`, the drive is `tpl:<template_id>`
 *     so the same drive is visible to every session of that company.
 *   - When the session is template-less, the drive is `ses:<session_id>`
 *     (isolated per session).
 *
 * Storage split: metadata in `company_drive_files`; bytes on the host
 * filesystem at `<dataDir>/company-drives/<scopeKey>/<storage_filename>`.
 * `storage_filename` is a UUID, so renaming a logical `path` is a metadata-
 * only operation.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDataDir } from '@mcp/shared/utils/config.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { CompanyStore } from '@mcp/store/company-store.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import { assertRelativePath, DRIVE_WRITE_CAP_BYTES } from '@mcp/company/tools/file-path-core.js';

type DB = ReturnType<SessionContext['db']['raw']>;

export interface CompanyDriveStoreDeps {
  db: CodeIndexDB;
  companyStore: CompanyStore;
  companySessionId: number;
  /** Override on-disk root (defaults to <dataDir>/company-drives). */
  rootDir?: string;
  /**
   * Optional SSE publisher. When provided, every successful mutation
   * (write / append / delete) emits `drive.file_added`,
   * `drive.file_updated`, or `drive.file_deleted` so the dashboard can
   * keep its view up-to-date without polling.
   *
   * Routes that instantiate the drive without an active orchestrator
   * (session is dormant, no SSE consumers) omit the publisher.
   */
  publisher?: IMetaBusPublisher;
}

export interface DriveFileMeta {
  id: number;
  scopeKey: string;
  path: string;
  sizeBytes: number;
  mime: string;
  ownerRole: string | null;
  ownerAgentRunId: number | null;
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
  agentRunId?: number | null;
}

export interface DriveListFilters {
  prefix?: string;
  ownerRole?: string;
}

export interface DriveReadOpts {
  /** Byte offset into the file. Default 0. */
  offset?: number;
  /** Max bytes to return. Default 256KB; capped at 4MB. */
  maxBytes?: number;
}

const MAX_WRITE_BYTES = DRIVE_WRITE_CAP_BYTES; // 4 MB hard cap
const DEFAULT_READ_BYTES = 256 * 1024; // 256 KB
const MAX_READ_BYTES = 4 * 1024 * 1024;

interface DriveRow {
  id: number;
  scope_key: string;
  path: string;
  storage_filename: string;
  size_bytes: number;
  mime: string;
  owner_role: string | null;
  owner_agent_run_id: number | null;
  created_at: string;
  updated_at: string;
}

function rowToMeta(row: DriveRow): DriveFileMeta {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    path: row.path,
    sizeBytes: row.size_bytes,
    mime: row.mime,
    ownerRole: row.owner_role,
    ownerAgentRunId: row.owner_agent_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Shared rules live in `tools/file-path-core.ts`. Drive semantics:
 * segment-level `..` rejection (names like "..foo" stay legal — folder
 * uploads contain weird names) + the default 512-char length cap.
 */
function validatePath(p: string): void {
  assertRelativePath(p, { traversal: 'segment' });
}

export class CompanyDriveStore {
  private readonly db: DB;
  private readonly companyStore: CompanyStore;
  private readonly companySessionId: number;
  private readonly rootDir: string;
  private readonly publisher: IMetaBusPublisher | null;

  constructor(deps: CompanyDriveStoreDeps) {
    this.db = deps.db.raw();
    this.companyStore = deps.companyStore;
    this.companySessionId = deps.companySessionId;
    this.rootDir = deps.rootDir ?? join(ensureDataDir(), 'company-drives');
    this.publisher = deps.publisher ?? null;
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true });
    }
  }

  /** Build a drive store from a `SessionContext` (used by the orchestrator). */
  static fromSessionContext(
    ctx: SessionContext,
    opts: { rootDir?: string; publisher?: IMetaBusPublisher } = {},
  ): CompanyDriveStore {
    return new CompanyDriveStore({
      db: ctx.db,
      companyStore: ctx.companyStore,
      companySessionId: ctx.companySessionId,
      rootDir: opts.rootDir,
      publisher: opts.publisher,
    });
  }

  private emit(event: 'drive.file_added' | 'drive.file_updated' | 'drive.file_deleted', data: unknown): void {
    if (!this.publisher) return;
    try {
      this.publisher.publish(event, data);
    } catch (e) {
      // Publishing failures must never break a successful mutation —
      // the row is already committed by the time we get here.
      console.error('[CompanyDriveStore] publish failed:', e);
    }
  }

  /**
   * Resolve the scope key for this session.
   *   - `tpl:<id>` when the session has a template (shared across every
   *     session — including all sub-sessions / fronts — of that company
   *     template).
   *   - `ses:<rootId>` otherwise. For sub-sessions (migration 067), we
   *     walk up `parent_session_id` so the parent's drive is shared by
   *     all its tabs. Without this, every front would get its own
   *     empty drive and the master couldn't pass documents between
   *     parallel work streams of the same project.
   */
  resolveScopeKey(): string {
    const session = this.companyStore.getCompanySession(this.companySessionId);
    if (session && session.template_id != null) {
      return `tpl:${session.template_id}`;
    }
    const rootId = session?.parent_session_id ?? this.companySessionId;
    return `ses:${rootId}`;
  }

  private scopeDir(scopeKey: string): string {
    const safe = scopeKey.replace(':', '_');
    const dir = join(this.rootDir, safe);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  private getRow(scopeKey: string, path: string): DriveRow | null {
    const row = this.db
      .prepare('SELECT * FROM company_drive_files WHERE scope_key = ? AND path = ?')
      .get(scopeKey, path) as DriveRow | undefined;
    return row ?? null;
  }

  write(scopeKey: string, path: string, content: string, owner: DriveOwnerRef = {}): DriveFileMeta {
    validatePath(path);
    const buf = Buffer.from(content, 'utf8');
    if (buf.byteLength > MAX_WRITE_BYTES) {
      throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes (got ${buf.byteLength})`);
    }
    const dir = this.scopeDir(scopeKey);
    const existing = this.getRow(scopeKey, path);
    const storageFilename = existing?.storage_filename ?? randomUUID();
    const fullPath = join(dir, storageFilename);
    writeFileSync(fullPath, buf);

    if (existing) {
      this.db
        .prepare(
          `UPDATE company_drive_files
             SET size_bytes = ?, owner_role = ?, owner_agent_run_id = ?,
                 updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(buf.byteLength, owner.role ?? null, owner.agentRunId ?? null, existing.id);
      const meta = rowToMeta(this.getRow(scopeKey, path)!);
      this.emit('drive.file_updated', { meta });
      return meta;
    }

    const info = this.db
      .prepare(
        `INSERT INTO company_drive_files
           (scope_key, path, storage_filename, size_bytes, mime, owner_role, owner_agent_run_id)
         VALUES (?, ?, ?, ?, 'text/plain', ?, ?)`,
      )
      .run(scopeKey, path, storageFilename, buf.byteLength, owner.role ?? null, owner.agentRunId ?? null);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare('SELECT * FROM company_drive_files WHERE id = ?').get(id) as DriveRow;
    const meta = rowToMeta(row);
    this.emit('drive.file_added', { meta });
    return meta;
  }

  append(scopeKey: string, path: string, content: string, owner: DriveOwnerRef = {}): DriveFileMeta {
    validatePath(path);
    const buf = Buffer.from(content, 'utf8');
    const dir = this.scopeDir(scopeKey);
    const existing = this.getRow(scopeKey, path);

    if (!existing) {
      // Append to a missing file is equivalent to write.
      return this.write(scopeKey, path, content, owner);
    }

    const newSize = existing.size_bytes + buf.byteLength;
    if (newSize > MAX_WRITE_BYTES) {
      throw new Error(`append would exceed ${MAX_WRITE_BYTES} bytes (got ${newSize})`);
    }
    const fullPath = join(dir, existing.storage_filename);
    appendFileSync(fullPath, buf);
    this.db
      .prepare(
        `UPDATE company_drive_files
           SET size_bytes = ?, owner_role = COALESCE(?, owner_role),
               owner_agent_run_id = COALESCE(?, owner_agent_run_id),
               updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(newSize, owner.role ?? null, owner.agentRunId ?? null, existing.id);
    const meta = rowToMeta(this.getRow(scopeKey, path)!);
    this.emit('drive.file_updated', { meta });
    return meta;
  }

  read(scopeKey: string, path: string, opts: DriveReadOpts = {}): DriveFileWithContent {
    validatePath(path);
    const row = this.getRow(scopeKey, path);
    if (!row) throw new Error(`shared file not found: ${path}`);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const requested = opts.maxBytes ?? DEFAULT_READ_BYTES;
    const maxBytes = Math.max(1, Math.min(MAX_READ_BYTES, Math.floor(requested)));

    const fullPath = join(this.scopeDir(scopeKey), row.storage_filename);
    const buf = readFileSync(fullPath);
    const slice = buf.subarray(offset, offset + maxBytes);
    const truncated = offset + slice.byteLength < buf.byteLength;
    return {
      meta: rowToMeta(row),
      content: slice.toString('utf8'),
      truncated,
    };
  }

  list(scopeKey: string, filters: DriveListFilters = {}): DriveFileMeta[] {
    const where: string[] = ['scope_key = ?'];
    const params: unknown[] = [scopeKey];
    if (filters.prefix) {
      where.push('path LIKE ?');
      params.push(`${filters.prefix}%`);
    }
    if (filters.ownerRole) {
      where.push('owner_role = ?');
      params.push(filters.ownerRole);
    }
    const rows = this.db
      .prepare(`SELECT * FROM company_drive_files WHERE ${where.join(' AND ')} ORDER BY path ASC`)
      .all(...params) as DriveRow[];
    return rows.map(rowToMeta);
  }

  delete(scopeKey: string, path: string): boolean {
    validatePath(path);
    const row = this.getRow(scopeKey, path);
    if (!row) return false;
    const fullPath = join(this.scopeDir(scopeKey), row.storage_filename);
    try {
      if (existsSync(fullPath)) unlinkSync(fullPath);
    } catch {
      // best-effort: still drop the metadata so the row doesn't dangle
    }
    const info = this.db
      .prepare('DELETE FROM company_drive_files WHERE id = ?')
      .run(row.id);
    if (info.changes > 0) {
      this.emit('drive.file_deleted', { scopeKey, path, id: row.id });
      return true;
    }
    return false;
  }

  /** Sync metadata `size_bytes` with the on-disk file. Useful for tests. */
  reconcileSize(scopeKey: string, path: string): DriveFileMeta {
    const row = this.getRow(scopeKey, path);
    if (!row) throw new Error(`shared file not found: ${path}`);
    const fullPath = join(this.scopeDir(scopeKey), row.storage_filename);
    const stats = statSync(fullPath);
    this.db
      .prepare('UPDATE company_drive_files SET size_bytes = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(stats.size, row.id);
    return rowToMeta(this.getRow(scopeKey, path)!);
  }
}
