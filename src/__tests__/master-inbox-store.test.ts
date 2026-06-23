/**
 * Master-inbox DAO tests (Phase A "living company").
 *
 * Covers the two new store methods that back `MasterInboxRouter`:
 *   - `claimAllPendingMasterMessages` — batch claim under one transaction
 *   - `listSessionsWithPendingMasterInbox` — boot-time scan helper
 *
 * Seeding shortcut: foreign_keys=OFF for the duration of the seed; only
 * the FK relationship matters at runtime — not for these CRUD checks.
 * Mirrors `inbox-store.test.ts` so future readers see the same shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import {
  MASTER_INBOX_SENTINEL,
  formatMasterInboxPrompt,
} from '@mcp/company/services/MasterInboxRouter.js';

let dir: string;
let cdb: CodeIndexDB;
let store: CompanyStore;
let dbPath: string;

const SESSION_A = 1;
const SESSION_B = 2;
const BACKEND_RUN = 100;
const FRONTEND_RUN = 101;
const QA_RUN = 102;

function seed(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (cdb as any).db as import('better-sqlite3').Database;
  raw.pragma('foreign_keys = OFF');
  try {
    raw.prepare(`INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`)
      .run(SESSION_A, 'a');
    raw.prepare(`INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`)
      .run(SESSION_B, 'b');
    for (const [id, sess, role, cs] of [
      [BACKEND_RUN, SESSION_A, 'backend', 1],
      [FRONTEND_RUN, SESSION_A, 'frontend', 2],
      [QA_RUN, SESSION_A, 'qa', 3],
    ] as const) {
      raw
        .prepare(
          `INSERT INTO company_agent_runs (id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status)
           VALUES (?, ?, ?, ?, '[]', '', '', 'waiting')`,
        )
        .run(id, sess, role, cs);
    }
  } finally {
    raw.pragma('foreign_keys = ON');
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-master-inbox-'));
  dbPath = join(dir, 'test.db');
  cdb = new CodeIndexDB(dbPath);
  store = new CompanyStore(dbPath);
  seed();
});

afterEach(() => {
  store.close();
  cdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CompanyStore — master inbox sentinel', () => {
  it('createInboxMessage accepts the __master__ sentinel as a free-form to_role', () => {
    const msg = store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'deploy ok',
    });
    expect(msg.to_role).toBe(MASTER_INBOX_SENTINEL);
    expect(msg.status).toBe('pending');
  });

  it('claimAllPendingMasterMessages batches every pending master row in FIFO order', () => {
    const m1 = store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'question',
      body: 'q1',
    });
    const m2 = store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: FRONTEND_RUN,
      fromRole: 'frontend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'question',
      body: 'q2',
    });
    const m3 = store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: QA_RUN,
      fromRole: 'qa',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'q3',
    });

    const claimed = store.claimAllPendingMasterMessages(SESSION_A);
    expect(claimed.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
    for (const m of claimed) expect(m.status).toBe('delivered');

    // Second claim must return [] — rows already delivered.
    const second = store.claimAllPendingMasterMessages(SESSION_A);
    expect(second).toEqual([]);
  });

  it('claimAllPendingMasterMessages ignores rows for sibling sessions and non-master targets', () => {
    // Same session, but addressed to a peer subordinate — should be skipped.
    store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: 'frontend',
      kind: 'question',
      body: 'peer-only',
    });
    // Master target on a DIFFERENT session — should not leak.
    store.createInboxMessage({
      companySessionId: SESSION_B,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'wrong-session',
    });
    const claimed = store.claimAllPendingMasterMessages(SESSION_A);
    expect(claimed).toEqual([]);
  });

  it('listSessionsWithPendingMasterInbox returns every session with at least one pending master row', () => {
    store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'a',
    });
    store.createInboxMessage({
      companySessionId: SESSION_B,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'b',
    });

    const ids = store.listSessionsWithPendingMasterInbox().sort();
    expect(ids).toEqual([SESSION_A, SESSION_B]);
  });

  it('listSessionsWithPendingMasterInbox excludes already-delivered rows', () => {
    store.createInboxMessage({
      companySessionId: SESSION_A,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'will-be-drained',
    });
    store.claimAllPendingMasterMessages(SESSION_A);
    expect(store.listSessionsWithPendingMasterInbox()).toEqual([]);
  });
});

describe('formatMasterInboxPrompt', () => {
  it('combines multiple messages with per-source attribution', () => {
    const out = formatMasterInboxPrompt([
      {
        id: 101,
        company_session_id: SESSION_A,
        from_agent_run_id: BACKEND_RUN,
        from_role: 'backend',
        to_role: MASTER_INBOX_SENTINEL,
        to_agent_run_id: null,
        kind: 'question',
        body: 'how to handle auth headers?',
        status: 'delivered',
        answer: null,
        wait_token: 'tok1',
        created_at: '',
        delivered_at: null,
        answered_at: null,
      },
      {
        id: 102,
        company_session_id: SESSION_A,
        from_agent_run_id: FRONTEND_RUN,
        from_role: 'frontend',
        to_role: MASTER_INBOX_SENTINEL,
        to_agent_run_id: null,
        kind: 'notify',
        body: 'smoke tests green',
        status: 'delivered',
        answer: null,
        wait_token: null,
        created_at: '',
        delivered_at: null,
        answered_at: null,
      },
    ]);
    expect(out).toContain('[INBOX — 2 message(s) from subordinates]');
    expect(out).toContain('[from @backend, run=100, message_id=101, kind=question]');
    expect(out).toContain('how to handle auth headers?');
    expect(out).toContain('[from @frontend, run=101, message_id=102, kind=notify]');
    expect(out).toContain('smoke tests green');
    expect(out).toContain('respond_to_inbox(message_id, answer)');
  });

  it('uses the question-only footer when no notify is present', () => {
    const out = formatMasterInboxPrompt([
      {
        id: 1,
        company_session_id: SESSION_A,
        from_agent_run_id: BACKEND_RUN,
        from_role: 'backend',
        to_role: MASTER_INBOX_SENTINEL,
        to_agent_run_id: null,
        kind: 'question',
        body: 'x?',
        status: 'delivered',
        answer: null,
        wait_token: null,
        created_at: '',
        delivered_at: null,
        answered_at: null,
      },
    ]);
    expect(out).toContain('Respond via respond_to_inbox');
    expect(out).not.toContain('FYI notification');
  });

  it('returns empty string for an empty list', () => {
    expect(formatMasterInboxPrompt([])).toBe('');
  });
});
