import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type DatabaseConstructor from 'better-sqlite3';
import { LocalVectorRouter, globalSemanticVectorPaths } from '../local-vector-router.js';
import {
  ProjectVectorStorePool,
  ProjectVectorStorePoolSaturatedError,
} from '../project-vector-store-pool.js';
import { semanticIndexing227 } from '../migrations/227_semantic_indexing.js';
import { SemanticStore } from '../semantic-store.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-semantic-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('LocalVectorRouter', () => {
  it('fences project search and writes before a pending removal can open or recreate vectors.db', async () => {
    const root = freshDir();
    const central = new Database(':memory:');
    semanticIndexing227.up(central);
    const semantic = new SemanticStore(central);
    const target = {
      kind: 'onnx' as const,
      model: 'test',
      pooling: 'mean' as const,
      normalize: true,
      queryTemplate: '{text}',
      documentTemplate: '{text}',
    };
    semantic.upsertProfile({
      purpose: 'code', embedding_target: target, reranker_target: { kind: 'disabled' },
    });
    const generation = semantic.createGeneration({
      purpose: 'code', fingerprint: 'test', embedding_target: target, dimension: 2,
    });
    semantic.updateGeneration(generation.id, { status: 'ready' });
    semantic.beginNamespaceGeneration({
      namespace: 'code:p17', purpose: 'code', generation_id: generation.id, expected_items: 0,
    });
    semantic.activateNamespaceGeneration('code:p17', generation.id);
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
      semanticStore: semantic,
    });
    const vectorPath = router.resolve('code:p17', generation.id).dbPath;
    try {
      semantic.requestProjectRemoval({ projectId: 17, requestedBy: 'cli', finalizeProject: true });

      expect(router.resolveForRead('code:p17')).toBeNull();
      expect(router.resolveForWrite('code:p17')).toBeNull();
      await expect(router.search('code:p17', generation.id, [1, 0])).resolves.toEqual([]);
      expect(() => router.upsert('code:p17', generation.id, [{
        id: 'late', values: [1, 0], metadata: { type: 'file', ref_id: '1' },
      }])).toThrow(expect.objectContaining({ code: 'PROJECT_SEMANTIC_REMOVAL_PENDING' }));
      expect(router.pool.size).toBe(0);
      expect(existsSync(vectorPath)).toBe(false);
    } finally {
      await router.drainAndClose();
      semantic.close();
      central.close();
    }
  });

  it('uses active generation for reads and building generation for writes', async () => {
    const root = freshDir();
    const state: {
      namespace: string; purpose: 'code'; active_generation_id: number | null;
      building_generation_id: number | null; expected_items: number; indexed_items: number;
      failed_items: number; delta_items: number; last_error: string | null; updated_at: string;
    } = {
      namespace: 'code:p9', purpose: 'code' as const,
      active_generation_id: 1, building_generation_id: 2,
      expected_items: 2, indexed_items: 1, failed_items: 0, delta_items: 0,
      last_error: null, updated_at: '2026-01-01 00:00:00',
    };
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
      semanticStore: { listNamespaceGenerations: () => [state] },
    });
    try {
      const facade = router.asVectorStore();
      await facade.upsert([{ id: 'building', values: [1, 0], metadata: { type: 'file' } }], 'code:p9');
      await router.upsert('code:p9', 1, [{ id: 'active', values: [1, 0], metadata: { type: 'file' } }]);
      const read = await facade.search([1, 0], { namespace: 'code:p9' });
      expect(read.map((match) => match.id)).toEqual(['active']);
      expect((await router.search('code:p9', 2, [1, 0])).map((match) => match.id)).toEqual(['building']);
      // The query vector was embedded while g1 was active. Even if g2 activates
      // before search, the explicit read pin must not resolve the active pointer
      // a second time and silently switch vector spaces.
      const pinnedGeneration = state.active_generation_id!;
      state.active_generation_id = 2;
      state.building_generation_id = null;
      expect((await facade.search([1, 0], {
        namespace: 'code:p9', generationId: pinnedGeneration,
      })).map((match) => match.id)).toEqual(['active']);
      expect((await facade.search([1, 0], { namespace: 'code:p9' })).map((match) => match.id))
        .toEqual(['building']);
      expect(router.getNamespaceStatus('code:p9').active?.tableName).toBe('code_g_2');
    } finally {
      await router.drainAndClose();
    }
  });

  it('reads namespace state once for a batched diagnostics snapshot', () => {
    const root = freshDir();
    const state = {
      namespace: 'code:p9', purpose: 'code' as const,
      active_generation_id: 2, building_generation_id: null,
      expected_items: 2, indexed_items: 2, failed_items: 0, delta_items: 0,
      last_error: null, updated_at: '2026-01-01 00:00:00',
    };
    const listNamespaceGenerations = vi.fn(() => [state]);
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
      semanticStore: { listNamespaceGenerations },
    });

    const statuses = router.getNamespaceStatuses([
      'code:p9',
      'snapshot:p9',
      'memory:project:p9',
    ]);

    expect(statuses.map((status) => status.namespace)).toEqual([
      'code:p9',
      'snapshot:p9',
      'memory:project:p9',
    ]);
    expect(statuses[0].active?.tableName).toBe('code_g_2');
    expect(new Set(statuses.map((status) => status.size_bytes)).size).toBe(1);
    expect(listNamespaceGenerations).toHaveBeenCalledTimes(1);
  });

  it('routes project memory and global docs/memory scopes to separate DBs', () => {
    const root = freshDir();
    const dataDir = freshDir();
    const router = new LocalVectorRouter({
      dataDir,
      resolveProject: (id) => id === 7 ? { id, rootPath: root } : null,
    });
    try {
      const code = router.resolve('code:p7', 10);
      const snapshot = router.resolve('snapshot:p7', 20);
      const projectMemory = router.resolve('memory:project:p7', 20);
      const docs = router.resolve('docs:c4', 20);
      const userMemory = router.resolve('memory:user', 20);

      expect(code.dbPath).toBe(join(root, '.mcp-indexer', 'vectors.db'));
      expect(snapshot.dbPath).toBe(code.dbPath);
      expect(projectMemory.dbPath).toBe(code.dbPath);
      expect(code.tableName).toBe('code_g_10');
      expect(snapshot.tableName).toBe('memory_g_20');
      expect(docs.dbPath).toBe(globalSemanticVectorPaths(dataDir).docs);
      expect(userMemory.dbPath).toBe(globalSemanticVectorPaths(dataDir).userMemory);
      expect(docs.dbPath).not.toBe(userMemory.dbPath);
      expect(() => router.resolve('code:renamed-project', 1)).toThrow(/Unsupported/);
    } finally {
      router.close();
    }
  });

  it('stores different dimensions in generation tables and isolates physical DBs', async () => {
    const root = freshDir();
    const dataDir = freshDir();
    const router = new LocalVectorRouter({ dataDir, resolveProject: (id) => ({ id, rootPath: root }) });
    try {
      await router.upsert('code:p1', 1, [{ id: 'a', values: [1, 0, 0], metadata: { type: 'file' } }]);
      await router.upsert('snapshot:p1', 2, [{ id: 's', values: [1, 0, 0, 0], metadata: { type: 'snapshot' } }]);
      await router.upsert('docs:c3', 2, [{ id: 'd', values: [1, 0, 0, 0], metadata: { type: 'doc_chunk' } }]);
      await router.upsert('memory:user', 2, [{ id: 'm', values: [1, 0, 0, 0], metadata: { type: 'memory' } }]);

      expect((await router.search('code:p1', 1, [1, 0, 0]))[0].id).toBe('a');
      expect((await router.search('snapshot:p1', 2, [1, 0, 0, 0]))[0].id).toBe('s');
      expect((await router.search('docs:c3', 2, [1, 0, 0, 0]))[0].id).toBe('d');
      await expect(router.listIds('code:p1', 1)).resolves.toEqual(['a']);
      await expect(router.listIds('docs:c3', 2)).resolves.toEqual(['d']);
      expect(existsSync(globalSemanticVectorPaths(dataDir).docs)).toBe(true);
      expect(existsSync(globalSemanticVectorPaths(dataDir).userMemory)).toBe(true);
    } finally {
      await router.drainAndClose();
    }
  });

  it('drops and compacts an old project generation without touching the active table', async () => {
    const root = freshDir();
    const router = new LocalVectorRouter({ resolveProject: (id) => ({ id, rootPath: root }) });
    try {
      await router.upsert('code:p1', 3, Array.from({ length: 128 }, (_, index) => ({
        id: `old-${index}`,
        values: [1, 0, 0, 0],
        metadata: { type: 'symbol_body', ref_id: String(index) },
      })));
      await router.upsert('code:p1', 4, [{
        id: 'active',
        values: [1, 0, 0, 0],
        metadata: { type: 'symbol', ref_id: 'active' },
      }]);

      await expect(router.hasGeneration('code:p1', 3)).resolves.toBe(true);
      await expect(router.hasGeneration('code:p1', 4)).resolves.toBe(true);

      await router.dropGeneration('code:p1', 3);
      await expect(router.hasGeneration('code:p1', 3)).resolves.toBe(false);
      await expect(router.hasGeneration('code:p1', 4)).resolves.toBe(true);

      const compacted = await router.compactGenerationDatabase('code:p1', 3);
      expect(compacted.after_bytes).toBeLessThanOrEqual(compacted.before_bytes);
      await expect(router.listIds('code:p1', 4)).resolves.toEqual(['active']);
    } finally {
      await router.drainAndClose();
    }
  });

  it('uses the stable per-id fallback and evicts LRU/idle physical handles', () => {
    const dataDir = freshDir();
    let now = 0;
    const evicted: string[] = [];
    const pool = new ProjectVectorStorePool({ maxOpen: 2, idleTtlMs: 50, now: () => now, onEvict: (path) => evicted.push(path) });
    const router = new LocalVectorRouter({
      dataDir, env: { MCP_DATA_DIR: dataDir }, forceProjectFallback: true, pool,
      resolveProject: (id) => ({ id, rootPath: join(dataDir, `root-${id}`) }),
    });
    try {
      const first = router.resolve('code:p1', 1);
      const second = router.resolve('code:p2', 1);
      expect(first.dbPath).toBe(join(dataDir, 'projects-db', 'p1', 'vectors.db'));
      router.store('code:p1', 1);
      router.store('code:p2', 1);
      router.store('code:p1', 1); // refresh p1 so p2 becomes least-recently used
      router.store('code:p3', 1);
      expect(pool.size).toBe(2);
      expect(pool.has(first.dbPath)).toBe(true);
      expect(pool.has(second.dbPath)).toBe(false);
      now = 100;
      pool.sweepIdle();
      expect(pool.size).toBe(0);
      expect(evicted.length).toBe(3);
    } finally {
      router.close();
    }
  });

  it('falls back when the project root cannot host .mcp-indexer', () => {
    const dataDir = freshDir();
    const invalidRoot = join(freshDir(), 'root-is-a-file');
    writeFileSync(invalidRoot, 'not a directory');
    const router = new LocalVectorRouter({
      dataDir,
      env: { MCP_DATA_DIR: dataDir },
      resolveProject: (id) => ({ id, rootPath: invalidRoot }),
    });
    try {
      expect(router.resolve('code:p6', 1).dbPath)
        .toBe(join(dataDir, 'projects-db', 'p6', 'vectors.db'));
    } finally {
      router.close();
    }
  });

  it('serializes writes to the same physical DB', async () => {
    const dir = freshDir();
    const path = join(dir, 'vectors.db');
    const pool = new ProjectVectorStorePool();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = pool.write(path, 'code_g_1', async () => {
      order.push('first:start');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push('first:end');
    });
    const second = pool.write(path, 'memory_g_2', () => { order.push('second'); });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    await pool.drainAndCloseAll();
  });

  it('allows writes to distinct physical DBs to progress concurrently', async () => {
    const dir = freshDir();
    const pool = new ProjectVectorStorePool();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = pool.write(join(dir, 'a.db'), 'code_g_1', async () => {
      started.push('a');
      await gate;
    });
    const second = pool.write(join(dir, 'b.db'), 'code_g_1', async () => {
      started.push('b');
      await gate;
    });
    await vi.waitFor(() => expect(started.sort()).toEqual(['a', 'b']));
    release();
    await Promise.all([first, second]);
    await pool.drainAndCloseAll();
  });

  it('never exceeds maxOpen when every existing handle is busy', async () => {
    const dir = freshDir();
    const firstPath = join(dir, 'first.db');
    const secondPath = join(dir, 'second.db');
    const pool = new ProjectVectorStorePool({ maxOpen: 1 });
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = pool.read(firstPath, 'code_g_1', async () => {
      firstStarted();
      await gate;
      return true;
    });
    await started;

    expect(() => pool.read(secondPath, 'code_g_1', (store) => store.isAvailable()))
      .toThrow(ProjectVectorStorePoolSaturatedError);
    expect(pool.size).toBe(1);
    expect(pool.has(firstPath)).toBe(true);
    expect(pool.has(secondPath)).toBe(false);
    expect(existsSync(secondPath)).toBe(false);

    releaseFirst();
    await first;
    await expect(pool.read(secondPath, 'code_g_1', (store) => store.isAvailable()))
      .resolves.toBe(true);
    expect(pool.size).toBe(1);
    expect(pool.has(firstPath)).toBe(false);
    expect(pool.has(secondPath)).toBe(true);
    await pool.drainAndCloseAll();
  });

  it('waits for reads before checkpointing and evicting a physical DB', async () => {
    const dir = freshDir();
    const path = join(dir, 'vectors.db');
    const pool = new ProjectVectorStorePool();
    let readStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const read = pool.read(path, 'code_g_1', async () => {
      readStarted();
      await gate;
    });
    await started;
    const eviction = pool.drainAndEvict(path);
    await Promise.resolve();
    expect(pool.has(path)).toBe(true);
    releaseRead();
    await read;
    await expect(eviction).resolves.toBe(true);
    expect(pool.has(path)).toBe(false);
  });

  it('reopens generation tables after checkpoint and truncates the WAL', async () => {
    const root = freshDir();
    const createRouter = () => new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
    });
    const first = createRouter();
    const path = first.resolve('code:p1', 3).dbPath;
    await first.upsert('code:p1', 3, [{
      id: 'persisted', values: [1, 0, 0], metadata: { type: 'file' },
    }]);
    await first.drainAndClose();
    expect(!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0).toBe(true);

    const reopened = createRouter();
    try {
      await expect(reopened.search('code:p1', 3, [1, 0, 0]))
        .resolves.toEqual([expect.objectContaining({ id: 'persisted' })]);
    } finally {
      await reopened.drainAndClose();
    }
  });

  it('recovers committed vectors after a writer process crashes with WAL open', async () => {
    const root = freshDir();
    const dbDir = join(root, '.mcp-indexer');
    const path = join(dbDir, 'vectors.db');
    const script = String.raw`
      const fs = require('node:fs');
      const path = require('node:path');
      const Database = require('better-sqlite3');
      const sqliteVec = require('sqlite-vec');
      const dbPath = process.argv[1];
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('wal_autocheckpoint = 0');
      sqliteVec.load(db);
      db.exec('CREATE VIRTUAL TABLE code_g_7 USING vec0(vid TEXT PRIMARY KEY, embedding float[2], namespace TEXT, project_name TEXT, type TEXT, ref_id TEXT)');
      db.prepare('INSERT INTO code_g_7(vid, embedding, namespace, project_name, type, ref_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run('after-crash', new Float32Array([1, 0]), 'code:p1', '', 'file', '1');
      process.stdout.write('READY\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, path], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.stdout?.on('data', (chunk) => {
          if (String(chunk).includes('READY')) resolve();
        });
        child.once('exit', (code) => reject(new Error(`crash fixture exited ${code}: ${stderr}`)));
      }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`crash fixture timeout: ${stderr}`)), 10_000)),
    ]);
    child.kill();
    await once(child, 'exit');
    expect(existsSync(`${path}-wal`)).toBe(true);

    const router = new LocalVectorRouter({ resolveProject: (id) => ({ id, rootPath: root }) });
    try {
      await expect(router.search('code:p1', 7, [1, 0]))
        .resolves.toEqual([expect.objectContaining({ id: 'after-crash' })]);
    } finally {
      await router.drainAndClose();
    }
  }, 20_000);

  it('keeps project vectors stable across rename and removes only that project DB', async () => {
    const root = freshDir();
    const dataDir = freshDir();
    let projectName = 'before';
    const removedNamespaces: string[] = [];
    const router = new LocalVectorRouter({
      dataDir,
      resolveProject: (id) => ({ id, rootPath: root, name: projectName }),
      semanticStore: {
        listNamespaceGenerations: () => [],
        deleteNamespace: (namespace) => {
          removedNamespaces.push(namespace);
          return { items: 0, jobs: 0, namespace: 1 };
        },
      },
    });
    const projectPath = router.resolve('code:p12', 1).dbPath;
    await router.upsert('code:p12', 1, [{ id: 'code', values: [1, 0], metadata: { type: 'file' } }]);
    await router.upsert('docs:c4', 1, [{ id: 'doc', values: [1, 0], metadata: { type: 'doc_chunk' } }]);
    await router.upsert('memory:user', 1, [{ id: 'memory', values: [1, 0], metadata: { type: 'memory' } }]);
    const globals = globalSemanticVectorPaths(dataDir);
    projectName = 'after';
    expect(router.resolve('code:p12', 1).dbPath).toBe(projectPath);

    await router.removeProject(12);
    expect(existsSync(projectPath)).toBe(false);
    expect(existsSync(globals.docs)).toBe(true);
    expect(existsSync(globals.userMemory)).toBe(true);
    expect(removedNamespaces).toEqual([
      'code:p12', 'snapshot:p12', 'memory:project:p12',
    ]);
    expect((await router.search('docs:c4', 1, [1, 0]))[0].id).toBe('doc');
    expect((await router.search('memory:user', 1, [1, 0]))[0].id).toBe('memory');
    await router.drainAndClose();
  });

  it('opens only the requested project for a common search', async () => {
    const firstRoot = freshDir();
    const secondRoot = freshDir();
    const resolveProject = (id: number) => ({ id, rootPath: id === 1 ? firstRoot : secondRoot });
    const writer = new LocalVectorRouter({ resolveProject });
    await writer.upsert('code:p1', 1, [{ id: 'one', values: [1, 0], metadata: { type: 'file' } }]);
    await writer.upsert('code:p2', 1, [{ id: 'two', values: [0, 1], metadata: { type: 'file' } }]);
    await writer.drainAndClose();

    const reader = new LocalVectorRouter({ resolveProject });
    try {
      expect((await reader.search('code:p1', 1, [1, 0]))[0].id).toBe('one');
      expect(reader.pool.openPaths).toEqual([join(firstRoot, '.mcp-indexer', 'vectors.db')]);
    } finally {
      await reader.drainAndClose();
    }
  });

  it('caps multi-project fan-out at four concurrent reads', async () => {
    const root = freshDir();
    const router = new LocalVectorRouter({ resolveProject: (id) => ({ id, rootPath: root }) });
    let active = 0;
    let maxActive = 0;
    vi.spyOn(router, 'search').mockImplementation(async (namespace) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [{ id: namespace, score: Number(namespace.match(/\d+$/)?.[0] ?? 0), metadata: {} }];
    });
    const targets = Array.from({ length: 12 }, (_, index) => ({
      namespace: `code:p${index + 1}`,
      generationId: 1,
    }));
    const matches = await router.searchMany(targets, [1, 0], { concurrency: 99, topK: 12 });
    expect(maxActive).toBe(4);
    expect(matches).toHaveLength(12);
    expect(matches[0].score).toBe(12);
    router.close();
  });

  it('performs vector CRUD locally without HTTP', async () => {
    const root = freshDir();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const router = new LocalVectorRouter({ resolveProject: (id) => ({ id, rootPath: root }) });
    try {
      await router.upsert('code:p1', 1, [{ id: 'local', values: [1, 0], metadata: { type: 'file' } }]);
      await router.search('code:p1', 1, [1, 0]);
      await router.deleteByIds('code:p1', 1, ['local']);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await router.drainAndClose();
    }
  });

  it('accepts only the generation target selected by the current profile', async () => {
    const root = freshDir();
    const central = new Database(':memory:');
    semanticIndexing227.up(central);
    const semantic = new SemanticStore(central);
    const oldTarget = {
      kind: 'onnx' as const,
      model: 'old-model',
      pooling: 'mean' as const,
      normalize: true,
      queryTemplate: 'query: {text}',
      documentTemplate: 'passage: {text}',
    };
    const selectedTarget = {
      kind: 'onnx' as const,
      model: 'selected-model',
      pooling: 'mean' as const,
      normalize: true,
      queryTemplate: 'query: {text}',
      documentTemplate: 'passage: {text}',
    };
    const reorderedSelectedTarget = {
      documentTemplate: 'passage: {text}',
      queryTemplate: 'query: {text}',
      normalize: true,
      pooling: 'mean' as const,
      model: 'selected-model',
      kind: 'onnx' as const,
    };
    const futureTarget = { ...selectedTarget, model: 'future-model' };
    semantic.upsertProfile({
      purpose: 'code', embedding_target: oldTarget, reranker_target: { kind: 'disabled' },
    });
    const active = semantic.createGeneration({
      purpose: 'code', fingerprint: 'old', embedding_target: oldTarget, dimension: 2,
    });
    semantic.beginNamespaceGeneration({
      namespace: 'code:p1', purpose: 'code', generation_id: active.id, expected_items: 1,
    });
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
      semanticStore: semantic,
    });
    const facade = router.asVectorStore();
    try {
      await facade.upsert([{
        id: 'old', values: [1, 0], metadata: { type: 'file', ref_id: 'old' },
      }], 'code:p1');
      semantic.updateNamespaceProgress('code:p1', { indexed_items: 1 });
      semantic.activateNamespaceGeneration('code:p1', active.id);

      // Equal dimensions are deliberately used throughout: dimension checks
      // alone cannot keep different model spaces out of the active table.
      semantic.upsertProfile({
        purpose: 'code', embedding_target: selectedTarget, reranker_target: { kind: 'disabled' },
      });
      await expect(facade.upsert([{
        id: 'wrong-active', values: [0, 1], metadata: { type: 'file', ref_id: 'wrong-active' },
      }], 'code:p1')).rejects.toMatchObject({
        code: 'SEMANTIC_EMBEDDING_TARGET_MISMATCH',
      });
      await expect(router.listIds('code:p1', active.id)).resolves.toEqual(['old']);

      const building = semantic.createGeneration({
        purpose: 'code', fingerprint: 'selected:rebuild:1784102400000:a1b2c3',
        embedding_target: reorderedSelectedTarget, dimension: 2,
      });
      semantic.beginNamespaceGeneration({
        namespace: 'code:p1', purpose: 'code', generation_id: building.id, expected_items: 2,
      });

      // This batch began against g1 before the profile rollout. Its explicit
      // pin must keep the old-model vector in g1 even though an equal-sized g2
      // is now the default write route.
      await expect(facade.upsert([{
        id: 'old-batch', values: [1, 0],
        metadata: { type: 'file', ref_id: 'old-batch' },
      }], 'code:p1', {
        generationId: active.id,
        generationFingerprint: active.fingerprint,
        embeddingFingerprint: 'old',
        embeddingTarget: oldTarget,
      })).resolves.toBe(1);
      await expect(router.listIds('code:p1', active.id))
        .resolves.toEqual(expect.arrayContaining(['old', 'old-batch']));
      await expect(router.listIds('code:p1', building.id)).resolves.not.toContain('old-batch');

      await expect(facade.upsert([{
        id: 'matching-building', values: [0, 1],
        metadata: { type: 'file', ref_id: 'matching-building' },
      }], 'code:p1')).resolves.toBe(1);
      await expect(facade.upsert([{
        id: 'forced-pin', values: [0, 1],
        metadata: { type: 'file', ref_id: 'forced-pin' },
      }], 'code:p1', {
        generationId: building.id,
        generationFingerprint: building.fingerprint,
        embeddingFingerprint: 'selected',
        embeddingTarget: selectedTarget,
      })).resolves.toBe(1);
      await expect(facade.upsert([{
        id: 'ambiguous-pin', values: [0, 1],
        metadata: { type: 'file', ref_id: 'ambiguous-pin' },
      }], 'code:p1', {
        generationId: building.id,
        generationFingerprint: building.fingerprint,
        embeddingFingerprint: 'select',
        embeddingTarget: selectedTarget,
      })).rejects.toMatchObject({ code: 'SEMANTIC_EMBEDDING_TARGET_MISMATCH' });

      // Hold the file queue after the request is accepted by the facade. The
      // guard must observe a profile edit made while that write is waiting,
      // not merely the profile that existed when upsert() was called.
      const route = router.resolve('code:p1', building.id);
      let markStarted!: () => void;
      let releaseWrite!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const blocker = router.pool.write(route.dbPath, route.tableName, async () => {
        markStarted();
        await gate;
      });
      await started;
      const queuedRejection = expect(facade.upsert([{
        id: 'wrong-mid-build', values: [1, 1],
        metadata: { type: 'file', ref_id: 'wrong-mid-build' },
      }], 'code:p1')).rejects.toMatchObject({
        code: 'SEMANTIC_EMBEDDING_TARGET_MISMATCH',
      });
      semantic.upsertProfile({
        purpose: 'code', embedding_target: futureTarget, reranker_target: { kind: 'disabled' },
      });
      releaseWrite();
      await blocker;
      await queuedRejection;
      await expect(router.listIds('code:p1', building.id)).resolves.toEqual(
        expect.arrayContaining(['matching-building', 'forced-pin']),
      );

      semantic.upsertProfile({
        purpose: 'code', embedding_target: { kind: 'disabled' }, reranker_target: { kind: 'disabled' },
      });
      await expect(facade.upsert([{
        id: 'disabled', values: [1, 0], metadata: { type: 'file', ref_id: 'disabled' },
      }], 'code:p1')).rejects.toThrow(/profile code is disabled/);
    } finally {
      await router.drainAndClose();
      semantic.close();
      central.close();
    }
  });

  it('keeps semantic_items authoritative across success, failure, retry and delete', async () => {
    const root = freshDir();
    const central = new Database(':memory:');
    semanticIndexing227.up(central);
    const semantic = new SemanticStore(central);
    const generation = semantic.createGeneration({
      purpose: 'code', fingerprint: 'test',
      embedding_target: {
        kind: 'onnx', model: 'test', pooling: 'mean', normalize: true,
        queryTemplate: '{text}', documentTemplate: '{text}',
      },
      dimension: 2,
    });
    semantic.upsertProfile({
      purpose: 'code', embedding_target: generation.embedding_target,
      reranker_target: { kind: 'disabled' },
    });
    semantic.updateGeneration(generation.id, { status: 'ready' });
    semantic.beginNamespaceGeneration({
      namespace: 'code:p1', purpose: 'code', generation_id: generation.id, expected_items: 1,
    });
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
      semanticStore: semantic,
    });
    const record = {
      id: 'file-1', values: [1, 0],
      metadata: { type: 'file', ref_id: '1', embedding_hash: 'hash-1' },
    };
    try {
      await router.upsert('code:p1', generation.id, [record]);
      expect(semantic.listItems({ generation_id: generation.id })[0]).toMatchObject({
        item_key: 'file:1', source_hash: 'hash-1', status: 'indexed', attempts: 1,
      });

      await expect(router.upsert('code:p1', generation.id, [{
        ...record, values: [Number.NaN, 0], metadata: { ...record.metadata, embedding_hash: 'hash-2' },
      }])).rejects.toThrow(/non-finite/);
      expect(semantic.listItems({ generation_id: generation.id })[0]).toMatchObject({
        source_hash: 'hash-2', vector_id: null, status: 'failed', attempts: 2,
      });

      await router.upsert('code:p1', generation.id, [{
        ...record, metadata: { ...record.metadata, embedding_hash: 'hash-2' },
      }]);
      expect(semantic.listItems({ generation_id: generation.id })[0]).toMatchObject({
        vector_id: 'file-1', status: 'indexed', attempts: 3, error: null,
      });
      await router.deleteByIds('code:p1', generation.id, ['file-1']);
      expect(semantic.listItems({ generation_id: generation.id })).toEqual([]);
    } finally {
      await router.drainAndClose();
      semantic.close();
      central.close();
    }
  });

  it('deletes by semantic item key from active and building generations', async () => {
    const root = freshDir();
    const central = new Database(':memory:');
    semanticIndexing227.up(central);
    const semantic = new SemanticStore(central);
    const target = {
      kind: 'onnx' as const,
      model: 'test',
      pooling: 'mean' as const,
      normalize: true,
      queryTemplate: '{text}',
      documentTemplate: '{text}',
    };
    semantic.upsertProfile({
      purpose: 'code', embedding_target: target, reranker_target: { kind: 'disabled' },
    });
    const active = semantic.createGeneration({
      purpose: 'code', fingerprint: 'active', embedding_target: target, dimension: 2,
    });
    semantic.updateGeneration(active.id, { status: 'ready' });
    semantic.beginNamespaceGeneration({
      namespace: 'code:p1', purpose: 'code', generation_id: active.id, expected_items: 1,
    });
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: root }),
      semanticStore: semantic,
    });
    try {
      const record = {
        id: 'file-1', values: [1, 0],
        metadata: { type: 'file', ref_id: '1', embedding_hash: 'hash-1' },
      };
      await router.upsert('code:p1', active.id, [record]);
      semantic.updateNamespaceProgress('code:p1', { indexed_items: 1 });
      semantic.activateNamespaceGeneration('code:p1', active.id);

      const building = semantic.createGeneration({
        purpose: 'code', fingerprint: 'building', embedding_target: target, dimension: 2,
      });
      semantic.updateGeneration(building.id, { status: 'ready' });
      semantic.beginNamespaceGeneration({
        namespace: 'code:p1', purpose: 'code', generation_id: building.id, expected_items: 1,
      });
      await router.asVectorStore().upsert([{
        ...record,
        id: 'file-1-new',
        metadata: { ...record.metadata, embedding_hash: 'hash-2' },
      }], 'code:p1');

      expect(await router.asVectorStore().deleteByItemKeys?.(['file:1'], 'code:p1')).toBe(2);
      expect(semantic.listItems({ generation_id: building.id, namespace: 'code:p1' })).toEqual([]);
      expect(semantic.listItems({ generation_id: active.id, namespace: 'code:p1' })).toEqual([]);
      expect(await router.asVectorStore().search([1, 0], { namespace: 'code:p1' })).toEqual([]);
    } finally {
      await router.drainAndClose();
      semantic.close();
      central.close();
    }
  });

  it('removes docs generations only when no collection shares the physical table', async () => {
    const dataDir = freshDir();
    const central = new Database(':memory:');
    semanticIndexing227.up(central);
    const semantic = new SemanticStore(central);
    const target = {
      kind: 'onnx' as const, model: 'test', pooling: 'mean' as const,
      normalize: true, queryTemplate: '{text}', documentTemplate: '{text}',
    };
    semantic.upsertProfile({
      purpose: 'docs', embedding_target: target, reranker_target: { kind: 'disabled' },
    });
    const active = semantic.createGeneration({
      purpose: 'docs', fingerprint: 'active', embedding_target: target, dimension: 2,
    });
    semantic.updateGeneration(active.id, { status: 'ready' });
    semantic.beginNamespaceGeneration({
      namespace: 'docs:c41', purpose: 'docs', generation_id: active.id, expected_items: 1,
    });
    semantic.updateNamespaceProgress('docs:c41', { indexed_items: 1 });
    semantic.activateNamespaceGeneration('docs:c41', active.id);
    semantic.beginNamespaceGeneration({
      namespace: 'docs:c42', purpose: 'docs', generation_id: active.id, expected_items: 1,
    });
    semantic.updateNamespaceProgress('docs:c42', { indexed_items: 1 });
    semantic.activateNamespaceGeneration('docs:c42', active.id);
    const building = semantic.createGeneration({
      purpose: 'docs', fingerprint: 'building', embedding_target: target, dimension: 2,
    });
    semantic.updateGeneration(building.id, { status: 'ready' });
    semantic.beginNamespaceGeneration({
      namespace: 'docs:c41', purpose: 'docs', generation_id: building.id, expected_items: 1,
    });
    const router = new LocalVectorRouter({
      dataDir, resolveProject: () => null, semanticStore: semantic,
    });
    try {
      const record = {
        id: 'doc_chunk:9', values: [1, 0],
        metadata: { type: 'doc_chunk', chunk_id: '9', embedding_hash: 'hash-9' },
      };
      await router.upsert('docs:c41', active.id, [record]);
      await router.upsert('docs:c41', building.id, [record]);
      await router.upsert('docs:c42', active.id, [{
        ...record,
        id: 'doc_chunk:10',
        metadata: { ...record.metadata, chunk_id: '10', embedding_hash: 'hash-10' },
      }]);

      await expect(router.asVectorStore().deleteNamespace?.('docs:c41')).resolves.toBe(2);
      expect(semantic.listNamespaceGenerations({ namespace: 'docs:c41' })).toEqual([]);
      expect(semantic.listItems({ generation_id: active.id, namespace: 'docs:c41' })).toEqual([]);
      expect(semantic.listItems({ generation_id: active.id, namespace: 'docs:c42' })).toHaveLength(1);
      expect(semantic.listItems({ generation_id: building.id, namespace: 'docs:c41' })).toEqual([]);
      await expect(router.search('docs:c42', active.id, [1, 0]))
        .resolves.toEqual([expect.objectContaining({ id: 'doc_chunk:10' })]);
      const physical = new Database(globalSemanticVectorPaths(dataDir).docs);
      try {
        const tables = physical.prepare(
          `SELECT name FROM sqlite_master WHERE name IN (?, ?)`,
        ).all(`docs_g_${active.id}`, `docs_g_${building.id}`) as Array<{ name: string }>;
        expect(tables.map((row) => row.name)).toEqual([`docs_g_${active.id}`]);
      } finally {
        physical.close();
      }

      await expect(router.asVectorStore().deleteNamespace?.('docs:c42')).resolves.toBe(1);
      const afterLastCollection = new Database(globalSemanticVectorPaths(dataDir).docs);
      try {
        expect(afterLastCollection.prepare(
          `SELECT name FROM sqlite_master WHERE name = ?`,
        ).get(`docs_g_${active.id}`)).toBeUndefined();
      } finally {
        afterLastCollection.close();
      }
    } finally {
      await router.drainAndClose();
      semantic.close();
      central.close();
    }
  });

  it('drops a project table even when another physical DB uses the same generation id', async () => {
    const firstRoot = freshDir();
    const secondRoot = freshDir();
    const central = new Database(':memory:');
    semanticIndexing227.up(central);
    const semantic = new SemanticStore(central);
    const target = {
      kind: 'onnx' as const, model: 'test', pooling: 'mean' as const,
      normalize: true, queryTemplate: '{text}', documentTemplate: '{text}',
    };
    semantic.upsertProfile({
      purpose: 'code', embedding_target: target, reranker_target: { kind: 'disabled' },
    });
    const generation = semantic.createGeneration({
      purpose: 'code', fingerprint: 'shared-id', embedding_target: target, dimension: 2,
    });
    semantic.updateGeneration(generation.id, { status: 'ready' });
    for (const namespace of ['code:p1', 'code:p2']) {
      semantic.beginNamespaceGeneration({
        namespace, purpose: 'code', generation_id: generation.id, expected_items: 1,
      });
    }
    const router = new LocalVectorRouter({
      resolveProject: (id) => ({ id, rootPath: id === 1 ? firstRoot : secondRoot }),
      semanticStore: semantic,
    });
    try {
      await router.upsert('code:p1', generation.id, [{
        id: 'first', values: [1, 0], metadata: { type: 'file', ref_id: '1', embedding_hash: 'h1' },
      }]);
      await router.upsert('code:p2', generation.id, [{
        id: 'second', values: [0, 1], metadata: { type: 'file', ref_id: '2', embedding_hash: 'h2' },
      }]);
      for (const namespace of ['code:p1', 'code:p2']) {
        semantic.updateNamespaceProgress(namespace, { indexed_items: 1 });
        semantic.activateNamespaceGeneration(namespace, generation.id);
      }

      await expect(router.asVectorStore().deleteNamespace?.('code:p1')).resolves.toBe(1);

      const firstDb = new Database(router.resolve('code:p1', generation.id).dbPath);
      try {
        expect(firstDb.prepare(`SELECT name FROM sqlite_master WHERE name = ?`)
          .get(`code_g_${generation.id}`)).toBeUndefined();
      } finally {
        firstDb.close();
      }
      await expect(router.search('code:p2', generation.id, [0, 1]))
        .resolves.toEqual([expect.objectContaining({ id: 'second' })]);
      expect(semantic.listNamespaceGenerations({ namespace: 'code:p1' })).toEqual([]);
      expect(semantic.listNamespaceGenerations({ namespace: 'code:p2' })).toHaveLength(1);
    } finally {
      await router.drainAndClose();
      semantic.close();
      central.close();
    }
  });
});
