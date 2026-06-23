/**
 * Migration 024 — Kanban Board for Company Orchestrator.
 *
 * Adds structured task management tables scoped to company sessions.
 * Cards carry context (description, objectives, comments, agent history)
 * so agents can pick up tasks and resume instantly after context swaps.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const kanban024 = {
  version: 24,
  name: 'kanban',
  up(db: DB) {
    db.exec(`
      -- Core task cards
      CREATE TABLE IF NOT EXISTS kanban_cards (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        "column"           TEXT NOT NULL DEFAULT 'backlog'
                             CHECK("column" IN ('backlog','todo','in_progress','review','done')),
        position           INTEGER NOT NULL DEFAULT 0,
        tag                TEXT DEFAULT NULL
                             CHECK(tag IS NULL OR tag IN ('bug','feature','refactor','documentation')),
        created_by         TEXT NOT NULL DEFAULT 'master',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_cards_session
        ON kanban_cards(company_session_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_cards_column
        ON kanban_cards(company_session_id, "column", position);

      -- Objectives checklist per card
      CREATE TABLE IF NOT EXISTS kanban_checklist_items (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id  INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        text     TEXT NOT NULL,
        checked  INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_checklist_card
        ON kanban_checklist_items(card_id);

      -- Context log / agent notes
      CREATE TABLE IF NOT EXISTS kanban_comments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id      INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        author_role  TEXT NOT NULL,
        agent_run_id INTEGER REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        content      TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_comments_card
        ON kanban_comments(card_id);

      -- Which agents worked on each card
      CREATE TABLE IF NOT EXISTS kanban_card_agents (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id       INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        agent_run_id  INTEGER NOT NULL REFERENCES company_agent_runs(id) ON DELETE CASCADE,
        role          TEXT NOT NULL,
        assigned_at   TEXT NOT NULL DEFAULT (datetime('now')),
        unassigned_at TEXT DEFAULT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_agents_card
        ON kanban_card_agents(card_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_agents_run
        ON kanban_card_agents(agent_run_id);

      -- Blocking relationships between cards
      CREATE TABLE IF NOT EXISTS kanban_card_dependencies (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id       INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        depends_on_id INTEGER NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(card_id, depends_on_id),
        CHECK(card_id != depends_on_id)
      );

      CREATE INDEX IF NOT EXISTS idx_kanban_deps_card
        ON kanban_card_dependencies(card_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_deps_blocker
        ON kanban_card_dependencies(depends_on_id);
    `);
  },
};
