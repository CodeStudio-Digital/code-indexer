/**
 * AppStudioStore (migration 200) — pina os invariantes da feature:
 * 1 sessão por projeto (UNIQUE project_id), upsert de feature no
 * UNIQUE(app_session_id, name, kind) e delete explícito de filhos
 * (FK cascade não é garantido sem PRAGMA foreign_keys ON).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { AppStudioStore } from '../app-studio-store.js';

interface Handle {
  db: CodeIndexDB;
  store: AppStudioStore;
  dir: string;
  projectId: number;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-app-studio-store-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const raw = db.raw();
  const info = raw
    .prepare("INSERT INTO projects (name, root_path) VALUES ('app', ?)")
    .run(join(dir, 'ws'));
  return { db, store: new AppStudioStore(raw), dir, projectId: Number(info.lastInsertRowid) };
}

describe('AppStudioStore', () => {
  let h: Handle;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('creates a session with defaults and finds it by project', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'Lanchonete', app_slug: 'lanchonete' });
    expect(s.stack).toBe('cf-fullstack');
    expect(s.db_engine).toBe('d1');
    expect(s.pipeline_json).toBeNull();
    expect(h.store.getSessionByProjectId(h.projectId)?.id).toBe(s.id);
  });

  it('enforces 1 session per project', () => {
    h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    expect(() => h.store.createSession({ project_id: h.projectId, name: 'B', app_slug: 'b' })).toThrow();
  });

  it('updates the JSON documents independently', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.setSpecJson(s.id, '{"v":1}');
    h.store.setPipelineJson(s.id, '{"v":1,"stages":[]}');
    const updated = h.store.setDeployJson(s.id, '{"url":null}');
    expect(updated.spec_json).toBe('{"v":1}');
    expect(updated.pipeline_json).toBe('{"v":1,"stages":[]}');
    expect(updated.deploy_json).toBe('{"url":null}');
  });

  it('upserts features on (session, name, kind) and lists them', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.upsertFeature({ app_session_id: s.id, name: 'PainelScreen', kind: 'screen', summary: 'v1' });
    const updated = h.store.upsertFeature({
      app_session_id: s.id,
      name: 'PainelScreen',
      kind: 'screen',
      summary: 'v2',
      verified_in_preview: true,
    });
    expect(updated.summary).toBe('v2');
    expect(updated.verified_in_preview).toBe(true);
    // Mesmo nome, kind diferente = linha nova.
    h.store.upsertFeature({ app_session_id: s.id, name: 'PainelScreen', kind: 'api' });
    expect(h.store.listFeatures(s.id)).toHaveLength(2);
  });

  it('re-record without summary preserves the previous summary (COALESCE)', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.upsertFeature({ app_session_id: s.id, name: 'PainelScreen', kind: 'screen', summary: 'first' });
    // Re-record only flipping verified — summary omitted must NOT wipe it.
    const again = h.store.upsertFeature({
      app_session_id: s.id,
      name: 'PainelScreen',
      kind: 'screen',
      verified_in_preview: true,
    });
    expect(again.summary).toBe('first');
    expect(again.verified_in_preview).toBe(true);
  });

  it('deleteSession removes children explicitly', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.upsertFeature({ app_session_id: s.id, name: 'X', kind: 'feature' });
    h.store.deleteSession(s.id);
    expect(h.store.getSession(s.id)).toBeNull();
    expect(h.store.listFeatures(s.id)).toEqual([]);
  });

  it('deletes recorded features by kind', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.upsertFeature({ app_session_id: s.id, name: 'PainelScreen', kind: 'screen' });
    h.store.upsertFeature({ app_session_id: s.id, name: 'pedidos', kind: 'api' });
    h.store.upsertFeature({ app_session_id: s.id, name: 'Relatório', kind: 'feature' });

    expect(h.store.deleteFeaturesByKinds(s.id, ['screen', 'api'])).toBe(2);
    expect(h.store.listFeatures(s.id).map((f) => f.kind)).toEqual(['feature']);
  });

  it('tracks spec revisions and applies a proposed evolution as current spec', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.setSpecJson(s.id, '{"v":1,"summary":"v1","screens":[]}');

    const initial = h.store.ensureInitialSpecRevision(s.id);
    expect(initial?.revision_number).toBe(1);
    expect(initial?.status).toBe('approved');

    const evolution = h.store.createEvolution({
      app_session_id: s.id,
      title: 'Adicionar relatorios',
      base_revision_id: initial?.id ?? null,
    });
    const draft = h.store.createSpecRevision({
      app_session_id: s.id,
      status: 'draft',
      title: 'Relatorios',
      spec_json: '{"v":1,"summary":"v2","screens":[]}',
      base_revision_id: initial?.id ?? null,
      impact_json: '{"level":"medium","stage_ids":["design"],"reasons":[]}',
    });
    h.store.updateEvolution(evolution.id, {
      status: 'review',
      proposed_revision_id: draft.id,
      impact_json: draft.impact_json,
    });

    const approved = h.store.approveSpecRevision(s.id, draft.id);

    expect(approved.status).toBe('approved');
    expect(h.store.getSession(s.id)?.spec_json).toBe('{"v":1,"summary":"v2","screens":[]}');
    expect(h.store.getSpecRevision(initial!.id)?.status).toBe('superseded');
    expect(h.store.listEvolutions(s.id)[0]?.proposed_revision_id).toBe(draft.id);
  });

  it('versions architecture drafts against the approved spec revision', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.setSpecJson(s.id, '{"v":1,"summary":"v1"}');
    const spec = h.store.ensureInitialSpecRevision(s.id)!;
    const draft = h.store.saveArchitectureRevision({
      app_session_id: s.id,
      spec_revision_id: spec.id,
      architecture_json: '{"v":1,"summary":"draft"}',
    });
    const updated = h.store.saveArchitectureRevision({
      app_session_id: s.id,
      spec_revision_id: spec.id,
      architecture_json: '{"v":1,"summary":"refined"}',
    });
    expect(updated.id).toBe(draft.id);
    expect(updated.architecture_json).toContain('refined');
    expect(h.store.approveArchitectureRevision(s.id, updated.id).status).toBe('approved');
    expect(h.store.getLatestApprovedArchitectureRevision(s.id)?.id).toBe(updated.id);
  });

  it('applies and safely undoes a pipeline repair with optimistic concurrency', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    const before = '{"v":2,"stages":[],"roadmap":[]}';
    const after = '{"v":2,"stages":[{"id":"discovery"}],"roadmap":[]}';
    h.store.setPipelineJson(s.id, before);
    const applied = h.store.applyPipelineRepair({
      app_session_id: s.id,
      before_pipeline_json: before,
      after_pipeline_json: after,
      report_json: '{"changed":true}',
    });
    expect(applied.repair.undone_at).toBeNull();
    expect(h.store.getSession(s.id)?.pipeline_json).toBe(after);
    const undone = h.store.undoPipelineRepair(s.id, applied.repair.id);
    expect(undone.repair.undone_at).toBeTruthy();
    expect(h.store.getSession(s.id)?.pipeline_json).toBe(before);
  });
});
