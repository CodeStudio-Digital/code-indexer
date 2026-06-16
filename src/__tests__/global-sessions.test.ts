import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SessionFileSnapshotStore } from '@mcp/store/session-file-snapshot-store.js';

/**
 * Global (multi-project) sessions — migration 152/153/154.
 *
 * Covers the NEW behaviour AND the non-regression invariant: a normal
 * single-project session must list and behave exactly as before.
 */
describe('global sessions (multi-project)', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projA: number;
  let projB: number;
  let projC: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'global-sessions-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    projA = db.createProject('proj-a', join(workDir, 'a')).id;
    projB = db.createProject('proj-b', join(workDir, 'b')).id;
    projC = db.createProject('proj-c', join(workDir, 'c')).id;
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('createGlobalSession links primary + secondaries; is_global = true', () => {
    const s = store.createGlobalSession({
      project_id: projA,
      title: 'cross-project work',
      provider: 'anthropic',
      model: 'sonnet',
      secondaryProjects: [{ projectId: projB }, { projectId: projC }],
    });
    expect(s.is_global).toBe(true);
    expect(s.project_id).toBe(projA);

    const linked = store.getSessionProjects(s.id);
    expect(linked.map((l) => l.project_id).sort()).toEqual([projA, projB, projC].sort());
    const primary = linked.find((l) => l.is_primary);
    expect(primary?.project_id).toBe(projA);
    // Secondaries are not primary.
    expect(linked.filter((l) => l.is_primary)).toHaveLength(1);
  });

  it('listGlobalSessions returns globals with primary name + linked_count', () => {
    const globals = store.listGlobalSessions();
    expect(globals.length).toBeGreaterThanOrEqual(1);
    const g = globals[0];
    expect(g.is_global).toBe(true);
    expect(g.project_name).toBe('proj-a');
    expect(g.linked_count).toBe(3);
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
    // The normal session shows up...
    expect(listA.some((x) => x.id === normal.id)).toBe(true);
    // ...but the global session (also primary = projA) does NOT.
    expect(listA.some((x) => x.is_global)).toBe(false);
  });

  it('NON-REGRESSION: a global session does not leak into a secondary project list', () => {
    const listB = store.listSessions(projB);
    expect(listB.some((x) => x.is_global)).toBe(false);
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

    // Two active baselines for this session — one per project.
    expect(snap.listActiveBaselineIds('coder', sessionId).sort()).toEqual([a.baseline.id, b.baseline.id].sort());
  });
});
