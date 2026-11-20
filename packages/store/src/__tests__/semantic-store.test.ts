import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { semanticIndexing227 } from '../migrations/227_semantic_indexing.js';
import { semanticRecovery277 } from '../migrations/277_semantic_recovery.js';
import { projectSemanticTargets283 } from '../migrations/283_project_semantic_targets.js';
import { pruneDuplicateSemanticBuilds } from '../semantic-build-retention.js';
import { SemanticStore, type EmbeddingTarget } from '../semantic-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

function harness() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  semanticIndexing227.up(db);
  return { db, store: new SemanticStore(db) };
}

describe('SemanticStore', () => {
  it('keeps code targets scoped across migration, reset and project deletion', () => {
    const { db, store } = harness();
    try {
      expect(store.getProjectTargets(1)).toBeNull();
      db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY); INSERT INTO projects VALUES (1),(2)');
      projectSemanticTargets283.up(db);
      const global = store.getProfile('code');
      const targets = { embedding_target: { kind: 'disabled' }, reranker_target: { kind: 'disabled' } } as const;
      store.setProjectTargets(1, targets);
      expect(store.getProjectTargets(1)).toEqual(targets);
      expect(store.getProjectTargets(2)).toBeNull();
      expect(store.getProfile('code')).toEqual(global);
      store.setProjectTargets(1, null);
      expect(store.getProjectTargets(1)).toBeNull();
      store.setProjectTargets(1, targets);
      db.exec('DELETE FROM projects WHERE id=1');
      expect(store.getProjectTargets(1)).toBeNull();
    } finally { db.close(); }
  });
  it('deletes redundant legacy attempts and atomically admits only one new build', async () => {
    const { db, store } = harness();
    try {
      const namespace = 'memory:user';
      const generation_id = store.createGeneration({ purpose: 'memory', fingerprint: 'dedup',
        embedding_target: { kind: 'disabled' }, dimension: 4 }).id;
      const input = { namespace, generation_id, kind: 'build' as const, expected_items: 1 };
      const paused = (key: string) => {
        const row = store.createJob({ ...input, cursor: { reason: 'targeted-memory-delta', item_keys: [key] } });
        return store.updateJob(row.id, { status: 'paused', error: '429', failed_items: 1 })!;
      };
      for (let i = 0; i < 130; i++) paused('a');
      const newest = paused('a'), different = paused('b');
      const delta = store.createJob({ ...input, kind: 'delta', cursor: { reason: 'mutation-fence' } });
      semanticRecovery277.up(db);
      expect(() => store.createJob(input)).toThrow('semantic build already open');
      expect(await pruneDuplicateSemanticBuilds(db)).toBe(130);
      expect(store.listJobs({ namespace }).map(row => row.id).sort((a,b)=>a-b)).toEqual([newest.id, different.id, delta.id]);
      expect(await pruneDuplicateSemanticBuilds(db)).toBe(0);
      const claimed = store.claimBuildJob(input)!;
      expect(claimed).toMatchObject({ id: different.id, status: 'running' });
      expect(store.claimBuildJob(input)).toBeNull();
      expect(store.getOrCreateBuildJob(input).id).toBe(claimed.id);
      store.updateJob(claimed.id, { status: 'paused' });
      expect(store.claimBuildJob(input)?.id).toBe(claimed.id);
    } finally { store.close(); db.close(); }
  });
  it('recovers interrupted jobs atomically while preserving fences, cleanup, cursors and live generations', () => {
    const { db, store } = harness();
    try {
      semanticRecovery277.up(db);
      const namespace = 'code:p1';
      const makeGeneration = (fingerprint: string) => store.createGeneration({
        purpose: 'code', fingerprint, embedding_target: { kind: 'disabled' }, dimension: 4,
      }).id;
      const active = makeGeneration('active'), building = makeGeneration('building'), old = makeGeneration('old');
      store.beginNamespaceGeneration({ namespace, purpose: 'code', generation_id: active });
      store.activateNamespaceGeneration(namespace, active);
      store.beginNamespaceGeneration({ namespace, purpose: 'code', generation_id: building });
      const cursor = { reason: 'code-delta', events: [{ path: 'src/file.ts' }] };
      const running = store.createJob({ namespace, kind: 'backfill', cursor });
      store.updateJob(running.id, { status: 'running', processed_items: 7, failed_items: 2 });
      const obsolete = store.createJob({ namespace, kind: 'build', generation_id: old, cursor: { reason: 'mutation-fence' } });
      store.updateJob(obsolete.id, { status: 'running' });
      const orphan = store.createJob({ namespace: 'code:p2', kind: 'backfill', generation_id: old });
      store.updateJob(orphan.id, { status: 'paused' });
      const keep = [
        store.createJob({ namespace, kind: 'build', generation_id: active }),
        store.createJob({ namespace, kind: 'build', generation_id: building }),
        store.createJob({ namespace, kind: 'delta', cursor: { reason: 'mutation-fence' } }),
        store.createJob({ namespace, kind: 'cleanup' }),
        store.createJob({ namespace, kind: 'build', generation_id: old }),
      ];
      for (const [i, status] of (['paused', 'pending', 'running', 'running', 'completed'] as const).entries()) {
        store.updateJob(keep[i]!.id, { status });
      }
      const before = keep.map(job => store.getJob(job.id));
      store.recoverInterruptedJobs();
      expect(store.getJob(running.id)).toMatchObject({ status: 'paused', processed_items: 0, failed_items: 2, cursor,
        error: expect.stringContaining('waiting for an explicit resume') });
      for (const job of [orphan, obsolete]) expect(store.getJob(job.id)).toMatchObject({
        status: 'cancelled', completed_at: expect.any(String), error: expect.stringContaining('superseded'),
      });
      expect(keep.map(job => store.getJob(job.id))).toEqual(before);
      db.pragma('query_only = ON');
      expect(() => store.recoverInterruptedJobs()).not.toThrow();
    } finally { store.close(); db.close(); }
  });
  it('selects a current job without hydrating completed history or foreign generations', () => {
    const { db, store } = harness();
    try {
      const running = store.createJob({ namespace: 'code:p7', kind: 'build' });
      store.updateJob(running.id, { status: 'running' });
      const older = store.createJob({ namespace: 'code:p7', kind: 'backfill' });
      const generation = store.createGeneration({ purpose: 'code', fingerprint: 'retired-test',
        embedding_target: { kind: 'disabled' }, dimension: 4 });
      db.prepare('UPDATE semantic_jobs SET generation_id = ? WHERE id = ?').run(generation.id, older.id);
      const marker = store.createJob({ namespace: 'semantic:reindex:code:p7', kind: 'backfill' });
      store.updateJob(marker.id, { status: 'completed' });
      db.transaction(() => {
        const insert = db.prepare("INSERT INTO semantic_jobs(namespace,kind,status,priority,cursor) VALUES ('code:p7','build','completed',0,?)");
        for (let i = 0; i < 1000; i++) insert.run(JSON.stringify({ historical: 'x'.repeat(4096) }));
      })();
      const parse = vi.spyOn(JSON, 'parse');
      try {
        expect(store.currentProjectJob(7, [])?.id).toBe(running.id);
        expect(parse.mock.calls.some(([raw]) => String(raw).includes('historical'))).toBe(false);
      } finally { parse.mockRestore(); }
      expect(store.currentProjectJob(7, [], true)).toBeNull();
      store.updateJob(marker.id, { status: 'paused' });
      expect(store.currentProjectJob(7, [])?.id).toBe(marker.id);
      expect(store.currentProjectJob(7, [], true)?.id).toBe(marker.id);
      expect(store.currentProjectJob(8, [])).toBeNull();
      expect(() => store.currentProjectJob(7, [1, 2, 3])).toThrow('scope');
    } finally { store.close(); db.close(); }
  });

  it('pages recent project jobs in descending order without priority or foreign rows changing the cursor', () => {
    const { db, store } = harness();
    try {
      const expected = [];
      for (let i = 0; i < 7; i++) {
        expected.push(store.createJob({ namespace: 'code:p1', kind: 'delta', priority: i % 3 }).id);
        store.createJob({ namespace: 'code:p2', kind: 'delta', priority: 99 });
      }
      const first = store.listJobs({ namespaces: ['code:p1'], order: 'newest', limit: 3 });
      const rest = store.listJobs({ namespaces: ['code:p1'], order: 'newest', beforeId: first.at(-1)!.id, limit: 10 });
      expect([...first, ...rest].map(row => row.id)).toEqual(expected.reverse());
      expect(() => store.listJobs({ beforeId: -1 })).toThrow('beforeId');
    } finally { store.close(); db.close(); }
  });
  it('filters docs backfills in SQL and reads removal/mutation state without full cursor rows', () => {
    const { db, store } = harness();
    try {
      const doc = store.createJob({ namespace: 'docs:c1', kind: 'backfill' });
      store.createJob({ namespace: 'code:p1', kind: 'backfill' });
      store.createJob({ namespace: 'docs_c1', kind: 'backfill' });
      expect(store.listJobs({ namespacePrefix: 'docs:c', generationId: null, kinds: ['backfill'] }).map(row => row.id)).toEqual([doc.id]);
      expect(store.listJobs({ namespacePrefix: 'docs_', generationId: null })).toHaveLength(1);
      expect(store.hasOpenNamespaceMutationJobs('docs:c1')).toBe(true);
      store.updateJob(doc.id, { status: 'completed' });
      expect(store.hasOpenNamespaceMutationJobs('docs:c1')).toBe(false);
      const removed = store.createJob({ namespace: 'project-removal:p7', kind: 'cleanup', cursor: { reason: 'project-removal' } });
      store.updateJob(removed.id, { status: 'completed' });
      const cancelled = store.createJob({ namespace: 'project-removal:p8', kind: 'cleanup', cursor: { reason: 'project-removal' } });
      store.updateJob(cancelled.id, { status: 'cancelled' });
      store.createJob({ namespace: 'project-removal:p9', kind: 'cleanup', cursor: { reason: 'other-cleanup' } });
      expect(store.listProjectRemovalIds()).toEqual([7]);
      expect(() => store.listJobs({ generationId: -1 })).toThrow('generationId');
    } finally { store.close(); db.close(); }
  });
  it('pages bounded jobs by id without losing rows to priority order or including later inserts', () => {
    const { db, store } = harness();
    try {
      const jobs = Array.from({ length: 7 }, (_, priority) => store.createJob({
        namespace: 'code:p1', kind: 'delta', priority,
      }));
      const throughId = store.getJobHighWaterId();
      store.createJob({ namespace: 'code:p1', kind: 'delta', priority: 100 });
      const first = store.listJobs({ namespace: 'code:p1', afterId: 0, throughId, limit: 3 });
      const second = store.listJobs({ namespace: 'code:p1', afterId: first.at(-1)!.id, throughId, limit: 3 });
      const last = store.listJobs({ namespace: 'code:p1', afterId: second.at(-1)!.id, throughId, limit: 3 });
      expect([...first, ...second, ...last].map(job => job.id)).toEqual(jobs.map(job => job.id));
      expect(() => store.listJobs({ limit: -1 })).toThrow(RangeError);
      expect(() => store.listJobs({ afterId: NaN })).toThrow(RangeError);
    } finally { store.close(); db.close(); }
  });
  it('reuses paused build jobs without losing durable deltas or retry state', () => {
    const { db, store } = harness();
    try {
      const generation = store.createGeneration({
        purpose: 'memory', fingerprint: 'retry-space', dimension: 2,
        embedding_target: { kind: 'local_http', baseUrl: 'http://localhost', model: 'm', protocol: 'openai-embeddings' },
      });
      const namespace = 'memory:user';
      store.beginNamespaceGeneration({ namespace, purpose: 'memory', generation_id: generation.id });
      const delta = store.noteNamespaceMutation({ namespace, itemKeys: ['agent_memory:1'], operation: 'upsert' });
      const input = { namespace, generation_id: generation.id, kind: 'build' as const, expected_items: 1 };
      const build = store.getOrCreateBuildJob(input);
      const retry = { attempt: 3, not_before_ms: 123456, blocked: true };
      store.updateJob(build.id, { status: 'paused', cursor: { retry }, error: 'offline' });
      expect(store.getNamespaceBuildRetry(namespace)).toEqual(retry);
      const reused = store.getOrCreateBuildJob({ ...input, expected_items: 2 });
      expect(reused).toMatchObject({ id: build.id, expected_items: 2, status: 'pending', cursor: { retry } });
      expect(store.getJob(delta.id)).toMatchObject({ status: 'pending', expected_items: 1 });
      expect(store.listJobs({ namespace })).toHaveLength(2);
      store.updateJob(build.id, { status: 'completed' });
      expect(store.getNamespaceBuildRetry(namespace)).toBeNull();
      expect(store.getOrCreateBuildJob(input).id).not.toBe(build.id);
    } finally { store.close(); db.close(); }
  });

  it('unblocks a legacy quota latch without erasing its retry window or its durable work', () => {
    const { db, store } = harness();
    try {
      const generation = store.createGeneration({ purpose: 'memory', fingerprint: 'quota-space', dimension: 2,
        embedding_target: { kind: 'local_http', baseUrl: 'http://localhost', model: 'm', protocol: 'openai-embeddings' } });
      const namespace = 'memory:user';
      store.beginNamespaceGeneration({ namespace, purpose: 'memory', generation_id: generation.id });
      const build = store.getOrCreateBuildJob({ namespace, generation_id: generation.id, kind: 'build', expected_items: 30 });
      const retry = { attempt: 10, not_before_ms: 123456, blocked: true };
      store.updateJob(build.id, { status: 'paused', cursor: { retry }, error: '429 Rate limit exceeded: free-models-per-min' });
      expect(store.getNamespaceBuildRetry(namespace)).toEqual({ ...retry, blocked: false });
      expect(store.getJob(build.id)).toMatchObject({ status: 'paused', expected_items: 30, cursor: { retry } });
      store.updateJob(build.id, { error: '401 invalid API key' });
      expect(store.getNamespaceBuildRetry(namespace)!.blocked).toBe(true);
    } finally { store.close(); db.close(); }
  });

  it('queries mutation fences and wildcard deltas without hydrating historical cursors', () => {
    const { db, store } = harness();
    try {
      store.createJob({ namespace: 'code:p1', kind: 'build', cursor: { reason: 'code-delta', events: ['ignored', { path: 'a.ts' }] } });
      expect(store.requiresExplicitNamespaceReindex('code:p1')).toBe(false);
      const wildcard = store.createJob({ namespace: 'code:p1', kind: 'delta', cursor: { reason: 'code-delta', events: [{ path: '*' }] } });
      expect(store.requiresExplicitNamespaceReindex('code:p1')).toBe(true);
      store.updateJob(wildcard.id, { status: 'completed' });
      expect(store.requiresExplicitNamespaceReindex('code:p1')).toBe(false);
      const fence = store.createJob({ namespace: 'docs:c1', kind: 'delta', cursor: { reason: 'mutation-fence', fence_phase: 'in-flight' } });
      store.updateJob(fence.id, { status: 'running' });
      expect(store.hasLiveMutationFence('docs:c1')).toBe(true);
      expect(store.hasLiveMutationFence('docs:c2')).toBe(false);
      store.updateJob(fence.id, { status: 'pending', cursor: { reason: 'mutation-fence', fence_phase: 'settled' } });
      expect(store.hasLiveMutationFence('docs:c1')).toBe(false);
      expect(store.getStatus().jobs).toMatchObject({ pending: 2, completed: 1, running: 0 });
    } finally { store.close(); db.close(); }
  });
  // GET /api/projects/semantic/status used to pull EVERY job row and filter in
  // JS — an unbounded SELECT plus a JSON.parse per row, on the main thread.
  it('filters listJobs by a namespace set in SQL, preserving order', () => {
    const { db, store } = harness();
    try {
      const embedding: EmbeddingTarget = {
        kind: 'local_http', baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'nomic-embed-text', protocol: 'openai-embeddings',
      };
      const generation = store.createGeneration({
        purpose: 'code', fingerprint: 'fp-ns', embedding_target: embedding,
        dimension: 768, expected_items: 1,
      });
      const mk = (namespace: string, priority: number) =>
        store.createJob({ generation_id: generation.id, namespace, kind: 'delta', expected_items: 1, priority });
      const low = mk('code:p1', 1);
      const high = mk('code:p2', 9);
      mk('code:p3', 5); // must be excluded

      const got = store.listJobs({ namespaces: ['code:p1', 'code:p2'] });
      expect(got.map((j) => j.id)).toEqual([high.id, low.id]); // priority DESC, id
      expect(store.listJobs({ namespaces: [] })).toEqual([]);
      // Agrees with the unfiltered form for the same subset.
      expect(got).toEqual(
        store.listJobs().filter((j) => j.namespace === 'code:p1' || j.namespace === 'code:p2'),
      );
    } finally {
      store.close();
      db.close();
    }
  });

  it('filters listJobs by status and kind sets in SQL', () => {
    const { db, store } = harness();
    try {
      const embedding: EmbeddingTarget = {
        kind: 'local_http', baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'nomic-embed-text', protocol: 'openai-embeddings',
      };
      const generation = store.createGeneration({
        purpose: 'code', fingerprint: 'fp-job-filter', embedding_target: embedding,
        dimension: 768, expected_items: 1,
      });
      const pendingDelta = store.createJob({
        generation_id: generation.id,
        namespace: 'code:p1',
        kind: 'delta',
        expected_items: 1,
      });
      const pausedBackfill = store.createJob({
        generation_id: generation.id,
        namespace: 'code:p2',
        kind: 'backfill',
        expected_items: 1,
      });
      store.updateJob(pausedBackfill.id, { status: 'paused' });
      const completedBackfill = store.createJob({
        generation_id: generation.id,
        namespace: 'code:p3',
        kind: 'backfill',
        expected_items: 1,
      });
      store.updateJob(completedBackfill.id, { status: 'completed' });

      expect(store.listJobs({
        statuses: ['pending', 'paused'],
        kinds: ['backfill'],
      }).map((job) => job.id)).toEqual([pausedBackfill.id]);
      expect(store.listJobs({ statuses: [] })).toEqual([]);
      expect(store.listJobs({ kinds: [] })).toEqual([]);
      expect(store.listJobs({
        status: 'pending',
        kinds: ['delta'],
      }).map((job) => job.id)).toEqual([pendingDelta.id]);
    } finally {
      store.close();
      db.close();
    }
  });

  it('temporarily overrides and restores the SQLite busy timeout', () => {
    const { db, store } = harness();
    try {
      db.pragma('busy_timeout = 5000');
      expect(() => store.withBusyTimeout(0, () => {
        expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
        throw new Error('operation failed');
      })).toThrow('operation failed');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      store.close();
      db.close();
    }
  });

  it('coalesces durable project-removal tombstones and reopens completed requests', () => {
    const { db, store } = harness();
    try {
      const first = store.requestProjectRemoval({
        projectId: 17,
        requestedBy: 'cli',
        finalizeProject: true,
      });
      const duplicate = store.requestProjectRemoval({
        projectId: 17,
        requestedBy: 'cli',
        finalizeProject: true,
      });
      expect(duplicate.id).toBe(first.id);
      expect(duplicate).toMatchObject({
        namespace: 'project-removal:p17',
        kind: 'cleanup',
        status: 'pending',
        cursor: expect.objectContaining({
          reason: 'project-removal',
          projectId: 17,
          requested_by: 'cli',
          finalize_project: true,
        }),
      });
      expect(store.hasProjectRemovalRequest(17)).toBe(true);

      store.updateJob(first.id, { status: 'completed', processed_items: 1 });
      const reopened = store.requestProjectRemoval({
        projectId: 17,
        requestedBy: 'cli-retry',
        finalizeProject: true,
      });
      expect(reopened).toMatchObject({ id: first.id, status: 'pending', processed_items: 0 });
      expect(reopened.completed_at).toBeNull();
    } finally {
      store.close();
      db.close();
    }
  });

  it('seeds local profiles and model catalog', () => {
    const { db, store } = harness();
    try {
      const profiles = store.listProfiles();
      expect(profiles.map((profile) => profile.purpose)).toEqual(['code', 'docs', 'memory']);
      expect(profiles.every((profile) => profile.embedding_target.kind === 'onnx')).toBe(true);
      expect(store.listModels().map((model) => model.model_id)).toEqual([
        'Xenova/multilingual-e5-small',
        'auto',
      ]);
    } finally {
      store.close();
      db.close();
    }
  });

  it('persists profiles, generations, atomic namespace activation, items and jobs', () => {
    const { db, store } = harness();
    try {
      const embedding: EmbeddingTarget = {
        kind: 'local_http', baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'nomic-embed-text', protocol: 'openai-embeddings',
      };
      const profile = store.upsertProfile({ purpose: 'code', embedding_target: embedding, reranker_target: { kind: 'disabled' } });
      expect(profile.embedding_target).toEqual(embedding);

      const generation = store.createGeneration({
        purpose: 'code', fingerprint: 'fp-1', embedding_target: embedding,
        dimension: 768, expected_items: 2,
      });
      const rebuild = store.createGeneration({
        purpose: 'code', fingerprint: 'fp-1', embedding_target: embedding,
        dimension: 768, expected_items: 2,
      });
      expect(rebuild.id).not.toBe(generation.id); // same vector space can be rebuilt atomically
      store.beginNamespaceGeneration({ namespace: 'code:p7', purpose: 'code', generation_id: generation.id, expected_items: 2 });
      expect(() => store.activateNamespaceGeneration('code:p7', generation.id)).toThrow(/incomplete/);

      store.upsertItem({
        generation_id: generation.id, namespace: 'code:p7', item_key: 'src/a.ts',
        source_hash: 'h1', vector_id: 'file:1', chunk_index: 0, status: 'indexed', attempts: 1, error: null,
      });
      store.upsertItem({
        generation_id: generation.id, namespace: 'code:p7', item_key: 'src/a.ts',
        source_hash: 'h2', vector_id: null, chunk_index: 0, status: 'failed', attempts: 1, error: 'retry failed',
      });
      expect(store.listItems({ generation_id: generation.id })[0]).toMatchObject({
        source_hash: 'h2', status: 'failed', attempts: 2, error: 'retry failed',
      });
      store.upsertItem({
        generation_id: generation.id, namespace: 'code:p7', item_key: 'src/a.ts',
        source_hash: 'h2', vector_id: 'file:1', chunk_index: 0, status: 'indexed', attempts: 1, error: null,
      });
      expect(store.listItems({ generation_id: generation.id })[0].attempts).toBe(3);
      store.updateGeneration(generation.id, { status: 'ready', indexed_items: 2 });
      store.updateNamespaceProgress('code:p7', { indexed_items: 2 });
      const active = store.activateNamespaceGeneration('code:p7', generation.id);
      expect(active.active_generation_id).toBe(generation.id);
      expect(active.building_generation_id).toBeNull();

      const job = store.createJob({ generation_id: generation.id, namespace: 'code:p7', kind: 'delta', expected_items: 1 });
      const completed = store.updateJob(job.id, { status: 'completed', processed_items: 1 });
      expect(completed?.completed_at).not.toBeNull();
      expect(store.getStatus({ purpose: 'code' }).totals.indexed_items).toBe(2);
      expect(store.deleteItemsByVectorIds(generation.id, 'code:p7', ['file:1'])).toBe(1);
      store.upsertItem({
        generation_id: generation.id, namespace: 'code:p7', item_key: 'src/a.ts',
        source_hash: 'h2', vector_id: 'file:1', chunk_index: 0, status: 'indexed', attempts: 1, error: null,
      });
      expect(store.deleteNamespace('code:p7')).toEqual({ items: 1, jobs: 1, namespace: 1 });
      expect(store.listNamespaceGenerations({ namespace: 'code:p7' })).toEqual([]);
      expect(store.getGeneration(generation.id)?.status).toBe('retired');
    } finally {
      store.close();
      db.close();
    }
  });

  it('does not recreate central tables in an already-trimmed project DB', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE project_db_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO project_db_meta VALUES ('trim_version', '1');`);
      semanticIndexing227.up(db);
      const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'semantic_profiles'`).get();
      expect(table).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('keeps the active generation target immutable while the desired profile changes', () => {
    const { db, store } = harness();
    try {
      const activeTarget: EmbeddingTarget = {
        kind: 'onnx',
        model: 'active/model',
        pooling: 'mean',
        normalize: true,
        queryTemplate: 'query: {text}',
        documentTemplate: 'passage: {text}',
      };
      const desiredTarget: EmbeddingTarget = {
        kind: 'local_http',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'desired/model',
        protocol: 'openai-embeddings',
      };
      const generation = store.createGeneration({
        purpose: 'code',
        fingerprint: 'active-fingerprint',
        embedding_target: activeTarget,
        dimension: 384,
      });
      store.beginNamespaceGeneration({
        namespace: 'code:p9', purpose: 'code', generation_id: generation.id,
      });
      store.updateGeneration(generation.id, { status: 'ready' });
      store.activateNamespaceGeneration('code:p9', generation.id);

      store.upsertProfile({
        purpose: 'code',
        embedding_target: desiredTarget,
        reranker_target: { kind: 'disabled' },
      });

      expect(store.getProfile('code')?.embedding_target).toEqual(desiredTarget);
      expect(store.getActiveGeneration('code:p9')).toMatchObject({
        id: generation.id,
        embedding_target: activeTarget,
      });
      expect(store.getActiveGeneration('code:p404')).toBeNull();
    } finally {
      store.close();
      db.close();
    }
  });

  it('leases, recovers and resumes durable reindex control jobs', () => {
    const { db, store } = harness();
    try {
      const queued = store.enqueueReindexJob('memory');
      expect(queued).toMatchObject({
        namespace: 'semantic:reindex:memory',
        status: 'pending',
      });
      expect(store.enqueueReindexJob('memory').id).toBe(queued.id);

      const claimed = store.claimNextReindexJob('worker-a', 100, 1_000);
      expect(claimed).toMatchObject({
        id: queued.id,
        status: 'running',
        cursor: { purpose: 'memory', attempt: 1, lease_owner: 'worker-a' },
      });
      expect(store.renewReindexJobLease(queued.id, 'other-worker', 100, 1_050)).toBe(false);
      expect(store.renewReindexJobLease(queued.id, 'worker-a', 100, 1_050)).toBe(true);
      expect(store.recoverExpiredReindexJobs(1_149)).toBe(0);
      expect(store.recoverExpiredReindexJobs(1_150)).toBe(1);

      const recovered = store.claimNextReindexJob('worker-b', 100, 1_151);
      expect(recovered).toMatchObject({
        id: queued.id,
        status: 'running',
        cursor: { attempt: 2, lease_owner: 'worker-b' },
      });
      store.updateJob(queued.id, { status: 'paused', error: 'provider unavailable' });
      expect(store.enqueueReindexJob('memory')).toMatchObject({
        id: queued.id,
        status: 'pending',
        error: null,
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('keeps project-scoped reindex markers out of the global dispatcher lease queue', () => {
    const { db, store } = harness();
    try {
      const targeted = store.createJob({
        namespace: 'semantic:reindex:code:p9',
        kind: 'build',
        cursor: {
          project_id: 9,
          lease_owner: 'project-owner',
          lease_expires_at_ms: 1_000,
        },
      });
      store.updateJob(targeted.id, { status: 'running' });

      expect(store.claimNextReindexJob('global-worker', 100, 1_001)).toBeNull();
      expect(store.recoverExpiredReindexJobs(1_001)).toBe(0);
      expect(store.renewReindexJobLease(
        targeted.id,
        'project-owner',
        100,
        1_001,
      )).toBe(false);
      expect(store.getJob(targeted.id)).toMatchObject({
        namespace: 'semantic:reindex:code:p9',
        status: 'running',
        cursor: {
          project_id: 9,
          lease_owner: 'project-owner',
          lease_expires_at_ms: 1_000,
        },
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('claims only the explicitly requested global reindex purpose', () => {
    const { db, store } = harness();
    try {
      const code = store.enqueueReindexJob('code');
      const memory = store.enqueueReindexJob('memory');

      expect(store.claimNextReindexJob('worker', 100, 1_000, 'memory')).toMatchObject({
        id: memory.id,
        namespace: 'semantic:reindex:memory',
        status: 'running',
      });
      expect(store.getJob(code.id)).toMatchObject({ status: 'pending' });
    } finally {
      store.close();
      db.close();
    }
  });

  it('deduplicates and resumes generation-less namespace backfills', () => {
    const { db, store } = harness();
    try {
      const queued = store.enqueueNamespaceBackfill({
        namespace: 'docs:c7',
        cursor: { collection_id: 7, attempt: 0 },
        error: 'worker unavailable',
      });
      expect(queued).toMatchObject({
        generation_id: null,
        namespace: 'docs:c7',
        kind: 'backfill',
        status: 'pending',
        error: 'worker unavailable',
      });
      expect(store.enqueueNamespaceBackfill({
        namespace: 'docs:c7', cursor: { requested_at_ms: 123 },
      })).toMatchObject({
        id: queued.id,
        cursor: { collection_id: 7, attempt: 0, requested_at_ms: 123 },
      });

      store.updateJob(queued.id, { status: 'paused', failed_items: 1, error: 'provider offline' });
      expect(store.enqueueNamespaceBackfill({
        namespace: 'docs:c7', cursor: { requested_at_ms: 456 }, error: 'retry requested',
      })).toMatchObject({
        id: queued.id,
        status: 'pending',
        failed_items: 1,
        error: 'retry requested',
      });
      expect(store.listJobs().filter((job) => job.namespace === 'docs:c7')).toHaveLength(1);
    } finally {
      store.close();
      db.close();
    }
  });

  it('activates complete namespaces during a building rollout and compare-clears abandoned builds', () => {
    const { db, store } = harness();
    try {
      const generation = store.createGeneration({
        purpose: 'code',
        fingerprint: 'rollout',
        embedding_target: {
          kind: 'onnx', model: 'test', pooling: 'mean', normalize: true,
          queryTemplate: '{text}', documentTemplate: '{text}',
        },
        dimension: 2,
      });
      store.beginNamespaceGeneration({
        namespace: 'code:p1', purpose: 'code', generation_id: generation.id, expected_items: 1,
      });
      store.updateNamespaceProgress('code:p1', { indexed_items: 1 });

      expect(store.activateNamespaceGeneration('code:p1', generation.id)).toMatchObject({
        active_generation_id: generation.id,
        building_generation_id: null,
      });
      expect(store.getGeneration(generation.id)?.status).toBe('building');

      const replacement = store.createGeneration({
        purpose: 'code',
        fingerprint: 'replacement',
        embedding_target: {
          kind: 'onnx', model: 'test-2', pooling: 'mean', normalize: true,
          queryTemplate: '{text}', documentTemplate: '{text}',
        },
        dimension: 3,
      });
      store.beginNamespaceGeneration({
        namespace: 'code:p1', purpose: 'code', generation_id: replacement.id,
      });
      expect(store.clearBuildingGeneration('code:p1', generation.id)?.building_generation_id)
        .toBe(replacement.id);
      expect(store.clearBuildingGeneration('code:p1', replacement.id)?.building_generation_id)
        .toBeNull();
    } finally {
      store.close();
      db.close();
    }
  });

  it('coalesces durable mutation jobs and preserves post-watermark deltas at activation', () => {
    const { db, store } = harness();
    try {
      const target: EmbeddingTarget = {
        kind: 'onnx', model: 'memory', pooling: 'mean', normalize: true,
        queryTemplate: '{text}', documentTemplate: '{text}',
      };
      const generation = store.createGeneration({
        purpose: 'memory', fingerprint: 'memory-v1', embedding_target: target, dimension: 3,
      });
      store.beginNamespaceGeneration({
        namespace: 'snapshot:p7', purpose: 'memory', generation_id: generation.id,
      });

      const first = store.noteNamespaceMutation({
        namespace: 'snapshot:p7', itemKeys: ['snapshot:1'], operation: 'upsert',
      });
      const coalesced = store.noteNamespaceMutation({
        namespace: 'snapshot:p7', itemKeys: ['snapshot:2'], operation: 'delete',
      });
      expect(coalesced).toMatchObject({ id: first.id, expected_items: 2, status: 'pending' });
      expect(store.listNamespaceGenerations({ namespace: 'snapshot:p7' })[0].delta_items).toBe(2);

      // Claiming freezes this watermark. A mutation during the physical probe
      // must get a distinct job instead of growing the claimed one.
      store.updateJob(first.id, { status: 'running' });
      const newer = store.noteNamespaceMutation({
        namespace: 'snapshot:p7', itemKeys: ['snapshot:3'], operation: 'upsert',
      });
      expect(newer.id).not.toBe(first.id);

      const blocked = store.finishNamespaceMutationPass({
        namespace: 'snapshot:p7',
        generation_id: generation.id,
        expected_items: 3,
        indexed_items: 3,
        captured_jobs: [{ id: first.id, expected_items: 2 }],
        activate: true,
      });
      expect(blocked).toMatchObject({ pending: true, activated: false });
      expect(blocked.state).toMatchObject({
        active_generation_id: null,
        building_generation_id: generation.id,
        delta_items: 1,
      });
      expect(store.getJob(first.id)).toMatchObject({ status: 'completed', processed_items: 2 });
      expect(store.getJob(newer.id)).toMatchObject({ status: 'pending' });

      store.updateJob(newer.id, { status: 'running' });
      const active = store.finishNamespaceMutationPass({
        namespace: 'snapshot:p7',
        generation_id: generation.id,
        expected_items: 3,
        indexed_items: 3,
        captured_jobs: [{ id: newer.id, expected_items: 1 }],
        activate: true,
      });
      expect(active).toMatchObject({ pending: false, activated: true });
      expect(active.state).toMatchObject({
        active_generation_id: generation.id,
        building_generation_id: null,
        delta_items: 0,
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('marks wildcard drift as explicitly stale only while its durable job is open', () => {
    const { db, store } = harness();
    try {
      const job = store.noteNamespaceMutation({
        namespace: 'snapshot:p7',
        itemKeys: ['*'],
        operation: 'upsert',
        requiresExplicitReindex: true,
      });
      expect(job.cursor).toMatchObject({ requires_explicit_reindex: true });
      expect(store.requiresExplicitNamespaceReindex('snapshot:p7')).toBe(true);

      store.updateJob(job.id, { status: 'completed' });
      expect(store.requiresExplicitNamespaceReindex('snapshot:p7')).toBe(false);
    } finally {
      store.close();
      db.close();
    }
  });

  it('creates active-only deltas and generation-less backfills without losing either path', () => {
    const { db, store } = harness();
    try {
      const target: EmbeddingTarget = {
        kind: 'onnx', model: 'memory', pooling: 'mean', normalize: true,
        queryTemplate: '{text}', documentTemplate: '{text}',
      };
      const generation = store.createGeneration({
        purpose: 'memory', fingerprint: 'memory-v1', embedding_target: target, dimension: 3,
      });
      store.beginNamespaceGeneration({
        namespace: 'memory:user', purpose: 'memory', generation_id: generation.id,
      });
      store.activateNamespaceGeneration('memory:user', generation.id);

      const delta = store.noteNamespaceMutation({
        namespace: 'memory:user', itemKeys: ['agent_memory:4'], operation: 'upsert',
      });
      expect(delta).toMatchObject({
        generation_id: generation.id, kind: 'delta', status: 'pending', expected_items: 1,
      });
      expect(store.listNamespaceGenerations({ namespace: 'memory:user' })[0].delta_items).toBe(1);

      store.updateJob(delta.id, { status: 'running' });
      const caughtUp = store.finishNamespaceMutationPass({
        namespace: 'memory:user', generation_id: generation.id,
        expected_items: 1, indexed_items: 1,
        captured_jobs: [{ id: delta.id, expected_items: 1 }], activate: false,
      });
      expect(caughtUp).toMatchObject({ pending: false, activated: false });
      expect(caughtUp.state).toMatchObject({ active_generation_id: generation.id, delta_items: 0 });

      const pending = store.noteNamespaceMutation({
        namespace: 'snapshot:p404', itemKeys: ['snapshot:9'], operation: 'upsert',
      });
      const same = store.noteNamespaceMutation({
        namespace: 'snapshot:p404', itemKeys: ['snapshot:10'], operation: 'delete',
      });
      expect(same).toMatchObject({
        id: pending.id, generation_id: null, kind: 'backfill', expected_items: 2,
      });
      expect(store.listNamespaceGenerations({ namespace: 'snapshot:p404' })).toEqual([]);
    } finally {
      store.close();
      db.close();
    }
  });

  it('keeps concurrent relational fences independent and refuses to acknowledge in-flight work', () => {
    const { db, store } = harness();
    try {
      const generation = store.createGeneration({
        purpose: 'docs', fingerprint: 'docs-v1', dimension: 3,
        embedding_target: {
          kind: 'onnx', model: 'docs', pooling: 'mean', normalize: true,
          queryTemplate: '{text}', documentTemplate: '{text}',
        },
      });
      store.beginNamespaceGeneration({
        namespace: 'docs:c7', purpose: 'docs', generation_id: generation.id,
      });
      const first = store.noteNamespaceMutation({
        namespace: 'docs:c7', itemKeys: ['*'], operation: 'upsert',
        fence: { token: 'source-a', owner: 'process-a' },
      });
      const second = store.noteNamespaceMutation({
        namespace: 'docs:c7', itemKeys: ['*'], operation: 'upsert',
        fence: { token: 'source-b', owner: 'process-a' },
      });
      expect(first).toMatchObject({ status: 'running', kind: 'delta' });
      expect(second).toMatchObject({ status: 'running', kind: 'delta' });
      expect(second.id).not.toBe(first.id);
      expect(store.listNamespaceGenerations({ namespace: 'docs:c7' })[0].delta_items).toBe(2);

      const blocked = store.finishNamespaceMutationPass({
        namespace: 'docs:c7', generation_id: generation.id,
        expected_items: 2, indexed_items: 2,
        // Even an erroneous caller-supplied watermark cannot consume a live
        // fence before its relational mutation reaches finally.
        captured_jobs: [
          { id: first.id, expected_items: 1 },
          { id: second.id, expected_items: 1 },
        ],
        activate: true,
      });
      expect(blocked).toMatchObject({ pending: true, activated: false });
      expect(store.getJob(first.id)?.status).toBe('running');

      store.settleNamespaceMutationFence({ job_id: first.id, token: 'source-a' });
      const onePending = store.finishNamespaceMutationPass({
        namespace: 'docs:c7', generation_id: generation.id,
        expected_items: 2, indexed_items: 2,
        captured_jobs: [{ id: first.id, expected_items: 1 }], activate: true,
      });
      expect(onePending).toMatchObject({ pending: true, activated: false });
      expect(onePending.state.delta_items).toBe(1);

      store.settleNamespaceMutationFence({
        job_id: second.id, token: 'source-b', mutation_error: 'partial ingest',
      });
      const activated = store.finishNamespaceMutationPass({
        namespace: 'docs:c7', generation_id: generation.id,
        expected_items: 2, indexed_items: 2,
        captured_jobs: [{ id: second.id, expected_items: 1 }], activate: true,
      });
      expect(activated).toMatchObject({ pending: false, activated: true });
      expect(activated.state.delta_items).toBe(0);
    } finally {
      store.close();
      db.close();
    }
  });

  it('recovers only mutation fences owned by a previous process', () => {
    const { db, store } = harness();
    try {
      const stale = store.noteNamespaceMutation({
        namespace: 'docs:c8', itemKeys: ['*'], operation: 'upsert',
        fence: { token: 'stale', owner: 'old-process' },
      });
      const live = store.noteNamespaceMutation({
        namespace: 'docs:c8', itemKeys: ['*'], operation: 'upsert',
        fence: { token: 'live', owner: 'new-process' },
      });

      expect(store.recoverNamespaceMutationFences('docs:c', 'new-process')).toBe(1);
      expect(store.getJob(stale.id)).toMatchObject({
        status: 'pending',
        cursor: expect.objectContaining({
          fence_phase: 'settled', recovery_reason: 'process-restart',
        }),
      });
      expect(store.getJob(live.id)).toMatchObject({
        status: 'running',
        cursor: expect.objectContaining({ fence_phase: 'in-flight' }),
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('does not recover a live external mutation fence before its lease expires', () => {
    const { db, store } = harness();
    try {
      const leased = store.noteNamespaceMutation({
        namespace: 'memory:project:p7',
        itemKeys: ['*'],
        operation: 'upsert',
        fence: { token: 'leased', owner: 'mcp-process', leaseMs: 60_000 },
      });
      const expiresAt = Number(leased.cursor?.fence_lease_expires_at_ms);
      expect(Number.isFinite(expiresAt)).toBe(true);

      expect(store.recoverNamespaceMutationFences(
        'memory:project:p',
        'http-server',
        expiresAt - 1,
      )).toBe(0);
      expect(store.getJob(leased.id)).toMatchObject({
        status: 'running',
        cursor: expect.objectContaining({ fence_phase: 'in-flight' }),
      });

      expect(store.recoverNamespaceMutationFences(
        'memory:project:p',
        'http-server',
        expiresAt,
      )).toBe(1);
      expect(store.getJob(leased.id)).toMatchObject({
        status: 'pending',
        cursor: expect.objectContaining({
          fence_phase: 'settled',
          recovery_reason: 'process-restart',
        }),
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('settles Memory insert fences to exact post-watermark identities', () => {
    const { db, store } = harness();
    try {
      db.exec(`
        CREATE TABLE agent_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL,
          project_id INTEGER NOT NULL,
          archived_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE coder_investigations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const generation = store.createGeneration({
        purpose: 'memory',
        fingerprint: 'memory-targeted',
        dimension: 3,
        embedding_target: {
          kind: 'onnx', model: 'memory', pooling: 'mean', normalize: true,
          queryTemplate: '{text}', documentTemplate: '{text}',
        },
      });
      store.beginNamespaceGeneration({
        namespace: 'memory:project:p7',
        purpose: 'memory',
        generation_id: generation.id,
      });

      const fence = store.noteNamespaceMutation({
        namespace: 'memory:project:p7',
        itemKeys: ['*'],
        operation: 'upsert',
        fence: { token: 'memory-batch', owner: 'sweeper' },
      });
      const insertMemory = db.prepare(`
        INSERT INTO agent_memory (scope, project_id) VALUES ('project', 7)
      `);
      for (let index = 0; index < 10; index++) insertMemory.run();
      db.prepare('INSERT INTO coder_investigations (project_id) VALUES (7)').run();

      const settled = store.settleNamespaceMutationFence({
        job_id: fence.id,
        token: 'memory-batch',
      });

      expect(settled).toMatchObject({
        id: fence.id,
        status: 'pending',
        expected_items: 11,
        cursor: expect.objectContaining({
          fence_phase: 'settled',
          fence_identity_resolved: true,
          item_keys_truncated: false,
          resolved_item_count: 11,
        }),
      });
      const keys = settled?.cursor?.item_keys as string[];
      expect(keys).not.toContain('*');
      expect(keys).toEqual([
        ...Array.from({ length: 10 }, (_, index) => `agent_memory:${index + 1}`),
        'investigation:1',
      ]);
      expect(store.listJobs({ namespace: 'memory:project:p7' })).toHaveLength(1);
      expect(store.listNamespaceGenerations({ namespace: 'memory:project:p7' })[0])
        .toMatchObject({ delta_items: 11 });
    } finally {
      store.close();
      db.close();
    }
  });

  it('shrinks a bulk Memory delete fence to rows that actually left the live set', () => {
    const { db, store } = harness();
    try {
      db.exec(`
        CREATE TABLE agent_memory (
          id INTEGER PRIMARY KEY,
          scope TEXT NOT NULL,
          project_id INTEGER NOT NULL,
          archived_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE coder_investigations (
          id INTEGER PRIMARY KEY,
          project_id INTEGER
        );
        INSERT INTO agent_memory (id, scope, project_id) VALUES
          (4, 'project', 7),
          (5, 'project', 7);
      `);
      const fence = store.noteNamespaceMutation({
        namespace: 'memory:project:p7',
        itemKeys: ['agent_memory:4', 'agent_memory:5'],
        operation: 'delete',
        fence: { token: 'hygiene', owner: 'sweeper' },
      });
      db.prepare(`
        UPDATE agent_memory
        SET archived_at = datetime('now'), updated_at = datetime('now')
        WHERE id = 4
      `).run();

      const settled = store.settleNamespaceMutationFence({
        job_id: fence.id,
        token: 'hygiene',
      });

      expect(settled).toMatchObject({
        expected_items: 1,
        cursor: expect.objectContaining({
          item_keys: ['agent_memory:4'],
          resolved_item_count: 1,
        }),
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('recovers a settled mutation delta claimed by a process that crashed', () => {
    const { db, store } = harness();
    try {
      const fence = store.noteNamespaceMutation({
        namespace: 'memory:user',
        itemKeys: ['*'],
        operation: 'delete',
        fence: { token: 'settled-stale', owner: 'old-process', leaseMs: 1_000 },
      });
      store.settleNamespaceMutationFence({ job_id: fence.id, token: 'settled-stale' });
      store.updateJob(fence.id, { status: 'running' });
      const expiresAt = Number(fence.cursor?.fence_lease_expires_at_ms);

      expect(store.recoverNamespaceMutationFences(
        'memory:user',
        'new-process',
        expiresAt,
      )).toBe(1);
      expect(store.getJob(fence.id)).toMatchObject({
        status: 'pending',
        cursor: expect.objectContaining({
          fence_phase: 'settled',
          recovery_reason: 'process-restart',
        }),
      });
    } finally {
      store.close();
      db.close();
    }
  });

  it('reopens with an interrupted mutation job and namespace fence intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semantic-mutation-reopen-'));
    const path = join(dir, 'central.db');
    let db = new Database(path);
    try {
      semanticIndexing227.up(db);
      let store = new SemanticStore(db);
      const generation = store.createGeneration({
        purpose: 'memory', fingerprint: 'memory-v1', dimension: 3,
        embedding_target: {
          kind: 'onnx', model: 'memory', pooling: 'mean', normalize: true,
          queryTemplate: '{text}', documentTemplate: '{text}',
        },
      });
      store.beginNamespaceGeneration({
        namespace: 'memory:project:p9', purpose: 'memory', generation_id: generation.id,
      });
      const job = store.noteNamespaceMutation({
        namespace: 'memory:project:p9', itemKeys: ['agent_memory:7'], operation: 'upsert',
      });
      store.updateJob(job.id, { status: 'running', processed_items: 1 });
      store.close();
      db.close();

      db = new Database(path);
      store = new SemanticStore(db);
      expect(store.getJob(job.id)).toMatchObject({
        status: 'running', expected_items: 1, processed_items: 1,
      });
      expect(store.listNamespaceGenerations({ namespace: 'memory:project:p9' })[0]).toMatchObject({
        building_generation_id: generation.id,
        active_generation_id: null,
        delta_items: 1,
      });
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
