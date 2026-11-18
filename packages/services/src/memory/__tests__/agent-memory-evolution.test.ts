import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { AgentMemoryService } from '../agent-memory-service.js';
import { AgentMemoryEvolution } from '../agent-memory-evolution.js';
import { applyMemoryEvolution } from '../evolution-apply.js';
import { parseEvolutionPlan, memoryRevision, type MemoryEvolutionPlan } from '../evolution-plan.js';

describe('durable memory evolution with real SQLite', () => {
  let root: string, db: CodeIndexDB, service: AgentMemoryService, projectId: number;
  let ordinal = 0;
  const key = () => ({ scope: 'project' as const, projectId });
  const create = (name: string, content = `${name} learned fact`, extra: Record<string, unknown> = {}) =>
    service.create({ scope: 'project', projectId, name, content, source: 'session', type: 'procedure', importance: 0.7, ...extra });
  const make = (propose: (rows: any[], signal: AbortSignal) => Promise<MemoryEvolutionPlan>, now = () => Date.now()) =>
    new AgentMemoryEvolution({ db, service, distill: { resolver: {} as any }, isConfigured: async () => true, enabled: () => true, propose, now });
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'memory-evolution-')); db = new CodeIndexDB(join(root, 'index.db')); });
  afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => {
    db.raw().prepare('UPDATE projects SET memory_enabled=0 WHERE id<>0').run();
    projectId = db.createProject(`evolution-${++ordinal}`, join(root, `project-${ordinal}`)).id;
    service = new AgentMemoryService(db);
  });

  it('consolidates immutably, preserving file baselines, access counts and lineage; never feeds its own output back', async () => {
    const a = create('test recipe', 'Run unit tests with fixture mode.', { referencedFileSnapshots: [{ path: 'a.ts', hash: 'old-a' }] });
    const b = create('test recipe duplicate', 'Use fixture mode when running unit tests.', { referencedFileSnapshots: [{ path: 'b.ts', hash: 'old-b' }] });
    db.raw().prepare('UPDATE agent_memory SET access_count=3 WHERE id=?').run(a.id);
    const propose = vi.fn(async () => ({ operations: [{ kind: 'merge' as const, ids: [a.id, b.id], name: 'Unit test recipe', content: 'Run unit tests with fixture mode.', reason: 'Same verified procedure' }] }));
    const engine = make(propose);
    await engine.runOnce(key());
    const live = db.listAgentMemoryForSemanticIndex('project', projectId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ source: 'consolidation', access_count: 3, importance: 0.7 });
    expect(JSON.parse(live[0]!.referenced_files!)).toEqual([{ path: 'a.ts', hash: 'old-a' }, { path: 'b.ts', hash: 'old-b' }]);
    expect(db.getAgentMemoryById(a.id)).toMatchObject({ content: a.content, superseded_by_id: live[0]!.id });
    expect(db.getAgentMemoryById(b.id)!.archived_reason).toContain('evolution:merge:');
    expect(engine.status(key())).toMatchObject({ pending: 0, running: false, lastResult: { merged: 1, reviewed: 2 } });
    await engine.runOnce(key());
    expect(propose).toHaveBeenCalledOnce();
    expect(new AgentMemoryEvolution({ db, service, distill: { resolver: {} as any }, isConfigured: async () => true }).store.status(key()).pending).toBe(0);
  });

  it.each([{ source: 'manual' }, { importance: 0.95 }, { type: 'preference' }, { type: 'external_pointer' }])('protects human/pinned memory %j', async extra => {
    const a = create('protected', 'Explicit human rule', extra);
    const b = create('ordinary');
    const plan: MemoryEvolutionPlan = { operations: [{ kind: 'merge', ids: [a.id, b.id], name: 'bad merge', content: 'Changed', reason: 'bad suggestion' }] };
    const result = db.transaction(() => applyMemoryEvolution(db, service, key(), [a, b], plan));
    expect(result.rejected).toBe(1);
    expect(db.getAgentMemoryById(a.id)).toMatchObject({ archived_at: null, content: a.content });
    expect(db.getAgentMemoryById(b.id)!.archived_at).toBeNull();
  });

  it('rejects edits made after the model read the memories and rejects IDs outside its scope or evidence set', () => {
    const a = create('old'); const b = create('second');
    const foreign = service.create({ scope: 'user', projectId: 0, name: `foreign-${ordinal}`, content: 'global', type: 'procedure', source: 'session' });
    db.setAgentMemoryImportance(a.id, 0.8);
    const operations: MemoryEvolutionPlan['operations'] = [a.id, b.id, foreign.id].map(id => ({ kind: 'refine', ids: [id], name: 'changed', content: 'new', reason: 'unsafe' }));
    const result = db.transaction(() => applyMemoryEvolution(db, service, key(), [a, foreign], { operations }));
    expect(result.rejected).toBe(3);
    expect(db.getAgentMemoryById(a.id)!.content).toBe(a.content);
    service.archive(foreign.id);
  });

  it('ignores access telemetry when comparing content revisions', () => {
    const row = create('accessed');
    expect(memoryRevision(row)).toBe(memoryRevision({ ...row, access_count: 52, last_accessed_at: 'later' }));
    expect(memoryRevision(row)).not.toBe(memoryRevision({ ...row, content: 'edited' }));
  });

  it('requires a literal quote from a newer correction before archiving an older fact', () => {
    const a = create('old test procedure', 'Use Node 18 for tests.');
    const b = create('correction', 'Correction: Node 22 replaces Node 18 for tests.', { source: 'manual' });
    const plan: MemoryEvolutionPlan = { operations: [{ kind: 'supersede', ids: [a.id], keepId: b.id, evidenceQuote: 'invented correction', reason: 'new procedure' }] };
    expect(db.transaction(() => applyMemoryEvolution(db, service, key(), [a, b], plan)).rejected).toBe(1);
    plan.operations[0]!.evidenceQuote = b.content;
    expect(db.transaction(() => applyMemoryEvolution(db, service, key(), [a, b], plan)).retired).toBe(1);
    expect(db.getAgentMemoryById(a.id)!.superseded_by_id).toBe(b.id);
    expect(db.getAgentMemoryById(b.id)!.archived_at).toBeNull();
  });

  it('rolls back all mutations and the cursor when saving the new version fails', async () => {
    const a = create('first'), b = create('second');
    const engine = make(async () => ({ operations: [{ kind: 'merge', ids: [a.id, b.id], name: 'new', content: 'fact', reason: 'compatible' }] }));
    const spy = vi.spyOn(service, 'create').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
    await engine.runOnce(key()); spy.mockRestore();
    expect(db.getAgentMemoryById(a.id)!.archived_at).toBeNull();
    expect(db.getAgentMemoryById(b.id)!.archived_at).toBeNull();
    expect(engine.status(key())).toMatchObject({ pending: 2, errorCode: 'storage_busy', lastAt: null, running: false });
  });

  it('retains the cursor on malformed output, backs off across restarts, then retries', async () => {
    create('retryable'); let now = 100_000;
    const propose = vi.fn(async () => parseEvolutionPlan('invalid JSON'));
    const engine = make(propose, () => now);
    await engine.runOnce(key());
    expect(engine.status(key())).toMatchObject({ pending: 1, errorCode: 'invalid_response', nextAt: 400_000 });
    await engine.runOnce(); expect(propose).toHaveBeenCalledOnce();
    now = 400_001;
    propose.mockResolvedValueOnce({ operations: [] });
    await engine.runOnce(key());
    expect(engine.status(key())).toMatchObject({ pending: 0, errorCode: null });
  });

  it('coalesces concurrent runs and a second owner cannot claim the active review', async () => {
    create('coalesced'); let finish!: (plan: MemoryEvolutionPlan) => void;
    const propose = vi.fn(() => new Promise<MemoryEvolutionPlan>(resolve => { finish = resolve; }));
    const engine = make(propose), second = make(propose);
    const pending = engine.runOnce(key());
    await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce());
    await Promise.all([engine.runOnce(key()), second.runOnce(key())]);
    expect(propose).toHaveBeenCalledOnce();
    finish({ operations: [] }); await pending;
  });

  it('does not apply late model output after shutdown', async () => {
    const row = create('original'); let finish!: (plan: MemoryEvolutionPlan) => void;
    const engine = make(() => new Promise(resolve => { finish = resolve; }));
    const pending = engine.runOnce(key());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const stopped = engine.stop();
    finish({ operations: [{ kind: 'refine', ids: [row.id], name: 'late', content: 'changed', reason: 'late result' }] });
    await Promise.all([pending, stopped]);
    expect(db.getAgentMemoryById(row.id)).toMatchObject({ archived_at: null, content: row.content });
    expect(engine.store.status(key()).pending).toBe(1);
  });

  it('respects disabled projects and refuses a changed pin while the model is working', async () => {
    const row = create('project rule');
    const propose = vi.fn(async () => {
      db.setAgentMemoryImportance(row.id, 0.95);
      return { operations: [{ kind: 'refine' as const, ids: [row.id], name: 'changed', content: 'new', reason: 'old read' }] };
    });
    const engine = make(propose);
    db.setProjectMemoryEnabled(projectId, false);
    await engine.runOnce(key()); expect(propose).not.toHaveBeenCalled();
    db.setProjectMemoryEnabled(projectId, true);
    await engine.runOnce(key());
    expect(engine.status(key()).lastResult).toMatchObject({ rejected: 1, refined: 0 });
    expect(db.getAgentMemoryById(row.id)!.archived_at).toBeNull();
  });

  it('uses new manual corrections as evidence without changing the manual memory', async () => {
    const old = create('Node test runtime', 'Node 18 is required for tests.');
    const engine = make(async () => ({ operations: [] }));
    await engine.runOnce(key());
    const correction = create('Node test runtime correction', 'Correction: Node 22 replaces Node 18 for tests.', { source: 'manual' });
    const next = make(async rows => {
      expect(rows.map(row => row.id)).toContain(old.id);
      return { operations: [{ kind: 'supersede', ids: [old.id], keepId: correction.id, evidenceQuote: correction.content, reason: 'Explicit human correction' }] };
    });
    await next.runOnce(key());
    expect(db.getAgentMemoryById(old.id)!.superseded_by_id).toBe(correction.id);
    expect(db.getAgentMemoryById(correction.id)!.archived_at).toBeNull();
  });

  it('rejects malformed, unbounded and empty-ID model proposals', () => {
    expect(() => parseEvolutionPlan('{"operations":[{"kind":"erase","ids":[1]}]}')).toThrow();
    expect(() => parseEvolutionPlan('{"operations":[{"kind":"refine","ids":[],"reason":"x"}]}')).toThrow();
    expect(parseEvolutionPlan('```json\n{"operations":[]}\n```')).toEqual({ operations: [] });
  });

  it('queues a manual review of another project while a background review is in flight', async () => {
    create('first project');
    const otherId = db.createProject(`queued-${ordinal}`, join(root, `queued-${ordinal}`)).id;
    service.create({ projectId: otherId, name: 'second project', content: 'Other scoped fact', source: 'session', importance: 0.7 });
    let finish!: (plan: MemoryEvolutionPlan) => void;
    const propose = vi.fn<(_: any[], signal: AbortSignal) => Promise<MemoryEvolutionPlan>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ operations: [] });
    const engine = make(propose);
    const active = engine.runOnce(key());
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const other = { scope: 'project' as const, projectId: otherId };
    await engine.runOnce(other);
    expect(engine.status(other).queued).toBe(true);
    finish({ operations: [] }); await active;
    await vi.waitFor(() => expect(engine.status(other)).toMatchObject({ pending: 0, queued: false, running: false }));
    expect(propose).toHaveBeenCalledTimes(2);
  });

  it('legacy hygiene preserves manual/pinned memories, code case and reference provenance', () => {
    const manual = create('manual cold', 'CaseSensitiveAPI', { type: 'note', source: 'manual', importance: 0.1 });
    const pin = create('pin', 'CaseSensitiveAPI', { importance: 0.95 });
    const upper = create('upper', 'CaseSensitiveAPI');
    const lower = create('lower', 'casesensitiveapi');
    const ref = create('other evidence', 'CaseSensitiveAPI', { referencedFileSnapshots: [{ path: 'different.ts', hash: 'historical' }] });
    db.raw().prepare("UPDATE agent_memory SET created_at=datetime('now','-100 days') WHERE id=?").run(manual.id);
    expect(db.consolidateAgentMemory('project', projectId).archived).toBe(0);
    expect(db.decayColdAgentMemoryNotes('project', projectId)).toBe(0);
    for (const row of [manual, pin, upper, lower, ref]) expect(db.getAgentMemoryById(row.id)!.archived_at).toBeNull();
  });
});
