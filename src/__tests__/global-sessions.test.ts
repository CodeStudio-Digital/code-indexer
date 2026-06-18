import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';

/**
 * Global (multi-project) sessions — v2 virtual-union model (migration 152/155).
 *
 * A global session runs over a SYNTHETIC union project; the real linked projects
 * live in `coder_session_projects`. Covers the NEW behaviour AND the
 * non-regression invariant (normal sessions + project list unchanged).
 */
describe('global sessions (virtual union)', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projA: number;
  let projB: number;
  let synthetic: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'global-sessions-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    projA = db.createProject('proj-a', join(workDir, 'a')).id;
    projB = db.createProject('proj-b', join(workDir, 'b')).id;
    // The synthetic union project the http-api would create (root = junction dir).
    const sp = db.createProject('__global_test', join(workDir, 'union'));
    db.setProjectSynthetic(sp.id, true);
    synthetic = sp.id;
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('createGlobalSession runs over the synthetic project + links the real ones', () => {
    const s = store.createGlobalSession({
      project_id: synthetic,
      title: 'cross-project work',
      provider: 'anthropic',
      model: 'sonnet',
      realProjects: [{ projectId: projA, isPrimary: true }, { projectId: projB }],
    });
    expect(s.is_global).toBe(true);
    expect(s.project_id).toBe(synthetic); // the union, not a real project

    const linked = store.getSessionProjects(s.id);
    expect(linked.map((l) => l.project_id).sort()).toEqual([projA, projB].sort());
    expect(linked.find((l) => l.is_primary)?.project_id).toBe(projA);
  });

  it('listGlobalSessions shows the REAL primary name (not __global_) + linked_count', () => {
    const globals = store.listGlobalSessions();
    expect(globals.length).toBeGreaterThanOrEqual(1);
    const g = globals[0];
    expect(g.is_global).toBe(true);
    expect(g.project_name).toBe('proj-a'); // real primary, never the synthetic name
    expect(g.linked_count).toBe(2);
  });

  it('NON-REGRESSION: listProjects hides the synthetic union project', () => {
    const names = db.listProjects().map((p) => p.name);
    expect(names).toContain('proj-a');
    expect(names).toContain('proj-b');
    expect(names).not.toContain('__global_test');
    // ...but it IS reachable via the reuse-picker list.
    expect(db.listSyntheticProjects().map((p) => p.id)).toContain(synthetic);
  });

  it('REFCOUNT: countSessionsForProject tracks sessions on a reused union', () => {
    const before = store.countSessionsForProject(synthetic); // ≥1 from the first test
    const s2 = store.createGlobalSession({
      project_id: synthetic, // REUSE the same union
      title: 'second session on the same workspace',
      provider: 'anthropic',
      model: 'sonnet',
      realProjects: [{ projectId: projA, isPrimary: true }, { projectId: projB }],
    });
    expect(store.countSessionsForProject(synthetic)).toBe(before + 1);
    // Deleting one leaves the union referenced by the other → must NOT be torn down.
    store.deleteSession(s2.id);
    expect(store.countSessionsForProject(synthetic)).toBe(before);
    expect(db.getProject(synthetic)).toBeDefined(); // union still alive
  });

  it('NON-REGRESSION: per-project list excludes globals, includes normal sessions', () => {
    const normal = store.createSession({
      project_id: projA,
      title: 'normal session',
      provider: 'anthropic',
      model: 'sonnet',
    });
    expect(normal.is_global).toBe(false);

    const listA = store.listSessions(projA);
    expect(listA.some((x) => x.id === normal.id)).toBe(true); // normal shows...
    expect(listA.some((x) => x.is_global)).toBe(false); // ...globals don't.
  });

  it('snapshot baselines are keyed per-project (same relative path, two roots)', () => {
    const snap = new SessionFileSnapshotStore(store.getDb());
    const sessionId = 4242;
    // Same file_path, different project_id → two DISTINCT active baselines.
    const a = snap.recordBaselineAndEdit(
      { session_kind: 'coder', session_id: sessionId, project_id: projA, file_path: 'src/index.ts', content_before: 'A', existed_before: true, baseline_hash: 'ha', oversized: false },
      { turn_number: 1, tool_name: 'write_file', content_after_hash: 'x', was_delete: false },
    );
    const b = snap.recordBaselineAndEdit(
      { session_kind: 'coder', session_id: sessionId, project_id: projB, file_path: 'src/index.ts', content_before: 'B', existed_before: true, baseline_hash: 'hb', oversized: false },
      { turn_number: 1, tool_name: 'write_file', content_after_hash: 'y', was_delete: false },
    );
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.baseline.id).not.toBe(b.baseline.id);
    expect(a.baseline.project_id).toBe(projA);
    expect(b.baseline.project_id).toBe(projB);

    // A second edit to projA's file REUSES the same active baseline (dedup intact).
    const a2 = snap.recordBaselineAndEdit(
      { session_kind: 'coder', session_id: sessionId, project_id: projA, file_path: 'src/index.ts', content_before: 'A', existed_before: true, baseline_hash: 'ha', oversized: false },
      { turn_number: 2, tool_name: 'edit_file', content_after_hash: 'z', was_delete: false },
    );
    expect(a2.created).toBe(false);
    expect(a2.baseline.id).toBe(a.baseline.id);

    expect(snap.listActiveBaselineIds('coder', sessionId).sort()).toEqual([a.baseline.id, b.baseline.id].sort());
  });
});
