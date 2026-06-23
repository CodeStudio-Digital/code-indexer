import type { Database as DB } from 'better-sqlite3';
import type { BoardEntry, BoardKind } from '@mcp/company/types.js';

interface BoardRow {
  id: number;
  company_session_id: number;
  author_role: string;
  agent_run_id: number | null;
  kind: string;
  content: string;
  mentions_json: string;
  created_at: string;
  archive_id: number | null;
}

function mapBoardRow(row: BoardRow): BoardEntry {
  return {
    id: row.id,
    company_session_id: row.company_session_id,
    author_role: row.author_role,
    agent_run_id: row.agent_run_id,
    kind: row.kind as BoardKind,
    content: row.content,
    mentions: JSON.parse(row.mentions_json || '[]'),
    created_at: row.created_at,
    archive_id: row.archive_id ?? null,
  };
}

export function post(
  db: DB,
  companySessionId: number,
  authorRole: string,
  agentRunId: number | null,
  kind: BoardKind,
  content: string,
  mentions?: string[],
): BoardEntry {
  const stmt = db.prepare(`
    INSERT INTO company_board (company_session_id, author_role, agent_run_id, kind, content, mentions_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    companySessionId,
    authorRole,
    agentRunId,
    kind,
    content,
    JSON.stringify(mentions ?? []),
  );
  return getEntry(db, Number(r.lastInsertRowid))!;
}

export function getEntry(db: DB, id: number): BoardEntry | null {
  const row = db
    .prepare('SELECT * FROM company_board WHERE id = ?')
    .get(id) as BoardRow | undefined;
  return row ? mapBoardRow(row) : null;
}

export function read(
  db: DB,
  companySessionId: number,
  opts?: { sinceId?: number; limit?: number; kind?: BoardKind },
): BoardEntry[] {
  const clauses: string[] = ['company_session_id = ?', 'archive_id IS NULL'];
  const params: unknown[] = [companySessionId];
  if (opts?.sinceId != null) { clauses.push('id > ?'); params.push(opts.sinceId); }
  if (opts?.kind) { clauses.push('kind = ?'); params.push(opts.kind); }
  const limit = opts?.limit ?? 100;
  params.push(limit);
  const whereClause = clauses.join(' AND ');
  // With sinceId: fetch next N entries after that point (ASC is correct).
  // Without sinceId: fetch the LATEST N entries via DESC subquery, re-sorted ASC.
  const sql = opts?.sinceId != null
    ? `SELECT * FROM company_board WHERE ${whereClause} ORDER BY id ASC LIMIT ?`
    : `SELECT * FROM (SELECT * FROM company_board WHERE ${whereClause} ORDER BY id DESC LIMIT ?) ORDER BY id ASC`;
  const rows = db.prepare(sql).all(...params) as BoardRow[];
  return rows.map(mapBoardRow);
}

export function readArchived(db: DB, archiveId: number): BoardEntry[] {
  const rows = db
    .prepare('SELECT * FROM company_board WHERE archive_id = ? ORDER BY id ASC')
    .all(archiveId) as BoardRow[];
  return rows.map(mapBoardRow);
}
