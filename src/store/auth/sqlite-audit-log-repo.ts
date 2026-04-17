import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  AuditEvent,
  AuditEventKind,
} from '../../core/auth/domain/audit-event.js';
import type { TokenType } from '../../core/auth/domain/auth-context.js';
import type {
  AuditLogQuery,
  AuditLogRepo,
} from '../../core/auth/ports/audit-log-repository.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

interface AuditRow {
  id: number;
  at: number;
  principal: string | null;
  token_type: string | null;
  event: string;
  status: number;
  tool_name: string | null;
  meta: string;
}

export class SqliteAuditLogRepo implements AuditLogRepo {
  private readonly db: DB;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  record(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO auth_audit_log (at, principal, token_type, event, status, tool_name, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.at,
        event.principal,
        event.tokenType,
        event.event,
        event.status,
        event.toolName,
        JSON.stringify(event.meta),
      );
  }

  query(filter: AuditLogQuery): AuditEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.since !== undefined) { clauses.push('at >= ?'); params.push(filter.since); }
    if (filter.until !== undefined) { clauses.push('at <= ?'); params.push(filter.until); }
    if (filter.principal) { clauses.push('principal = ?'); params.push(filter.principal); }
    if (filter.event) { clauses.push('event = ?'); params.push(filter.event); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = filter.limit ?? 500;
    params.push(limit);

    const rows = this.db
      .prepare<unknown[], AuditRow>(
        `SELECT * FROM auth_audit_log ${where} ORDER BY at DESC LIMIT ?`,
      )
      .all(...params);

    return rows.map((r) => rowToEvent(r));
  }

  purgeBefore(at: number): void {
    this.db.prepare('DELETE FROM auth_audit_log WHERE at < ?').run(at);
  }

  close(): void {
    this.db.close();
  }
}

function rowToEvent(r: AuditRow): AuditEvent {
  return {
    at: r.at,
    principal: r.principal,
    tokenType: r.token_type as TokenType | null,
    event: r.event as AuditEventKind,
    status: r.status,
    toolName: r.tool_name,
    meta: JSON.parse(r.meta) as Record<string, unknown>,
  };
}
