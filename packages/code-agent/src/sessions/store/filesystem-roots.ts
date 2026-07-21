import type { Database as DB } from 'better-sqlite3';
import type {
  SessionFilesystemAccess,
  SessionFilesystemRoot,
} from '@mcp/code-agent/sessions/types.js';

export function list(db: DB, sessionId: number): SessionFilesystemRoot[] {
  return db.prepare(`
    SELECT id, session_id, root_path, access, created_at, updated_at
      FROM coder_session_filesystem_roots
     WHERE session_id = ?
     ORDER BY id ASC
  `).all(sessionId) as SessionFilesystemRoot[];
}

export function upsert(
  db: DB,
  sessionId: number,
  rootPath: string,
  access: SessionFilesystemAccess,
): SessionFilesystemRoot {
  db.prepare(`
    INSERT INTO coder_session_filesystem_roots (session_id, root_path, access)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, root_path) DO UPDATE SET
      access = excluded.access,
      updated_at = datetime('now')
  `).run(sessionId, rootPath, access);
  return db.prepare(`
    SELECT id, session_id, root_path, access, created_at, updated_at
      FROM coder_session_filesystem_roots
     WHERE session_id = ? AND root_path = ?
  `).get(sessionId, rootPath) as SessionFilesystemRoot;
}

export function remove(db: DB, sessionId: number, rootId: number): boolean {
  return db.prepare(`
    DELETE FROM coder_session_filesystem_roots
     WHERE session_id = ? AND id = ?
  `).run(sessionId, rootId).changes > 0;
}

export function copy(db: DB, sourceSessionId: number, targetSessionId: number): void {
  db.prepare(`
    INSERT INTO coder_session_filesystem_roots (session_id, root_path, access)
    SELECT ?, root_path, access
      FROM coder_session_filesystem_roots
     WHERE session_id = ?
  `).run(targetSessionId, sourceSessionId);
}
