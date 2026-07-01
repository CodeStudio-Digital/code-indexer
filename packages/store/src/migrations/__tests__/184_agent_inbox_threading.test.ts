/**
 * Migration 184 — agent_inbox_threading.
 *
 * Pin invariants:
 *   - On a PROJECT DB (agent_inbox trimmed away — it is in CENTRAL_DROP_TABLES)
 *     up() is a no-op, NOT a crash. Without the tableExists guard the ALTER /
 *     CREATE INDEX threw `no such table: agent_inbox` and crash-looped the
 *     indexer-worker on upgrade.
 *   - On a CENTRAL DB (agent_inbox present) up() adds the 4 threading columns
 *     plus the 2 indexes, and is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { agentInboxThreading184 } from '../184_agent_inbox_threading.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

const NEW_COLUMNS = ['thread_id', 'reply_to_message_id', 'priority', 'context_json'];
const NEW_INDEXES = ['idx_inbox_wait_token', 'idx_inbox_thread'];

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_inbox'`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

// Minimal agent_inbox (mig 059) — only the columns the threading indexes read.
function createInbox(): void {
  db.exec(`CREATE TABLE agent_inbox (id INTEGER PRIMARY KEY, company_session_id INTEGER, wait_token TEXT)`);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
});

describe('migration 184 — agent_inbox_threading', () => {
  it('no-ops when agent_inbox is absent (trimmed project DB)', () => {
    expect(colNames('agent_inbox')).toEqual([]); // table genuinely absent
    expect(() => agentInboxThreading184.up(db)).not.toThrow();
    expect(colNames('agent_inbox')).toEqual([]); // still absent — guard creates nothing
  });

  it('adds the threading columns and indexes when agent_inbox exists (central DB)', () => {
    createInbox();
    agentInboxThreading184.up(db);
    for (const col of NEW_COLUMNS) expect(colNames('agent_inbox')).toContain(col);
    for (const idx of NEW_INDEXES) expect(indexNames()).toContain(idx);
  });

  it('is idempotent — a second up() run is a no-op', () => {
    createInbox();
    agentInboxThreading184.up(db);
    expect(() => agentInboxThreading184.up(db)).not.toThrow();
    expect(colNames('agent_inbox').filter((c) => c === 'priority')).toHaveLength(1);
  });
});
