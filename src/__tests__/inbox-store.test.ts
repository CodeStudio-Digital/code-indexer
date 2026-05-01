/**
 * Inbox store integration tests. Verifies the persistence + claim/answer
 * paths used by `InboxQueue`. We bypass `createAgentRun` (which would
 * require fabricating coder sessions too) and seed agent_runs through
 * raw SQL — only the FK relationship matters here, not the runtime
 * lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../store/db.js';
import { CompanyStore } from '../store/company-store.js';
import { formatInboxPrompt } from '../core/coder/company/services/InboxQueue.js';

let dir: string;
let cdb: CodeIndexDB;
let store: CompanyStore;
let dbPath: string;

const SESSION_ID = 1;
const FROM_RUN_ID = 100;
const TO_RUN_ID = 200;
const OTHER_RUN_ID = 300;

function seed(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (cdb as any).db as import('better-sqlite3').Database;
  // Foreign keys touch projects → coder_sessions → company_agent_runs.
  // Seeding the full chain isn't worth it for inbox CRUD tests; flip
  // the pragma off for the duration of the seed and back on after.
  raw.pragma('foreign_keys = OFF');
  try {
    raw
      .prepare(`INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`)
      .run(SESSION_ID, 'test');
    raw
      .prepare(
        `INSERT INTO company_agent_runs (id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status)
         VALUES (?, ?, ?, ?, '[]', '', '', 'waiting')`,
      )
      .run(FROM_RUN_ID, SESSION_ID, 'frontend', 1);
    raw
      .prepare(
        `INSERT INTO company_agent_runs (id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status)
         VALUES (?, ?, ?, ?, '[]', '', '', 'waiting')`,
      )
      .run(TO_RUN_ID, SESSION_ID, 'backend', 2);
    raw
      .prepare(
        `INSERT INTO company_agent_runs (id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status)
         VALUES (?, ?, ?, ?, '[]', '', '', 'running')`,
      )
      .run(OTHER_RUN_ID, SESSION_ID, 'backend', 3);
  } finally {
    raw.pragma('foreign_keys = ON');
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-inbox-'));
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

describe('CompanyStore — agent inbox', () => {
  it('createInboxMessage round-trips through getInboxMessage', () => {
    const msg = store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'where is auth?',
      waitToken: 'tok_1',
    });
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.status).toBe('pending');
    expect(msg.wait_token).toBe('tok_1');

    const fetched = store.getInboxMessage(msg.id);
    expect(fetched?.body).toBe('where is auth?');
    expect(fetched?.from_role).toBe('frontend');
    expect(fetched?.to_role).toBe('backend');
  });

  it('listInboxMessages filters by status and to_role', () => {
    store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'a',
    });
    store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'qa',
      kind: 'notify',
      body: 'b',
    });

    const toBackend = store.listInboxMessages({
      companySessionId: SESSION_ID,
      toRole: 'backend',
      status: 'pending',
    });
    expect(toBackend).toHaveLength(1);
    expect(toBackend[0].body).toBe('a');

    const arrayStatus = store.listInboxMessages({
      companySessionId: SESSION_ID,
      status: ['pending', 'delivered'],
    });
    expect(arrayStatus).toHaveLength(2);
  });

  it('claimNextInboxForAgent flips pending → delivered atomically and returns null on second attempt', () => {
    const m = store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'first',
    });
    const claimed = store.claimNextInboxForAgent({
      companySessionId: SESSION_ID,
      agentRunId: TO_RUN_ID,
      role: 'backend',
    });
    expect(claimed?.id).toBe(m.id);
    expect(claimed?.status).toBe('delivered');
    expect(claimed?.to_agent_run_id).toBe(TO_RUN_ID);

    const second = store.claimNextInboxForAgent({
      companySessionId: SESSION_ID,
      agentRunId: TO_RUN_ID,
      role: 'backend',
    });
    expect(second).toBeNull();
  });

  it('claimNextInboxForAgent ignores messages addressed to other roles', () => {
    store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'qa',
      kind: 'question',
      body: 'qa-only',
    });
    const claimed = store.claimNextInboxForAgent({
      companySessionId: SESSION_ID,
      agentRunId: TO_RUN_ID,
      role: 'backend',
    });
    expect(claimed).toBeNull();
  });

  it('answerInboxMessage flips to answered and stores the answer', () => {
    const m = store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'q',
    });
    store.claimNextInboxForAgent({
      companySessionId: SESSION_ID,
      agentRunId: TO_RUN_ID,
      role: 'backend',
    });
    const answered = store.answerInboxMessage(m.id, 'a');
    expect(answered?.status).toBe('answered');
    expect(answered?.answer).toBe('a');
    expect(answered?.answered_at).not.toBeNull();
  });

  it('answerInboxMessage on a terminal row returns null', () => {
    const m = store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'q',
    });
    store.answerInboxMessage(m.id, 'first');
    const second = store.answerInboxMessage(m.id, 'second');
    expect(second).toBeNull();
  });

  it('setInboxStatus moves to cancelled and records answer text', () => {
    const m = store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: FROM_RUN_ID,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'q',
    });
    const cancelled = store.setInboxStatus(m.id, 'cancelled', { answer: '(cancelled: deadlock)' });
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.answer).toContain('cancelled');
  });
});

describe('formatInboxPrompt', () => {
  it('renders the message id, originator role and respond_to_inbox hint', () => {
    const out = formatInboxPrompt({
      id: 42,
      company_session_id: 1,
      from_agent_run_id: 100,
      from_role: 'frontend',
      to_role: 'backend',
      to_agent_run_id: null,
      kind: 'question',
      body: 'name of auth fn?',
      status: 'delivered',
      answer: null,
      wait_token: null,
      created_at: '',
      delivered_at: null,
      answered_at: null,
    });
    expect(out).toContain('[INBOX message_id=42 from=@frontend]');
    expect(out).toContain('name of auth fn?');
    expect(out).toContain('respond_to_inbox(message_id=42');
  });
});
