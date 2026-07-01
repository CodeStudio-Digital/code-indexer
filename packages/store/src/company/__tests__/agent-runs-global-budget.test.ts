/**
 * Tests for countActiveSubordinatesGlobal — the org-wide spawn budget count.
 * Counts active, non-master, non-archived subordinate runs ACROSS sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../../db.js';
import { CompanyStore } from '../../company-store.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import type { AgentRunStatus } from '@mcp/company/types.js';

interface H { db: CodeIndexDB; dir: string; store: CompanyStore; sessions: SessionStore; projectId: number; }

function setup(): H {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-global-budget-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const store = new CompanyStore(dbPath);
  const sessions = new SessionStore(dbPath);
  const projectId = db.createProject('p', '/tmp/proj').id;
  return { db, dir, store, sessions, projectId };
}
function teardown(h: H): void {
  try { h.store.close(); } catch { /* */ }
  try { h.sessions.close(); } catch { /* */ }
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('countActiveSubordinatesGlobal', () => {
  let h: H;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  function addRun(csId: number, role: string, status: AgentRunStatus): number {
    const coder = h.sessions.createSession({ project_id: h.projectId, title: 't', provider: 'x', model: 'x' });
    const run = h.store.createAgentRun({
      company_session_id: csId, role, coder_session_id: coder.id,
      project_ids: [h.projectId], provider: 'x', model: 'x',
    });
    h.store.updateAgentRunStatus(run.id, status);
    return run.id;
  }

  it('counts active non-master subordinates across all sessions', () => {
    const a = h.store.createCompanySession({ name: 'a' }).id;
    const b = h.store.createCompanySession({ name: 'b' }).id;
    addRun(a, 'backend', 'running');      // counts
    addRun(a, 'frontend', 'waiting');     // counts (idle-but-reactivatable)
    addRun(b, 'qa', 'working');           // counts (other session)
    addRun(a, 'master', 'running');       // excluded: master
    addRun(b, 'backend', 'completed');    // excluded: terminal
    addRun(b, 'backend', 'error');        // excluded: terminal
    expect(h.store.countActiveSubordinatesGlobal()).toBe(3);
  });

  it('returns 0 when nothing is active', () => {
    const a = h.store.createCompanySession({ name: 'a' }).id;
    addRun(a, 'backend', 'completed');
    expect(h.store.countActiveSubordinatesGlobal()).toBe(0);
  });
});
