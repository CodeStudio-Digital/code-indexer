import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CodeIndexDB } from '@mcp/store/db.js';
import { AgentMemoryService } from '@mcp/services/memory/agent-memory-service.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { importLegacyMemories } from '@mcp/services/memory/legacy-memory-import.js';
import { validatePreservedMemoryReferences } from '@mcp/store/db/preserved-memory-references.js';
import type { ServerDeps } from '../../deps.js';
import { mountAgentMemoryRoutes } from '../agent-memory.js';
import { mountSnapshotsRoutes } from '../snapshots.js';

describe('active memory curation and preserved legacy import', () => {
  let root: string; let db: CodeIndexDB; let service: AgentMemoryService; let app: Hono; let projectId: number;
  let ordinal = 0;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'memory-curation-')); db = new CodeIndexDB(join(root, 'index.db')); });
  afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => {
    projectId = db.createProject(`curation-${++ordinal}`, join(root, `project-${ordinal}`)).id;
    service = new AgentMemoryService(db); app = new Hono();
    const deps = { db, agentMemoryService: service, snapshotService: new SnapshotService(db) } as unknown as ServerDeps;
    mountAgentMemoryRoutes(app, deps); mountSnapshotsRoutes(app, deps);
  });
  const jsonRequest = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('creates in the live store and recalls it without a provider or legacy write', async () => {
    const embed = vi.spyOn(service, 'embedAndUpsert');
    const response = await app.request(`/api/projects/${projectId}/agent-memory`, jsonRequest('POST', {
      name: 'synthetic build recipe', type: 'procedure', content: 'Use syntheticcompiler for deterministic builds.',
    }));
    const saved = await response.json() as { id: number };
    expect(response.status).toBe(201);
    expect(db.listAgentMemoryIndex('project', projectId).some(row => row.id === saved.id)).toBe(true);
    expect((await service.search('project', projectId, 'syntheticcompiler', 5)).some(row => row.id === saved.id)).toBe(true);
    expect(db.countSnapshots(projectId)).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('returns bounded excerpts and page counts rather than hydrating the full live/archive stock', async () => {
    for (let index = 0; index < 61; index++) db.createAgentMemory({ projectId, name: `note-${index}`, content: 'x'.repeat(2000), type: 'note' });
    const archived = db.createAgentMemory({ projectId, name: 'archived-only', content: 'old' });
    db.archiveAgentMemory(archived.id);
    const first = await (await app.request(`/api/projects/${projectId}/agent-memory?limit=40&offset=0`)).json();
    const second = await (await app.request(`/api/projects/${projectId}/agent-memory?limit=40&offset=40`)).json();
    expect(first).toMatchObject({ total: 61, nextOffset: 40, totals: { total: 61, archived: 1 } });
    expect(first.items).toHaveLength(40); expect(second.items).toHaveLength(21); expect(second.nextOffset).toBeNull();
    expect(first.items[0]).not.toHaveProperty('content'); expect(first.items[0].excerpt).toHaveLength(360);
    const old = await (await app.request(`/api/projects/${projectId}/agent-memory?limit=40&archived=true`)).json();
    expect(old.items.map((row: { id: number }) => row.id)).toEqual([archived.id]);
  });

  it('includes local memories only from the same project in curation and health', async () => {
    const otherProject = db.createProject(`local-other-${ordinal}`, join(root, 'local-other')).id;
    const own = db.createAgentMemory({ scope: 'local', projectId, name: 'local preference', content: 'same project' });
    db.createAgentMemory({ scope: 'project', projectId, name: 'project preference', content: 'same project' });
    db.createAgentMemory({ scope: 'local', projectId: otherProject, name: 'foreign local', content: 'different project' });
    const page = await (await app.request(`/api/projects/${projectId}/agent-memory?limit=40`)).json();
    expect(page.total).toBe(2); expect(page.items).toContainEqual(expect.objectContaining({ id: own.id, scope: 'local' }));
    const health = await (await app.request(`/api/projects/${projectId}/memory/health`)).json();
    expect(health.totals.total).toBe(2);
  });

  it('health counts active memory instead of the unrelated legacy table', async () => {
    db.createAgentMemory({ projectId, name: 'active memory', content: 'current', type: 'gotcha' });
    for (let index = 0; index < 3; index++) db.createSnapshot(projectId, { title: `old-${index}`, category: 'note', content: 'legacy' });
    const result = await (await app.request(`/api/projects/${projectId}/memory/health`)).json();
    expect(result).toMatchObject({ store: 'agent_memory', totals: { total: 1, byCategory: { gotcha: 1 } } });
  });

  it('edits immutably, preserves historical refs, and rejects edits of superseded versions', async () => {
    const original = service.create({ projectId, name: 'recipe', content: 'old',
      referencedFileSnapshots: [{ path: 'src/a.ts', hash: 'historical-hash' }] });
    const response = await app.request(`/api/agent-memory/${original.id}`, jsonRequest('PUT', { content: 'corrected' }));
    const saved = await response.json();
    expect(response.status).toBe(200); expect(saved.id).not.toBe(original.id);
    expect(JSON.parse(saved.referenced_files)).toEqual([{ path: 'src/a.ts', hash: 'historical-hash' }]);
    expect(db.getAgentMemoryById(original.id)?.superseded_by_id).toBe(saved.id);
    expect((await app.request(`/api/agent-memory/${original.id}`, jsonRequest('PUT', { content: 'stale edit' }))).status).toBe(409);
    expect((await app.request(`/api/agent-memory/${saved.id}/importance`, jsonRequest('PUT', { importance: 0.95 }))).status).toBe(200);
    expect(db.getAgentMemoryById(saved.id)?.importance).toBe(0.95);
  });

  it('archives/restores live notes reversibly without invoking the embedding provider', async () => {
    const row = service.create({ projectId, name: 'reversible note', content: 'keep' });
    const embed = vi.spyOn(service, 'embedAndUpsert');
    expect((await app.request(`/api/agent-memory/${row.id}/archive`, jsonRequest('POST', {}))).status).toBe(200);
    expect(db.getAgentMemoryById(row.id)?.archived_at).not.toBeNull();
    expect((await app.request(`/api/agent-memory/${row.id}/restore`, jsonRequest('POST', {}))).status).toBe(200);
    expect(db.getAgentMemoryById(row.id)).toMatchObject({ archived_at: null, source: 'manual' }); expect(embed).not.toHaveBeenCalled();
  });

  it('imports manual/index notes once, preserving originals, versions, tags, file hashes and category provenance', async () => {
    const snapshot = db.createSnapshot(projectId, { title: 'manual gotcha', category: 'gotcha', content: 'original', tags: ['reviewed'], source: 'manual' });
    db.updateSnapshot(snapshot.id, { content: 'current', tags: ['reviewed', 'durable'] });
    db.raw().prepare('INSERT INTO snapshot_files (snapshot_id, file_path, file_hash_at_creation) VALUES (?, ?, ?)').run(snapshot.id, 'src/a.ts', 'old-hash');
    const before = { row: db.getSnapshotById(snapshot.id), versions: db.getSnapshotHistory(snapshot.id),
      refs: db.raw().prepare('SELECT * FROM snapshot_files WHERE snapshot_id = ?').all(snapshot.id) };
    const [first, repeat] = await Promise.all([importLegacyMemories(db, service, projectId, [snapshot.id]), importLegacyMemories(db, service, projectId, [snapshot.id])]);
    expect(first.imported + repeat.imported).toBe(1);
    const imported = db.findAgentMemoryBySourceSnapshot(snapshot.id)!;
    expect(imported).toMatchObject({ type: 'gotcha', content: 'current', source_snapshot_id: snapshot.id });
    expect(JSON.parse(imported.referenced_files!)).toEqual([{ path: 'src/a.ts', hash: 'old-hash' }]);
    expect({ row: db.getSnapshotById(snapshot.id), versions: db.getSnapshotHistory(snapshot.id), refs: db.raw().prepare('SELECT * FROM snapshot_files WHERE snapshot_id = ?').all(snapshot.id) }).toEqual(before);
    await app.request(`/api/agent-memory/${imported.id}`, jsonRequest('PUT', { content: 'human correction' }));
    expect((await importLegacyMemories(db, service, projectId, [snapshot.id])).imported).toBe(0);
    const detail = await (await app.request(`/api/projects/${projectId}/agent-memory/legacy/${snapshot.id}`)).json();
    expect(detail.history).toHaveLength(1); expect(detail.tags).toBe('["reviewed","durable"]');
    const page = await (await app.request(`/api/projects/${projectId}/agent-memory/legacy`)).json();
    expect(page).toMatchObject({ total: 1, imported: 1 });
  });

  it('never imports a note from another project or resurrects archived notes', async () => {
    const other = db.createProject(`other-${ordinal}`, join(root, 'other')).id;
    const foreign = db.createSnapshot(other, { title: 'foreign', category: 'note', content: 'private' });
    const archived = db.createSnapshot(projectId, { title: 'archived', category: 'note', content: 'old' });
    db.raw().prepare('UPDATE snapshots SET archived_at = datetime(\'now\') WHERE id = ?').run(archived.id);
    expect((await importLegacyMemories(db, service, projectId, [foreign.id, archived.id])).skipped).toBe(2);
    expect((await app.request(`/api/projects/${projectId}/agent-memory/legacy/${foreign.id}`)).status).toBe(404);
  });

  it('rejects invalid curation and unsafe historical paths; global memory never inherits project refs', async () => {
    expect((await app.request(`/api/projects/${projectId}/agent-memory`, jsonRequest('POST', { name: 'x', type: 'invalid', content: 'x' }))).status).toBe(400);
    expect(() => validatePreservedMemoryReferences([{ path: '../outside', hash: 'abc' }])).toThrow();
    const global = service.create({ scope: 'user', projectId, name: `global-${ordinal}`, content: 'preference',
      referencedFileSnapshots: [{ path: 'src/a.ts', hash: 'old' }] });
    expect(global.project_id).toBe(0); expect(global.referenced_files).toBeNull();
  });

  it('does not leave a committed note behind if its atomic curation record fails', async () => {
    const events = vi.spyOn(db, 'recordAgentMemoryEvent').mockImplementationOnce(() => { throw new Error('synthetic telemetry failure'); });
    app.onError((_error, c) => c.json({ error: 'synthetic failure' }, 500));
    const failed = await app.request(`/api/projects/${projectId}/agent-memory`, jsonRequest('POST', {
      name: 'atomic curation', type: 'note', content: 'must not be half committed',
    }));
    expect(failed.status).toBe(500);
    expect(db.listAgentMemoryLive('project', projectId)).toHaveLength(0);
    events.mockRestore();
  });
});
