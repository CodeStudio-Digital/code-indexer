import type { AgentMemoryScope, AgentMemoryRow } from '@mcp/shared/types.js';
import type { DB } from './types.js';

export type MemoryListRow = Pick<AgentMemoryRow, 'id' | 'name' | 'description' | 'type' | 'scope' | 'source' | 'importance' | 'access_count' | 'archived_at' | 'archived_reason' | 'source_snapshot_id'> & { excerpt: string };

/** Counts only; never hydrate every memory body to render a diagnostics card. */
export function memoryCurationTotals(db: DB, scope: AgentMemoryScope, projectId: number) {
  const groups = db.prepare(`SELECT type, source, archived_at IS NOT NULL AS archived, COUNT(*) AS count
    FROM agent_memory WHERE (scope = ? OR (? = 'project' AND scope = 'local')) AND project_id = ? GROUP BY type, source, archived_at IS NOT NULL`)
    .all(scope, scope, projectId) as Array<{ type: string; source: string; archived: number; count: number }>;
  const totals = { total: 0, archived: 0, byCategory: {} as Record<string, number>, bySource: {} as Record<string, number> };
  for (const row of groups) {
    if (row.archived) { totals.archived += row.count; continue; }
    totals.total += row.count;
    totals.byCategory[row.type] = (totals.byCategory[row.type] ?? 0) + row.count;
    totals.bySource[row.source] = (totals.bySource[row.source] ?? 0) + row.count;
  }
  return totals;
}

/** Stable bounded pages. Full content is read separately when opening a note. */
export function listMemoryCurationPage(db: DB, scope: AgentMemoryScope, projectId: number,
  options: { offset?: number; limit?: number; archived?: boolean; query?: string } = {}) {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 40)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const query = (options.query ?? '').trim().slice(0, 200);
  const where = `(scope = ? OR (? = 'project' AND scope = 'local')) AND project_id = ? AND archived_at IS ${options.archived ? 'NOT ' : ''}NULL
    ${query ? 'AND (instr(lower(name), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)' : ''}`;
  const params = query ? [scope, scope, projectId, query, query, query] : [scope, scope, projectId];
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM agent_memory WHERE ${where}`).get(...params) as { count: number }).count;
  const items = db.prepare(`SELECT id, name, description, type, scope, source, importance, access_count,
      archived_at, archived_reason, source_snapshot_id, substr(content, 1, 360) AS excerpt
    FROM agent_memory WHERE ${where} ORDER BY importance DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as MemoryListRow[];
  return { items, total, offset, limit, nextOffset: offset + items.length < total ? offset + items.length : null,
    totals: memoryCurationTotals(db, scope, projectId) };
}

export function listLegacyMemoryPage(db: DB, projectId: number, offset = 0, limit = 40) {
  offset = Math.max(0, Math.trunc(offset)); limit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const totals = db.prepare(`SELECT COUNT(*) AS total,
    SUM(EXISTS(SELECT 1 FROM agent_memory m WHERE m.source_snapshot_id = s.id)) AS imported
    FROM snapshots s WHERE project_id = ? AND archived_at IS NULL`).get(projectId) as { total: number; imported: number | null };
  const items = db.prepare(`SELECT s.id, s.title, s.category, s.source, s.importance,
      substr(s.content, 1, 360) AS excerpt,
      (SELECT id FROM agent_memory m WHERE m.source_snapshot_id = s.id ORDER BY m.archived_at IS NULL DESC, m.id DESC LIMIT 1) AS importedMemoryId
    FROM snapshots s WHERE s.project_id = ? AND s.archived_at IS NULL ORDER BY s.id LIMIT ? OFFSET ?`)
    .all(projectId, limit, offset) as Array<{ id: number; title: string; category: string; source: string; importance: number; excerpt: string; importedMemoryId: number | null }>;
  return { items, total: totals.total, imported: totals.imported ?? 0, offset, limit,
    nextOffset: offset + items.length < totals.total ? offset + items.length : null };
}
