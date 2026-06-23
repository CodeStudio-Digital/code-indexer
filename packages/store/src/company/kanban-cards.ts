import type { Database as DB } from 'better-sqlite3';
import type {
  KanbanCard,
  KanbanCardAgent,
  KanbanCardFull,
  KanbanCardDependency,
  KanbanColumn,
  KanbanComment,
  KanbanTag,
} from '@mcp/company/types.js';

export interface CreateCardInput {
  title: string;
  description?: string;
  column?: KanbanColumn;
  tag?: KanbanTag | null;
  created_by?: string;
}

export function create(db: DB, sessionId: number, input: CreateCardInput): KanbanCard {
  const col = input.column ?? 'backlog';
  const maxPos = db.prepare(
    `SELECT COALESCE(MAX(position), -1) as m FROM kanban_cards WHERE company_session_id = ? AND "column" = ?`
  ).get(sessionId, col) as { m: number };

  const stmt = db.prepare(`
    INSERT INTO kanban_cards (company_session_id, title, description, "column", position, tag, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(
    sessionId,
    input.title,
    input.description ?? '',
    col,
    maxPos.m + 1,
    input.tag ?? null,
    input.created_by ?? 'master',
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, cardId: number): KanbanCard | null {
  const row = db
    .prepare('SELECT * FROM kanban_cards WHERE id = ?')
    .get(cardId) as KanbanCard | undefined;
  return row ?? null;
}

export function getFull(db: DB, cardId: number): KanbanCardFull | null {
  const card = get(db, cardId);
  if (!card) return null;

  const checklist = db
    .prepare('SELECT * FROM kanban_checklist_items WHERE card_id = ? ORDER BY position ASC')
    .all(cardId) as Array<{ id: number; card_id: number; text: string; checked: number; position: number }>;

  const comments = db
    .prepare('SELECT * FROM kanban_comments WHERE card_id = ? ORDER BY created_at ASC')
    .all(cardId) as KanbanComment[];

  const agents = db
    .prepare('SELECT * FROM kanban_card_agents WHERE card_id = ? ORDER BY assigned_at ASC')
    .all(cardId) as KanbanCardAgent[];

  const dependencies = db
    .prepare('SELECT * FROM kanban_card_dependencies WHERE card_id = ? ORDER BY id ASC')
    .all(cardId) as KanbanCardDependency[];

  const blockerIds = dependencies.map(d => d.depends_on_id);
  const blocked_by: number[] = [];
  for (const depId of blockerIds) {
    const dep = db
      .prepare(`SELECT "column" FROM kanban_cards WHERE id = ?`)
      .get(depId) as { column: string } | undefined;
    if (dep && dep.column !== 'done') blocked_by.push(depId);
  }

  return {
    ...card,
    checklist: checklist.map(c => ({ ...c, checked: c.checked === 1 })),
    comments,
    agents,
    dependencies,
    blocked_by,
  };
}

export function list(db: DB, sessionId: number, opts?: { column?: KanbanColumn }): KanbanCard[] {
  if (opts?.column) {
    return db
      .prepare(`SELECT * FROM kanban_cards WHERE company_session_id = ? AND "column" = ? AND archive_id IS NULL ORDER BY position ASC`)
      .all(sessionId, opts.column) as KanbanCard[];
  }
  return db
    .prepare(`SELECT * FROM kanban_cards WHERE company_session_id = ? AND archive_id IS NULL ORDER BY "column" ASC, position ASC`)
    .all(sessionId) as KanbanCard[];
}

export function listArchived(db: DB, archiveId: number): KanbanCard[] {
  return db
    .prepare(`SELECT * FROM kanban_cards WHERE archive_id = ? ORDER BY "column" ASC, position ASC`)
    .all(archiveId) as KanbanCard[];
}

export function listFull(db: DB, sessionId: number): KanbanCardFull[] {
  const cards = list(db, sessionId);
  return cards.map(c => getFull(db, c.id)!);
}

export function move(db: DB, cardId: number, toColumn: KanbanColumn, toPosition?: number): KanbanCard {
  const tx = db.transaction(() => {
    const card = get(db, cardId);
    if (!card) throw new Error(`Card ${cardId} not found`);

    const fromColumn = card.column;
    const fromPosition = card.position;

    if (fromColumn === toColumn) {
      const targetPos = toPosition ?? card.position;
      if (targetPos === fromPosition) {
        db.prepare(`UPDATE kanban_cards SET updated_at = datetime('now') WHERE id = ?`).run(cardId);
        return get(db, cardId)!;
      }
      db.prepare(`
        UPDATE kanban_cards SET position = position - 1
        WHERE company_session_id = ? AND "column" = ? AND position > ?
      `).run(card.company_session_id, fromColumn, fromPosition);
      db.prepare(`
        UPDATE kanban_cards SET position = position + 1
        WHERE company_session_id = ? AND "column" = ? AND position >= ?
      `).run(card.company_session_id, toColumn, targetPos);
      db.prepare(`
        UPDATE kanban_cards SET position = ?, updated_at = datetime('now') WHERE id = ?
      `).run(targetPos, cardId);
    } else {
      db.prepare(`
        UPDATE kanban_cards SET position = position - 1
        WHERE company_session_id = ? AND "column" = ? AND position > ?
      `).run(card.company_session_id, fromColumn, fromPosition);

      let targetPos: number;
      if (toPosition !== undefined) {
        targetPos = toPosition;
      } else {
        const maxPos = db.prepare(
          `SELECT COALESCE(MAX(position), -1) as m FROM kanban_cards WHERE company_session_id = ? AND "column" = ?`
        ).get(card.company_session_id, toColumn) as { m: number };
        targetPos = maxPos.m + 1;
      }

      db.prepare(`
        UPDATE kanban_cards SET position = position + 1
        WHERE company_session_id = ? AND "column" = ? AND position >= ?
      `).run(card.company_session_id, toColumn, targetPos);

      db.prepare(`
        UPDATE kanban_cards SET "column" = ?, position = ?, updated_at = datetime('now') WHERE id = ?
      `).run(toColumn, targetPos, cardId);
    }

    return get(db, cardId)!;
  });

  return tx();
}

export function update(db: DB, cardId: number, patch: { title?: string; description?: string; tag?: KanbanTag | null }): KanbanCard | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description); }
  if (patch.tag !== undefined) { sets.push('tag = ?'); params.push(patch.tag); }
  if (sets.length === 0) return get(db, cardId);
  sets.push("updated_at = datetime('now')");
  params.push(cardId);
  db.prepare(`UPDATE kanban_cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return get(db, cardId);
}

export function del(db: DB, cardId: number): boolean {
  const r = db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(cardId);
  return r.changes > 0;
}
