import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../store/db.js';
import { SnapshotService } from '../core/services/snapshots.js';
import { HybridSearch } from '../core/search/hybrid.js';
import { NullEmbeddingService } from '../core/search/embeddings.js';

describe('get_project_context (semantic mode)', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;
  let svc: SnapshotService;
  let hybrid: HybridSearch;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-snap-ctx-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    const p = db.createProject('p', dir);
    projectId = p.id;
    svc = new SnapshotService(db);
    // FTS-only path — no vector store, no embedding backend. The hybrid
    // search degrades gracefully to keyword ranking, which is enough to
    // verify that get_project_context's flow narrows by query rather than
    // dumping every snapshot.
    hybrid = new HybridSearch(db, null, new NullEmbeddingService());

    await svc.create(projectId, {
      title: 'Caching strategy',
      category: 'architecture',
      content: 'We use Redis as the L2 cache for hot keys.',
    });
    await svc.create(projectId, {
      title: 'Auth flow',
      category: 'decision',
      content: 'OAuth via Auth0 for user accounts.',
    });
    await svc.create(projectId, {
      title: 'Logging conventions',
      category: 'convention',
      content: 'Structured logs, JSON, one event per request.',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('renderGrouped sorts snapshots by category in the canonical order', () => {
    const snaps = db.listSnapshots(projectId);
    const out = SnapshotService.renderGrouped(snaps);
    const archIdx = out.indexOf('Caching strategy');
    const decisionIdx = out.indexOf('Auth flow');
    const conventionIdx = out.indexOf('Logging conventions');
    // architecture < decision < convention
    expect(archIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(archIdx);
    expect(conventionIdx).toBeGreaterThan(decisionIdx);
    expect(out).toContain('## Architectures');
    expect(out).toContain('## Decisions');
    expect(out).toContain('## Conventions');
  });

  it('hybrid snapshot search narrows by query (FTS path)', async () => {
    const ranked = await hybrid.searchSnapshotsHybrid(
      projectId,
      'p',
      'cache redis',
      10,
    );
    // Caching snapshot must be present; the unrelated ones either absent
    // or ranked lower (FTS5 returns only matching rows here).
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].title).toBe('Caching strategy');
    expect(ranked.find((s) => s.title === 'Logging conventions')).toBeUndefined();
  });

  it('returns nothing when query has no matches against existing snapshots', async () => {
    const ranked = await hybrid.searchSnapshotsHybrid(
      projectId,
      'p',
      'kubernetes deployment manifest',
      10,
    );
    expect(ranked).toEqual([]);
  });

  it('countSnapshots reflects the DB state used by the tool to distinguish empty-project from empty-query', () => {
    expect(db.countSnapshots(projectId)).toBe(3);
    const empty = db.createProject('empty', dir);
    expect(db.countSnapshots(empty.id)).toBe(0);
  });
});
