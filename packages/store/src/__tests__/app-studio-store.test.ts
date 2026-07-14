/** Invariantes persistentes da jornada App Studio e do workflow v5. */
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
    h.store.setWorkflowStateJson(s.id, '{"v":1,"stages":[]}');
    const updated = h.store.setDeployJson(s.id, '{"url":null}');
    expect(updated.spec_json).toBe('{"v":1}');
    expect(updated.pipeline_json).toBe('{"v":1,"stages":[]}');
    expect(updated.deploy_json).toBe('{"url":null}');
  });

  it('deleteSession removes children explicitly', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.upsertWorkItems([{ id: 'x', app_session_id: s.id, phase: 'define', title: 'X', kind: 'plan' }]);
    h.store.deleteSession(s.id);
    expect(h.store.getSession(s.id)).toBeNull();
    expect(h.store.listWorkItems(s.id)).toEqual([]);
  });

  it('isolates stable work item ids between app sessions', () => {
    const first = h.store.createSession({ project_id: h.projectId, name: 'First', app_slug: 'first' });
    const project = h.db.raw().prepare("INSERT INTO projects (name, root_path) VALUES ('second-app', ?)").run(join(h.dir, 'second-ws'));
    const second = h.store.createSession({ project_id: Number(project.lastInsertRowid), name: 'Second', app_slug: 'second' });
    const shared = (sessionId: number, title: string) => ({
      id: 'slice:orders', app_session_id: sessionId, phase: 'build' as const,
      title, outcome: title, kind: 'implement' as const,
    });
    h.store.upsertWorkItems([shared(first.id, 'First orders'), shared(second.id, 'Second orders')]);
    expect(h.store.getWorkItem(first.id, 'slice:orders')?.title).toBe('First orders');
    expect(h.store.getWorkItem(second.id, 'slice:orders')?.title).toBe('Second orders');
  });

  it('releases verifier cards from review dependencies without reviving stale work', () => {
    const session = h.store.createSession({ project_id: h.projectId, name: 'App', app_slug: 'app' });
    h.store.upsertWorkItems([
      { id: 'implement', app_session_id: session.id, phase: 'build', title: 'Implement', kind: 'implement', status: 'review', owner_profile: 'ui' },
      { id: 'verify', app_session_id: session.id, phase: 'build', title: 'Verify', kind: 'verify', status: 'backlog', owner_profile: 'verify', depends_on_json: '["implement"]' },
      { id: 'stale', app_session_id: session.id, phase: 'build', title: 'Stale', kind: 'implement', status: 'stale', revision: 3 },
    ]);
    h.store.refreshReadyWorkItems(session.id);
    expect(h.store.getWorkItem(session.id, 'verify')?.status).toBe('ready');
    h.store.upsertWorkItems([{ id: 'stale', app_session_id: session.id, phase: 'build', title: 'Refined stale', kind: 'implement', status: 'ready', revision: 1 }]);
    expect(h.store.getWorkItem(session.id, 'stale')).toMatchObject({ status: 'stale', revision: 3, title: 'Refined stale' });
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
      impact_json: '{"level":"medium","affected_phases":["build"],"source_ids":[],"reasons":[]}',
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

  it('supersedes replaced proposals and only reports genuinely pending revisions', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.setSpecJson(s.id, '{"v":1,"summary":"v1"}');
    const initial = h.store.ensureInitialSpecRevision(s.id)!;
    const evolution = h.store.createEvolution({
      app_session_id: s.id,
      title: 'Refinar carreira',
      base_revision_id: initial.id,
    });
    const first = h.store.createSpecRevision({
      app_session_id: s.id,
      status: 'draft',
      title: 'Primeira proposta',
      spec_json: '{"v":1,"summary":"v2"}',
      base_revision_id: initial.id,
    });
    h.store.updateEvolution(evolution.id, { status: 'review', proposed_revision_id: first.id });
    expect(h.store.getPendingSpecRevision(s.id)?.id).toBe(first.id);

    const replacement = h.store.createSpecRevision({
      app_session_id: s.id,
      status: 'draft',
      title: 'Proposta refinada',
      spec_json: '{"v":1,"summary":"v3"}',
      base_revision_id: initial.id,
    });
    h.store.updateEvolution(evolution.id, { status: 'review', proposed_revision_id: replacement.id });

    expect(h.store.getSpecRevision(first.id)?.status).toBe('superseded');
    expect(h.store.getPendingSpecRevision(s.id)?.id).toBe(replacement.id);

    h.store.updateEvolution(evolution.id, { status: 'applied' });
    expect(h.store.getPendingSpecRevision(s.id)).toBeNull();
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
    h.store.approveBlueprintArtifacts(s.id);
    expect(h.store.getLatestApprovedArchitectureRevision(s.id)?.id).toBe(updated.id);
  });

  it('approves product and materializes its spec in one transaction', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    const initialJson = '{"v":1,"summary":"idea","screens":[]}';
    h.store.setSpecJson(s.id, initialJson);
    const initial = h.store.ensureInitialSpecRevision(s.id)!;
    const product = h.store.saveProductRevision({
      app_session_id: s.id,
      base_spec_revision_id: initial.id,
      complexity: 'complex',
      product_json: '{"v":1,"candidate_spec":{"v":1}}',
    });
    const candidate = '{"v":1,"summary":"deep product","screens":[]}';
    const approved = h.store.applyProductRevisionToScope({ sessionId: s.id, revisionId: product.id, candidateSpecJson: candidate, workflowStateJson: '{"v":4}' });
    expect(approved.product.status).toBe('approved');
    expect(approved.product.result_spec_revision_id).toBe(approved.spec.id);
    expect(approved.spec.status).toBe('approved');
    expect(approved.session.spec_json).toBe(candidate);
    expect(approved.session.pipeline_json).toBe('{"v":4}');
    expect(h.store.getSpecRevision(initial.id)?.status).toBe('superseded');
  });

  it('migrates a legacy workflow once and keeps a recovery snapshot', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    const before = '{"v":4,"stages":[]}';
    const after = '{"v":5,"phases":[],"active_revision_refs":{},"release_unlocked":false,"migrated_from":4,"migrated_at":null}';
    h.store.setWorkflowStateJson(s.id, before);
    const input = {
      sessionId: s.id,
      sourceVersion: 4,
      previousStateJson: before,
      workflowJson: after,
      workItems: [],
      approvals: [],
    };
    h.store.applyWorkflowMigration(input);
    h.store.applyWorkflowMigration(input);
    expect(h.store.getSession(s.id)?.pipeline_json).toBe(after);
    expect((h.db.raw().prepare('SELECT COUNT(*) AS count FROM app_studio_workflow_snapshots WHERE app_session_id = ?').get(s.id) as { count: number }).count).toBe(1);
  });

  it('approves Blueprint artifacts as one bundle and tracks work through evidence', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.setSpecJson(s.id, '{"v":2,"summary":"scope"}');
    const spec = h.store.ensureInitialSpecRevision(s.id)!;
    const architecture = h.store.saveArchitectureRevision({
      app_session_id: s.id,
      spec_revision_id: spec.id,
      architecture_json: '{"v":1,"summary":"architecture"}',
    });
    const uxDraft = h.store.saveUxRevision({
      app_session_id: s.id,
      spec_revision_id: spec.id,
      architecture_revision_id: architecture.id,
      data_fingerprint: 'data-v1',
      ux_json: '{"v":1,"summary":"draft"}',
    });
    const uxRefined = h.store.saveUxRevision({
      app_session_id: s.id,
      spec_revision_id: spec.id,
      architecture_revision_id: architecture.id,
      data_fingerprint: 'data-v1',
      ux_json: '{"v":1,"summary":"refined"}',
    });
    expect(uxRefined.id).toBe(uxDraft.id);
    const wireframe = h.store.saveWireframeRevision({
      app_session_id: s.id,
      spec_revision_id: spec.id,
      architecture_revision_id: architecture.id,
      ux_revision_id: uxRefined.id,
      data_fingerprint: 'data-v1',
      wireframe_json: '{"v":1,"summary":"flows"}',
    });
    h.store.approveBlueprintArtifacts(s.id);
    expect(h.store.getLatestApprovedUxRevision(s.id)?.id).toBe(uxRefined.id);
    expect(h.store.getLatestApprovedWireframeRevision(s.id)?.id).toBe(wireframe.id);

    h.store.upsertWorkItems([{
      id: 'slice:core:verify', app_session_id: s.id, phase: 'build', slice_id: 'core',
      title: 'Verify core slice', kind: 'verify', status: 'review',
    }]);
    expect(() => h.store.setWorkItemStatus(s.id, 'slice:core:verify', 'done')).toThrow(/needs evidence/);
    const done = h.store.setWorkItemStatus(s.id, 'slice:core:verify', 'done', {
      evidenceJson: '[{"kind":"test","value":"vitest:pass"}]',
    });
    expect(done.status).toBe('done');
    expect(h.store.listWorkflowEvents(s.id).map((event) => event.kind)).toContain('work_item.status_changed');
  });

  it('resolves approval events idempotently', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    const approval = h.store.requestApproval({ sessionId: s.id, type: 'scope', bundleRevision: 1, bundleJson: '{}', summary: 'Scope ready' });
    const duplicateRequest = h.store.requestApproval({ sessionId: s.id, type: 'scope', bundleRevision: 2, bundleJson: '{}', summary: 'Same bundle, revised wording' });
    expect(duplicateRequest.id).toBe(approval.id);
    expect(h.store.listWorkflowEvents(s.id).filter((event) => event.kind === 'approval.requested')).toHaveLength(1);
    const first = h.store.resolveApproval({ sessionId: s.id, approvalId: approval.id, decision: 'approve', idempotencyKey: 'approval:scope:1' });
    const second = h.store.resolveApproval({ sessionId: s.id, approvalId: approval.id, decision: 'approve', idempotencyKey: 'approval:scope:1' });
    expect(first.status).toBe('approved');
    expect(second.status).toBe('approved');
    expect(h.store.listWorkflowEvents(s.id).filter((event) => event.kind === 'approval.resolved')).toHaveLength(1);
  });

  it('resolves decisions idempotently and refuses a conflicting replay', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    const decision = h.store.createDecisionRequest({ sessionId: s.id, question: 'Which option?' });
    expect(h.store.resolveDecisionRequest(s.id, decision.id, 'A').answer).toBe('A');
    expect(h.store.resolveDecisionRequest(s.id, decision.id, 'A').answer).toBe('A');
    expect(() => h.store.resolveDecisionRequest(s.id, decision.id, 'B')).toThrow(/different answer/);
    expect(h.store.listWorkflowEvents(s.id).filter((event) => event.kind === 'decision.resolved')).toHaveLength(1);
  });

  it('reorders non-started cards and blocks dependents of cancelled work', () => {
    const s = h.store.createSession({ project_id: h.projectId, name: 'A', app_slug: 'a' });
    h.store.upsertWorkItems([
      { id: 'a', app_session_id: s.id, phase: 'build', title: 'A', kind: 'implement', status: 'ready', sort_order: 0 },
      { id: 'b', app_session_id: s.id, phase: 'build', title: 'B', kind: 'implement', status: 'ready', sort_order: 1 },
      { id: 'dependent', app_session_id: s.id, phase: 'build', title: 'Dependent', kind: 'implement', status: 'backlog', depends_on_json: '["a"]' },
    ]);
    h.store.reorderWorkItem(s.id, 'b', 0);
    expect(h.store.listWorkItems(s.id).filter((item) => item.status === 'ready').sort((a, b) => a.sort_order - b.sort_order).map((item) => item.id)).toEqual(['b', 'a']);
    h.store.setWorkItemStatus(s.id, 'a', 'cancelled');
    h.store.refreshReadyWorkItems(s.id);
    expect(h.store.getWorkItem(s.id, 'dependent')).toMatchObject({ status: 'blocked', blocked_reason: "Dependency 'a' was cancelled." });
  });
});
