/**
 * Agent Memory store (migration 181) — dedicated durable memory, separate from
 * snapshots. Pins the invariants the rest of the system relies on:
 *   - migration creates the table + FTS + partial unique index;
 *   - the partial unique index allows archive + recreate-same-name;
 *   - `replace` is transactional (archive old + create new + supersede link);
 *   - FTS search is scoped by scope/project and excludes archived rows;
 *   - local scope can never sync;
 *   - source-snapshot idempotency lookups work (migration script relies on it);
 *   - events table records + prunes.
 *
 * Requires the Node-ABI better-sqlite3 build (`pnpm node:rebuild`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../../db.js';

describe('agent_memory store (migration 181)', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-agent-mem-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migration creates the table, fts index and is at version >= 181', () => {
    expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(181);
    const raw = db.raw();
    const tbl = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_memory'`).get();
    expect(tbl).toBeTruthy();
    const fts = raw.prepare(`SELECT name FROM sqlite_master WHERE name='agent_memory_fts'`).get();
    expect(fts).toBeTruthy();
  });

  it('creates a memory and slugifies the name', () => {
    const m = db.createAgentMemory({
      scope: 'project',
      projectId,
      name: 'Prefers Bun over npm',
      description: 'tooling preference',
      type: 'preference',
      content: 'The user prefers Bun over npm for this repo.',
    });
    expect(m.name).toBe('prefers-bun-over-npm');
    expect(m.scope).toBe('project');
    expect(m.project_id).toBe(projectId);
    expect(m.archived_at).toBeNull();
  });

  it('ranks by recency and source before limiting index candidates', () => {
    db.raw().transaction(() => {
      for (let i = 0; i < 101; i++) {
        const old = db.createAgentMemory({ projectId, name: `ancient ${i}`, content: 'old', importance: 1, source: 'session' });
        db.raw().prepare("UPDATE agent_memory SET created_at='2000-01-01 00:00:00' WHERE id=?").run(old.id);
      }
    })();
    const fresh = db.createAgentMemory({ projectId, name: 'current user convention', content: 'current', source: 'user', importance: 0.5 });
    expect(db.listAgentMemoryIndex('project', projectId, 1)[0]?.id).toBe(fresh.id);
  });
  it('keeps human-curated memories at explicit intent priority after editing', () => {
    const agent = db.createAgentMemory({ projectId, name: 'agent suggestion', content: 'suggestion', source: 'agent' });
    const manual = db.createAgentMemory({ projectId, name: 'human constraint', content: 'constraint', source: 'manual' });
    expect(db.listAgentMemoryIndex('project', projectId, 2).map(row => row.id)).toEqual([manual.id, agent.id]);
  });

  it('partial unique index allows archive + recreate same name', () => {
    const a = db.createAgentMemory({ projectId, name: 'auth flow', content: 'v1' });
    db.archiveAgentMemory(a.id, 'test');
    // recreate with the SAME slug — must succeed because the old row is archived
    const b = db.createAgentMemory({ projectId, name: 'auth flow', content: 'v2' });
    expect(b.name).toBe('auth-flow');
    expect(b.id).not.toBe(a.id);
  });

  it('a live name collision gets a -2 suffix', () => {
    const a = db.createAgentMemory({ projectId, name: 'auth flow', content: 'v1' });
    const b = db.createAgentMemory({ projectId, name: 'auth flow', content: 'other live fact' });
    expect(a.name).toBe('auth-flow');
    expect(b.name).toBe('auth-flow-2');
  });

  it('replace archives the old row, links supersede, and keeps earliest created_at', () => {
    const a = db.createAgentMemory({ projectId, name: 'build cmd', content: 'old' });
    const b = db.replaceAgentMemory(a.id, { projectId, name: 'build cmd', content: 'new' });
    const oldRow = db.getAgentMemoryById(a.id)!;
    expect(oldRow.archived_at).not.toBeNull();
    expect(oldRow.superseded_by_id).toBe(b.id);
    expect(b.archived_at).toBeNull();
    expect(b.created_at).toBe(a.created_at); // earliest provenance preserved
    // only ONE live row for the name
    const live = db.getAgentMemoryByName('project', projectId, 'build cmd')!;
    expect(live.id).toBe(b.id);
  });

  it('FTS search is scoped and excludes archived rows', () => {
    db.createAgentMemory({ projectId, name: 'registry gotcha', content: 'registry needs a token refresh' });
    const other = db.createProject('q', join(dir, 'q')).id;
    db.createAgentMemory({ projectId: other, name: 'unrelated', content: 'registry token elsewhere' });

    const hits = db.searchAgentMemoryFts('project', projectId, 'registry token', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].project_id).toBe(projectId);

    db.archiveAgentMemory(hits[0].id, 'test');
    const after = db.searchAgentMemoryFts('project', projectId, 'registry token', 10);
    expect(after.length).toBe(0);
  });

  it('local scope can never sync', () => {
    const m = db.createAgentMemory({ scope: 'local', projectId, name: 'machine path', content: 'C:/x', sync: true });
    expect(m.sync).toBe(0);
  });

  it('counts project/local curation stock while retrieval keeps its exact scope', () => {
    const project = db.createAgentMemory({ scope: 'project', projectId, name: 'project preference', content: 'project', type: 'preference' });
    const local = db.createAgentMemory({ scope: 'local', projectId, name: 'local preference', content: 'local', type: 'preference' });
    const user = db.createAgentMemory({ scope: 'user', projectId, name: 'user preference', content: 'user', type: 'preference' });
    const other = db.createProject('other', join(dir, 'other')).id;
    for (const scope of ['project', 'local'] as const) {
      db.createAgentMemory({ scope, projectId: other, name: `${scope} elsewhere`, content: 'other', type: 'preference' });
      const archived = db.createAgentMemory({ scope, projectId, name: `${scope} archived`, content: 'old', type: 'preference' });
      db.archiveAgentMemory(archived.id, 'test');
    }
    db.bumpAgentMemoryAccess([local.id]);

    expect(db.getAgentMemoryStats(projectId)).toMatchObject({ liveProject: 2, liveUser: 1 });
    expect(db.getAgentMemoryStats()).toMatchObject({ liveProject: 4, liveUser: 1 });
    expect(db.getMemoryEffectivenessKpis(projectId, {
      windowDays: 30, sessionsInWindow: 0, learnedSessions: 0, explicitCalls: {},
    })).toMatchObject({ liveStock: 2, usageCoverage: 0.5, goldStock: 3 });
    expect(db.listAgentMemoryIndex('project', projectId).map(row => row.id)).toEqual([project.id]);
    expect(db.listAgentMemoryIndex('local', projectId).map(row => row.id)).toEqual([local.id]);
    expect(db.listAgentMemoryIndex('user', projectId).map(row => row.id)).toEqual([user.id]);
  });

  it('user scope normalizes to project 0', () => {
    const m = db.createAgentMemory({ scope: 'user', projectId, name: 'prefers ptbr', content: 'PT-BR' });
    expect(m.project_id).toBe(0);
    expect(db.getAgentMemoryByName('user', 0, 'prefers ptbr')!.id).toBe(m.id);
  });

  it('bumpAccess increments the usage counter', () => {
    const m = db.createAgentMemory({ projectId, name: 'x', content: 'y' });
    db.bumpAgentMemoryAccess([m.id]);
    db.bumpAgentMemoryAccess([m.id]);
    expect(db.getAgentMemoryById(m.id)!.access_count).toBe(2);
  });

  it('source-snapshot lookup powers migration idempotency', () => {
    const m = db.createAgentMemory({ projectId, name: 'migrated', content: 'from snap', sourceSnapshotId: 42 });
    expect(db.findAgentMemoryBySourceSnapshot(42)!.id).toBe(m.id);
    expect(db.findAgentMemoryBySourceSnapshot(99)).toBeUndefined();
  });

  it('list index returns logical frontmatter ranked by importance', () => {
    db.createAgentMemory({ projectId, name: 'low', content: 'a', importance: 0.2 });
    db.createAgentMemory({ projectId, name: 'high', content: 'b', importance: 0.9, type: 'decision', description: 'big call' });
    const idx = db.listAgentMemoryIndex('project', projectId, 12);
    expect(idx[0].name).toBe('high');
    expect(idx[0].type).toBe('decision');
    expect(idx[0].description).toBe('big call');
    expect(idx[0].source).toBe('agent');
  });

  it('prefers explicit memory and removes near-duplicate auto-distilled titles', () => {
    db.createAgentMemory({
      projectId,
      name: 'optimistic mutation persistence disconnect',
      content: 'Automatic guess',
      importance: 0.9,
      type: 'gotcha',
      source: 'session',
    });
    db.createAgentMemory({
      projectId,
      name: 'optimistic mutation state disconnect',
      content: 'Canonical decision',
      importance: 0.7,
      type: 'gotcha',
      source: 'agent',
    });

    const idx = db.listAgentMemoryIndex('project', projectId, 12);
    const related = idx.filter((entry) => entry.name.startsWith('optimistic-mutation'));
    expect(related).toHaveLength(1);
    expect(related[0].name).toBe('optimistic-mutation-state-disconnect');
    expect(related[0].source).toBe('agent');
  });
  it('preserves distinct explicit memories even when their titles have shared words', () => {
    db.createAgentMemory({ projectId, name: 'bounded-memory-fixture', content: 'Bound reads', source: 'agent' });
    db.createAgentMemory({ projectId, name: 'temporary-memory-fixture', content: 'Archive obsolete facts', source: 'agent' });
    const index = db.listAgentMemoryIndex('project', projectId, 12);
    expect(index.map(row => row.name).sort()).toEqual(['bounded-memory-fixture', 'temporary-memory-fixture']);
  });

  it('preflights deterministic hygiene and returns false again after consolidation', () => {
    expect(db.hasAgentMemoryHygieneCandidates('project', projectId)).toBe(false);
    db.createAgentMemory({ projectId, name: 'first', content: 'Use   SQLite WAL' });
    db.createAgentMemory({ projectId, name: 'second', content: ' use sqlite wal ' });

    expect(db.hasAgentMemoryHygieneCandidates('project', projectId)).toBe(true);
    expect(db.consolidateAgentMemory('project', projectId).archived).toBe(1);
    expect(db.hasAgentMemoryHygieneCandidates('project', projectId)).toBe(false);
  });

  it('records and prunes telemetry events', () => {
    db.recordAgentMemoryEvent({ eventType: 'remember', scope: 'project', projectId, memoryId: 1 });
    db.recordAgentMemoryEvent({ eventType: 'recall', scope: 'project', projectId, kept: 2, dropped: 3 });
    const raw = db.raw();
    const count = raw.prepare('SELECT COUNT(*) AS c FROM agent_memory_events').get() as { c: number };
    expect(count.c).toBe(2);
    // prune with an absurdly small cap keeps only the newest row
    const removed = db.pruneAgentMemoryEvents(0, 1);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});
