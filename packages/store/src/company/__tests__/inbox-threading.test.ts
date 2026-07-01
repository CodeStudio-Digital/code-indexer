/**
 * Tests for migration 184 — agent_inbox threading + priority.
 *
 *   - a fresh message roots its own thread (thread_id === id)
 *   - a reply inherits the parent thread_id
 *   - claimNextForAgent returns urgent before normal before low
 *   - getByWaitToken resolves the blocking-answer row directly
 *
 * Real temp SQLite via CodeIndexDB (runs all migrations incl. 184).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../../db.js';
import { CompanyStore } from '../../company-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';

interface Harness {
  db: CodeIndexDB;
  dir: string;
  companyStore: CompanyStore;
  sessionStore: SessionStore;
  companySessionId: number;
  runId: number;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-inbox-thread-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);
  const sessionStore = new SessionStore(dbPath);

  const project = db.createProject('p', '/tmp/proj');
  const cs = companyStore.createCompanySession({ name: 's' });
  const coder = sessionStore.createSession({ project_id: project.id, title: 't', provider: 'stub', model: 'stub' });
  const run = companyStore.createAgentRun({
    company_session_id: cs.id, role: 'backend', coder_session_id: coder.id,
    project_ids: [project.id], provider: 'stub', model: 'stub',
  });
  return { db, dir, companyStore, sessionStore, companySessionId: cs.id, runId: run.id };
}

function teardown(h: Harness): void {
  try { h.companyStore.close(); } catch { /* */ }
  try { h.sessionStore.close(); } catch { /* */ }
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('agent_inbox threading + priority (migration 184)', () => {
  let h: Harness;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('roots a fresh message on its own thread', () => {
    const m = h.companyStore.createInboxMessage({
      companySessionId: h.companySessionId, fromAgentRunId: h.runId, fromRole: 'backend',
      toRole: 'frontend', kind: 'notify', body: 'hi',
    });
    expect(m.thread_id).toBe(m.id);
    expect(m.priority).toBe('normal');
  });

  it('a reply inherits the parent thread_id', () => {
    const root = h.companyStore.createInboxMessage({
      companySessionId: h.companySessionId, fromAgentRunId: h.runId, fromRole: 'backend',
      toRole: 'frontend', kind: 'question', body: 'contract?',
    });
    const reply = h.companyStore.createInboxMessage({
      companySessionId: h.companySessionId, fromAgentRunId: h.runId, fromRole: 'frontend',
      toRole: 'backend', kind: 'notify', body: 'here it is',
      threadId: root.thread_id, replyToMessageId: root.id,
    });
    expect(reply.thread_id).toBe(root.thread_id);
    expect(reply.reply_to_message_id).toBe(root.id);
  });

  it('claims urgent before normal before low', () => {
    // Insert in NON-priority order to prove ordering isn't just FIFO.
    for (const [priority, body] of [['low', 'L'], ['urgent', 'U'], ['normal', 'N']] as const) {
      h.companyStore.createInboxMessage({
        companySessionId: h.companySessionId, fromAgentRunId: h.runId, fromRole: 'backend',
        toRole: 'qa', kind: 'notify', body, priority,
      });
    }
    const first = h.companyStore.claimNextInboxForAgent({ companySessionId: h.companySessionId, agentRunId: h.runId, role: 'qa' });
    const second = h.companyStore.claimNextInboxForAgent({ companySessionId: h.companySessionId, agentRunId: h.runId, role: 'qa' });
    const third = h.companyStore.claimNextInboxForAgent({ companySessionId: h.companySessionId, agentRunId: h.runId, role: 'qa' });
    expect(first?.body).toBe('U');
    expect(second?.body).toBe('N');
    expect(third?.body).toBe('L');
  });

  it('getByWaitToken resolves the blocking-answer row directly', () => {
    const m = h.companyStore.createInboxMessage({
      companySessionId: h.companySessionId, fromAgentRunId: h.runId, fromRole: 'backend',
      toRole: 'frontend', kind: 'question', body: 'q', waitToken: 'tok-123',
    });
    const found = h.companyStore.getInboxMessageByWaitToken(h.companySessionId, 'tok-123');
    expect(found?.id).toBe(m.id);
    expect(h.companyStore.getInboxMessageByWaitToken(h.companySessionId, 'nope')).toBeNull();
  });
});
