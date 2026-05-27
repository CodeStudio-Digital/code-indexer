import type { Database as DB } from 'better-sqlite3';
import type {
  KanbanCard,
  KanbanCardAgent,
  KanbanCardDependency,
  KanbanChecklistItem,
  KanbanComment,
} from '@mcp/company/types.js';

type ChecklistRow = { id: number; card_id: number; text: string; checked: number; position: number };

// ─── Checklist ─────────────────────────────────────────────────

export function addChecklistItem(db: DB, cardId: number, text: string, position?: number): KanbanChecklistItem {
  const pos = position ?? (() => {
    const m = db.prepare(
      `SELECT COALESCE(MAX(position), -1) as m FROM kanban_checklist_items WHERE card_id = ?`
    ).get(cardId) as { m: number };
    return m.m + 1;
  })();
  const r = db.prepare(`
    INSERT INTO kanban_checklist_items (card_id, text, position) VALUES (?, ?, ?)
  `).run(cardId, text, pos);
  const row = db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as ChecklistRow;
  return { ...row, checked: row.checked === 1 };
}

export function updateChecklistItem(
  db: DB,
  itemId: number,
  patch: { text?: string; checked?: boolean; position?: number },
): KanbanChecklistItem | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.text !== undefined) { sets.push('text = ?'); params.push(patch.text); }
  if (patch.checked !== undefined) { sets.push('checked = ?'); params.push(patch.checked ? 1 : 0); }
  if (patch.position !== undefined) { sets.push('position = ?'); params.push(patch.position); }
  if (sets.length === 0) {
    const row = db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?').get(itemId) as ChecklistRow | undefined;
    return row ? { ...row, checked: row.checked === 1 } : null;
  }
  params.push(itemId);
  db.prepare(`UPDATE kanban_checklist_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?').get(itemId) as ChecklistRow | undefined;
  return row ? { ...row, checked: row.checked === 1 } : null;
}

export function removeChecklistItem(db: DB, itemId: number): boolean {
  const r = db.prepare('DELETE FROM kanban_checklist_items WHERE id = ?').run(itemId);
  return r.changes > 0;
}

export function getChecklistItem(db: DB, itemId: number): KanbanChecklistItem | null {
  const row = db.prepare('SELECT * FROM kanban_checklist_items WHERE id = ?').get(itemId) as ChecklistRow | undefined;
  return row ? { ...row, checked: row.checked === 1 } : null;
}

// ─── Comments ──────────────────────────────────────────────────

export function addComment(db: DB, cardId: number, authorRole: string, agentRunId: number | null, content: string): KanbanComment {
  const r = db.prepare(`
    INSERT INTO kanban_comments (card_id, author_role, agent_run_id, content)
    VALUES (?, ?, ?, ?)
  `).run(cardId, authorRole, agentRunId, content);
  return db.prepare('SELECT * FROM kanban_comments WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as KanbanComment;
}

export function listComments(db: DB, cardId: number): KanbanComment[] {
  return db
    .prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC')
    .all(cardId) as KanbanComment[];
}

// ─── Agent Assignment ──────────────────────────────────────────

export function assignAgent(db: DB, cardId: number, agentRunId: number, role: string): KanbanCardAgent {
  const r = db.prepare(`
    INSERT INTO kanban_card_agents (card_id, agent_run_id, role)
    VALUES (?, ?, ?)
  `).run(cardId, agentRunId, role);
  return db.prepare('SELECT * FROM kanban_card_agents WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as KanbanCardAgent;
}

export function unassignAgent(db: DB, cardId: number, agentRunId: number): void {
  db.prepare(`
    UPDATE kanban_card_agents SET unassigned_at = datetime('now')
    WHERE card_id = ? AND agent_run_id = ? AND unassigned_at IS NULL
  `).run(cardId, agentRunId);
}

export function findCardByAgentRun(db: DB, agentRunId: number): KanbanCard | null {
  const assignment = db.prepare(`
    SELECT card_id FROM kanban_card_agents
    WHERE agent_run_id = ? AND unassigned_at IS NULL
    ORDER BY assigned_at DESC LIMIT 1
  `).get(agentRunId) as { card_id: number } | undefined;
  if (!assignment) return null;
  return db.prepare('SELECT * FROM kanban_cards WHERE id = ?').get(assignment.card_id) as KanbanCard | undefined ?? null;
}

// ─── Dependencies ──────────────────────────────────────────────

export function addDependency(db: DB, cardId: number, dependsOnId: number): KanbanCardDependency {
  // Check circular dependency via recursive CTE
  const cycle = db.prepare(`
    WITH RECURSIVE chain(id) AS (
      SELECT card_id FROM kanban_card_dependencies WHERE depends_on_id = ?
      UNION
      SELECT kd.card_id FROM kanban_card_dependencies kd JOIN chain c ON kd.depends_on_id = c.id
    )
    SELECT 1 FROM chain WHERE id = ? LIMIT 1
  `).get(cardId, dependsOnId) as { '1': number } | undefined;

  if (cycle) throw new Error(`Adding dependency would create a cycle: card ${dependsOnId} already depends (transitively) on card ${cardId}`);

  const r = db.prepare(`
    INSERT INTO kanban_card_dependencies (card_id, depends_on_id)
    VALUES (?, ?)
  `).run(cardId, dependsOnId);
  return db.prepare('SELECT * FROM kanban_card_dependencies WHERE id = ?')
    .get(Number(r.lastInsertRowid)) as KanbanCardDependency;
}

export function removeDependency(db: DB, cardId: number, dependsOnId: number): boolean {
  const r = db.prepare(
    'DELETE FROM kanban_card_dependencies WHERE card_id = ? AND depends_on_id = ?'
  ).run(cardId, dependsOnId);
  return r.changes > 0;
}

/** Cards that have unresolved blockers (dependencies not in 'done'). */
export function getBlockedCards(db: DB, sessionId: number): KanbanCard[] {
  return db.prepare(`
    SELECT DISTINCT c.* FROM kanban_cards c
    JOIN kanban_card_dependencies d ON d.card_id = c.id
    JOIN kanban_cards blocker ON blocker.id = d.depends_on_id AND blocker."column" != 'done'
    WHERE c.company_session_id = ?
  `).all(sessionId) as KanbanCard[];
}
