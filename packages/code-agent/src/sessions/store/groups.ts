import type { Database as DB } from 'better-sqlite3';
import type { CoderSessionGroup } from '@mcp/code-agent/sessions/types.js';

export interface CreateGroupInput {
  project_id: number;
  name: string;
  color?: string | null;
}

export function list(db: DB, projectId: number): CoderSessionGroup[] {
  return db
    .prepare('SELECT * FROM coder_session_groups WHERE project_id = ? ORDER BY sort_order, id')
    .all(projectId) as CoderSessionGroup[];
}

export function create(db: DB, input: CreateGroupInput): CoderSessionGroup {
  const r = db
    .prepare('INSERT INTO coder_session_groups (project_id, name, color) VALUES (?, ?, ?)')
    .run(input.project_id, input.name, input.color ?? null);
  return db
    .prepare('SELECT * FROM coder_session_groups WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as CoderSessionGroup;
}

export function update(
  db: DB, id: number,
  patch: { name?: string; color?: string | null; sort_order?: number },
): CoderSessionGroup | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
  if (patch.color !== undefined) { sets.push('color = ?'); params.push(patch.color); }
  if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(patch.sort_order); }
  if (sets.length === 0) {
    return (db.prepare('SELECT * FROM coder_session_groups WHERE id = ?').get(id) as CoderSessionGroup | undefined) ?? null;
  }
  sets.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE coder_session_groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return (db.prepare('SELECT * FROM coder_session_groups WHERE id = ?').get(id) as CoderSessionGroup | undefined) ?? null;
}

export function del(db: DB, id: number): void {
  // ON DELETE SET NULL on coder_sessions.group_id handles orphaned sessions.
  db.prepare('DELETE FROM coder_session_groups WHERE id = ?').run(id);
}
