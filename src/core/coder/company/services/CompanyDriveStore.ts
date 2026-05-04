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

import { ensureDataDir } from '../../../../utils/config.js';
import type { CodeIndexDB } from '../../../../store/db.js';
import type { CompanyStore } from '../../../../store/company-store.js';
import type { SessionContext } from './SessionContext.js';

type DB = ReturnType<SessionContext['db']['raw']>;

export interface CompanyDriveStoreDeps {
  db: CodeIndexDB;
  companyStore: CompanyStore;
  companySessionId: number;
  /** Override on-disk root (defaults to <dataDir>/company-drives). */
  rootDir?: string;
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

const MAX_WRITE_BYTES = 4 * 1024 * 1024; // 4 MB hard cap
const DEFAULT_READ_BYTES = 256 * 1024; // 256 KB
const MAX_READ_BYTES = 4 * 1024 * 1024;
// Reject control characters (including the null byte already checked
// separately). Everything else printable is fine — folder uploads from
// the dashboard frequently contain spaces, parens, accents, '+', etc.
const FORBIDDEN_PATH_RE = /[\x00-\x1f]/;

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

function validatePath(p: string): void {
  if (!p) throw new Error('path is required');
  if (p.length > 512) throw new Error('path is too long (>512 chars)');
  if (p.includes('\0')) throw new Error('path must not contain null bytes');
  if (FORBIDDEN_PATH_RE.test(p)) throw new Error('path must not contain control characters');
  if (p.includes('\\')) throw new Error('path must use forward slashes ("/"), not backslashes');
  if (p.startsWith('/')) throw new Error('path must be relative (no leading "/")');
  // Reject any segment that is exactly ".." (still allow names like "..foo").
  for (const seg of p.split('/')) {
    if (seg === '..') throw new Error('path must not contain ".." segments');
  }
}

export class CompanyDriveStore {
  private readonly db: DB;
  private readonly companyStore: CompanyStore;
  private readonly companySessionId: number;
  private readonly rootDir: string;

  constructor(deps: CompanyDriveStoreDeps) {
    this.db = deps.db.raw();
    this.companyStore = deps.companyStore;
    this.companySessionId = deps.companySessionId;
    this.rootDir = deps.rootDir ?? join(ensureDataDir(), 'company-drives');
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true });
    }
  }

  /** Build a drive store from a `SessionContext` (used by the orchestrator). */
  static fromSessionContext(ctx: SessionContext, opts: { rootDir?: string } = {}): CompanyDriveStore {
    return new CompanyDriveStore({
      db: ctx.db,
      companyStore: ctx.companyStore,
      companySessionId: ctx.companySessionId,
      rootDir: opts.rootDir,
    });
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
      return rowToMeta(this.getRow(scopeKey, path)!);
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
    return rowToMeta(row);
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
    return rowToMeta(this.getRow(scopeKey, path)!);
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
    return info.changes > 0;
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
