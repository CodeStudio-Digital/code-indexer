import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEmbeddingCandidates, type CandidateFile } from '@mcp/indexer/indexer/indexer/embedding-candidates.js';
import { snapshotEmbeddingTextHash } from '@mcp/services/services/snapshots.js';
import { agentMemoryEmbeddingTextHash } from '@mcp/services/memory/agent-memory-service.js';
import { investigationEmbeddingTextHash } from '@mcp/services/memory/investigation-semantic-index.js';
import { buildEmbeddingText, hashEmbeddingInput } from '@mcp/services/services/docs/index.js';

const retryEmbeddingsMock = vi.hoisted(() => vi.fn());

vi.mock('@mcp/indexer/indexer/indexer/embed-retry.js', () => ({
  retryEmbeddings: retryEmbeddingsMock,
  EmbeddingPauseRequestedError: class EmbeddingPauseRequestedError extends Error {
    constructor() {
      super('semantic backfill paused because the project is no longer active');
    }
  },
}));

import { SemanticIndexCoordinator } from '../semantic-index-coordinator.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Generation = {
  id: number;
  purpose: 'code' | 'docs' | 'memory';
  fingerprint: string;
  embedding_target: Record<string, unknown>;
  dimension: number;
  status: 'building' | 'ready' | 'failed' | 'retired';
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  error: string | null;
};

type NamespaceState = {
  namespace: string;
  purpose: 'code' | 'docs' | 'memory';
  active_generation_id: number | null;
  building_generation_id: number | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
};

type Job = {
  id: number;
  generation_id: number | null;
  namespace: string;
  kind: string;
  status: string;
  cursor: Record<string, unknown> | null;
  expected_items: number;
  processed_items: number;
  failed_items: number;
  error: string | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHarness(options: {
  projects?: number[];
  fileCounts?: Record<number, number>;
  vectorItems?: Record<string, number>;
  physicalIds?: Record<string, string[]>;
  semanticItems?: Record<string, Array<{
    item_key: string;
    source_hash: string;
    vector_id: string | null;
    chunk_index: number;
    status: 'indexed' | 'failed';
  }>>;
  symbols?: Record<number, Array<{
    id: number;
    filePath?: string;
    sigHash?: string | null;
    bodyHash?: string | null;
  }>>;
  coverage?: Record<number, { total: number; embedded: number }>;
  docChunks?: Array<{
    id: number;
    heading_path?: string | null;
    content: string;
    api_signature?: string | null;
    embedding_hash?: string | null;
    embedding_fingerprint?: string | null;
  }>;
  existingGeneration?: Generation;
  existingGenerations?: Generation[];
  namespaceStates?: NamespaceState[];
  recoverMutationFences?: (
    prefixes: readonly string[],
    currentOwner: string,
  ) => Promise<number | null>;
} = {}) {
  const projectIds = options.projects ?? [1];
  const fileCounts = options.fileCounts ?? Object.fromEntries(projectIds.map((id) => [id, 1]));
  const vectorItems = options.vectorItems ?? Object.fromEntries(projectIds.map((id) => [`code:p${id}`, fileCounts[id]]));
  const symbols = options.symbols ?? {};
  const generations: Generation[] = (options.existingGenerations
    ?? (options.existingGeneration ? [options.existingGeneration] : [])).map((row) => ({ ...row }));
  const namespaces = new Map((options.namespaceStates ?? []).map((row) => [row.namespace, { ...row }]));
  const jobs = new Map<number, Job>();
  const roots = new Map<number, string>();
  for (const projectId of projectIds) {
    const root = mkdtempSync(join(tmpdir(), 'semantic-coordinator-p' + projectId + '-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    roots.set(projectId, root);
    for (let index = 0; index < (fileCounts[projectId] ?? 0); index++) {
      const filePath = 'src/file-' + (index + 1) + '.ts';
      const symbolRows = (symbols[projectId] ?? []).filter((symbol) =>
        (symbol.filePath ?? 'src/file-1.ts') === filePath);
      const content = symbolRows.length > 0
        ? [
            'export function symbol' + symbolRows[0].id + '(input: number): number {',
            ...Array.from({ length: 90 }, (_, line) => '  input += ' + line + '; // semantic body ' + line),
            '  return input;',
            '}',
          ].join('\n')
        : 'export const file' + (index + 1) + ' = ' + (index + 1) + ';\n';
      writeFileSync(join(root, filePath), content, 'utf-8');
    }
  }
  let nextGenerationId = Math.max(0, ...generations.map((row) => row.id)) + 1;
  let nextJobId = 1;
  let db: any;

  const store = {
    withBusyTimeout: vi.fn((_timeoutMs: number, operation: () => unknown) => operation()),
    getProfile: vi.fn((purpose: 'code' | 'docs' | 'memory'): {
      purpose: 'code' | 'docs' | 'memory';
      embedding_target: { kind: string; model?: string };
      reranker_target: { kind: string };
    } => ({
      purpose,
      embedding_target: { kind: 'onnx', model: `${purpose}-model` },
      reranker_target: { kind: 'disabled' },
    })),
    listGenerations: vi.fn((filter?: { purpose?: string }) => generations
      .filter((row) => !filter?.purpose || row.purpose === filter.purpose)
      .sort((a, b) => b.id - a.id)),
    createGeneration: vi.fn((input: Omit<Generation, 'id' | 'status' | 'indexed_items' | 'failed_items' | 'error'>) => {
      const row: Generation = {
        ...input,
        id: nextGenerationId++,
        status: 'building',
        indexed_items: 0,
        failed_items: 0,
        error: null,
      };
      generations.push(row);
      return row;
    }),
    updateGeneration: vi.fn((id: number, patch: Partial<Generation>) => {
      const row = generations.find((generation) => generation.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }),
    getGeneration: vi.fn((id: number) => generations.find((generation) => generation.id === id) ?? null),
    listNamespaceGenerations: vi.fn((filter?: { namespace?: string; purpose?: string }) => Array.from(namespaces.values())
      .filter((row) => (!filter?.namespace || row.namespace === filter.namespace)
        && (!filter?.purpose || row.purpose === filter.purpose))),
    beginNamespaceGeneration: vi.fn((input: {
      namespace: string;
      purpose: 'code' | 'docs' | 'memory';
      generation_id: number;
      expected_items: number;
    }) => {
      const previous = namespaces.get(input.namespace);
      const row: NamespaceState = {
        namespace: input.namespace,
        purpose: input.purpose,
        active_generation_id: previous?.active_generation_id ?? null,
        building_generation_id: input.generation_id,
        expected_items: input.expected_items,
        indexed_items: 0,
        failed_items: 0,
        delta_items: 0,
        last_error: null,
      };
      namespaces.set(input.namespace, row);
      return row;
    }),
    updateNamespaceProgress: vi.fn((namespace: string, patch: Partial<NamespaceState>) => {
      const row = namespaces.get(namespace);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }),
    clearBuildingGeneration: vi.fn((namespace: string, generationId: number, lastError: string | null = null) => {
      const row = namespaces.get(namespace);
      if (!row || row.building_generation_id !== generationId) return row ?? null;
      row.building_generation_id = null;
      row.delta_items = 0;
      row.last_error = lastError;
      return row;
    }),
    activateNamespaceGeneration: vi.fn((namespace: string, generationId: number) => {
      const row = namespaces.get(namespace);
      if (!row || row.building_generation_id !== generationId) throw new Error('not building');
      if (row.failed_items > 0 || row.delta_items > 0 || row.indexed_items < row.expected_items) {
        throw new Error('incomplete');
      }
      row.active_generation_id = generationId;
      row.building_generation_id = null;
      return row;
    }),
    finishNamespaceMutationPass: vi.fn((input: {
      namespace: string;
      generation_id: number;
      expected_items: number;
      indexed_items: number;
      captured_jobs: Array<{ id: number; expected_items: number }>;
      activate: boolean;
    }) => {
      const row = namespaces.get(input.namespace);
      if (!row) throw new Error('namespace missing');
      const captured = new Map(input.captured_jobs.map((job) => [job.id, job.expected_items]));
      const open = Array.from(jobs.values()).filter((job) =>
        job.namespace === input.namespace
        && ['pending', 'running', 'paused'].includes(job.status)
        && (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null)));
      const acknowledged = open.filter((job) => captured.get(job.id) === job.expected_items);
      const acknowledgedIds = new Set(acknowledged.map((job) => job.id));
      const drained = acknowledged
        .filter((job) => job.kind === 'delta')
        .reduce((sum, job) => sum + job.expected_items, 0);
      for (const job of acknowledged) {
        job.status = 'completed';
        job.processed_items = job.expected_items;
        job.failed_items = 0;
        job.error = null;
      }
      row.expected_items = input.expected_items;
      row.indexed_items = input.indexed_items;
      row.failed_items = 0;
      row.delta_items = Math.max(0, row.delta_items - drained);
      row.last_error = null;
      const pending = row.delta_items > 0 || open.some((job) => !acknowledgedIds.has(job.id));
      let activated = false;
      if (!pending && input.activate) {
        store.activateNamespaceGeneration(input.namespace, input.generation_id);
        activated = true;
      }
      return {
        state: row,
        pending,
        activated,
        completed_job_ids: [...acknowledgedIds],
      };
    }),
    listItems: vi.fn(({ namespace }: { generation_id: number; namespace: string }) => {
      if (options.semanticItems?.[namespace]) return options.semanticItems[namespace];
      if ((vectorItems[namespace] ?? 0) === 0 || !namespace.startsWith('code:p')) return [];
      const projectId = Number(namespace.slice('code:p'.length));
      const project = db.getProject(projectId);
      const files: CandidateFile[] = db.listFiles(projectId).map((file: any) => ({
        path: file.path,
        fileId: file.id,
        language: file.language,
        symbols: db.getSymbolsByFile(projectId, file.path),
        content: readFileSync(join(project.root_path, file.path), 'utf-8'),
      }));
      return buildEmbeddingCandidates(db, project, files, [], 'local:stable-code-model')
        .map((candidate) => ({
          item_key: (candidate.metadata.type ?? 'vector') + ':' + (candidate.metadata.ref_id ?? candidate.id),
          source_hash: candidate.hash,
          vector_id: candidate.id,
          chunk_index: Number(candidate.metadata.chunk_index ?? 0),
          status: 'indexed' as const,
        }));
    }),
    createJob: vi.fn((input: {
      generation_id?: number | null;
      namespace: string;
      kind: string;
      cursor?: Record<string, unknown> | null;
      expected_items?: number;
    }) => {
      const row: Job = {
        id: nextJobId++,
        generation_id: input.generation_id ?? null,
        namespace: input.namespace,
        kind: input.kind,
        status: 'pending',
        cursor: input.cursor ?? null,
        expected_items: input.expected_items ?? 0,
        processed_items: 0,
        failed_items: 0,
        error: null,
      };
      jobs.set(row.id, row);
      return row;
    }),
    noteNamespaceMutation: vi.fn((input: {
      namespace: string;
      itemKeys: string[];
      operation: 'upsert' | 'delete';
      fence?: { token: string; owner: string };
    }) => {
      const state = namespaces.get(input.namespace);
      const row: Job = {
        id: nextJobId++,
        generation_id: state?.building_generation_id ?? state?.active_generation_id ?? null,
        namespace: input.namespace,
        kind: 'delta',
        status: input.fence ? 'running' : 'pending',
        cursor: input.fence ? {
          reason: 'mutation-fence',
          fence_phase: 'in-flight',
          fence_token: input.fence.token,
          fence_owner: input.fence.owner,
        } : { operation: input.operation, item_keys: input.itemKeys },
        expected_items: Math.max(1, input.itemKeys.length),
        processed_items: 0,
        failed_items: 0,
        error: null,
      };
      jobs.set(row.id, row);
      if (state) state.delta_items += row.expected_items;
      return row;
    }),
    settleNamespaceMutationFence: vi.fn((input: { job_id: number; token: string }) => {
      const row = jobs.get(input.job_id);
      if (!row || row.cursor?.fence_token !== input.token) return null;
      row.status = 'pending';
      row.cursor = { ...(row.cursor ?? {}), fence_phase: 'settled' };
      return row;
    }),
    recoverNamespaceMutationFences: vi.fn(() => 0),
    requestProjectRemoval: vi.fn((input: {
      projectId: number;
      requestedBy?: string;
      finalizeProject?: boolean;
    }) => {
      const namespace = `project-removal:p${input.projectId}`;
      const existing = Array.from(jobs.values()).find((row) =>
        row.namespace === namespace
        && row.kind === 'cleanup'
        && row.status !== 'failed'
        && row.status !== 'cancelled');
      if (existing) {
        if (existing.status !== 'running') existing.status = 'pending';
        existing.cursor = {
          ...(existing.cursor ?? {}),
          reason: 'project-removal',
          projectId: input.projectId,
          requested_by: input.requestedBy ?? 'unknown',
          finalize_project: existing.cursor?.finalize_project === true || input.finalizeProject === true,
        };
        return existing;
      }
      const row: Job = {
        id: nextJobId++, generation_id: null, namespace, kind: 'cleanup', status: 'pending',
        cursor: {
          reason: 'project-removal', projectId: input.projectId,
          requested_by: input.requestedBy ?? 'unknown',
          finalize_project: input.finalizeProject === true,
        },
        expected_items: 1, processed_items: 0, failed_items: 0, error: null,
      };
      jobs.set(row.id, row);
      return row;
    }),
    hasProjectRemovalRequest: vi.fn((projectId: number) => Array.from(jobs.values()).some((row) =>
      row.namespace === `project-removal:p${projectId}`
      && row.kind === 'cleanup'
      && row.status !== 'failed'
      && row.status !== 'cancelled')),
    enqueueNamespaceBackfill: vi.fn((input: {
      namespace: string;
      cursor?: Record<string, unknown> | null;
      error?: string | null;
    }) => {
      const existing = Array.from(jobs.values()).find((row) =>
        row.namespace === input.namespace
        && row.generation_id === null
        && row.kind === 'backfill'
        && ['pending', 'running', 'paused'].includes(row.status));
      if (existing) {
        if (existing.status === 'paused') existing.status = 'pending';
        existing.cursor = { ...(existing.cursor ?? {}), ...(input.cursor ?? {}) };
        if (input.error !== undefined) existing.error = input.error;
        return existing;
      }
      const row: Job = {
        id: nextJobId++, generation_id: null, namespace: input.namespace,
        kind: 'backfill', status: 'pending', cursor: input.cursor ?? null,
        expected_items: 0, processed_items: 0, failed_items: 0,
        error: input.error ?? null,
      };
      jobs.set(row.id, row);
      return row;
    }),
    updateJob: vi.fn((id: number, patch: Partial<Job>) => {
      const row = jobs.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }),
    getJob: vi.fn((id: number) => jobs.get(id) ?? null),
    getOrCreateBuildJob: vi.fn((input: any) => {
      const existing = Array.from(jobs.values()).reverse().find((job) =>
        job.namespace === input.namespace && job.generation_id === input.generation_id
        && job.kind === input.kind && ['pending', 'paused'].includes(job.status));
      if (!existing) return store.createJob(input);
      return store.updateJob(existing.id, {
        status: 'pending', expected_items: input.expected_items, processed_items: 0, failed_items: 0,
        error: null, cursor: { ...input.cursor, ...(existing.cursor?.retry ? { retry: existing.cursor.retry } : {}) },
      })!;
    }),
    hasLiveMutationFence: vi.fn((namespace: string) => Array.from(jobs.values()).some((job) =>
      job.namespace === namespace && job.kind === 'delta' && job.status === 'running'
      && job.cursor?.reason === 'mutation-fence' && job.cursor?.fence_phase === 'in-flight')),
    getNamespaceBuildRetry: vi.fn((namespace: string) => Array.from(jobs.values()).reverse()
      .find((job) => job.namespace === namespace && job.status === 'paused'
        && ['build', 'backfill'].includes(job.kind) && job.cursor?.retry)?.cursor?.retry ?? null),
    listProjectRemovalIds: vi.fn(() => Array.from(jobs.values()).filter((job) => job.kind === 'cleanup'
      && !['failed', 'cancelled'].includes(job.status) && job.cursor?.reason === 'project-removal')
      .flatMap((job) => /^project-removal:p\d+$/.test(job.namespace) ? [Number(job.namespace.split(':p')[1])] : [])),
    hasOpenNamespaceMutationJobs: vi.fn((namespace: string) => Array.from(jobs.values()).some((job) =>
      job.namespace === namespace && ['pending', 'paused', 'running'].includes(job.status)
      && (job.kind === 'delta' || (job.kind === 'backfill' && job.generation_id === null)))),
    listJobs: vi.fn((filter?: { namespace?: string; namespacePrefix?: string; generationId?: number | null; limit?: number; status?: string; namespaces?: string[]; statuses?: string[]; kinds?: string[] }) => Array.from(jobs.values())
      .filter((row) => (!filter?.namespace || row.namespace === filter.namespace)
          && (!filter?.namespacePrefix || row.namespace.startsWith(filter.namespacePrefix))
          && (filter?.generationId === undefined || row.generation_id === filter.generationId)
        && (!filter?.status || row.status === filter.status)
        && (!filter?.namespaces || filter.namespaces.includes(row.namespace))
        && (!filter?.statuses || filter.statuses.includes(row.status))
          && (!filter?.kinds || filter.kinds.includes(row.kind))).slice(0, filter?.limit)),
    listGenerationNamespaces: vi.fn((generationId: number) => [...new Set([
      ...Array.from(jobs.values())
        .filter((row) => row.generation_id === generationId)
        .map((row) => row.namespace),
      ...Array.from(namespaces.values())
        .filter((row) => row.active_generation_id === generationId
          || row.building_generation_id === generationId)
        .map((row) => row.namespace),
      ...Object.keys(options.semanticItems ?? {})
        .filter((namespace) => (options.semanticItems?.[namespace] ?? []).length > 0),
    ])]),
    retireUnreferencedGenerations: vi.fn((purpose?: 'code' | 'docs' | 'memory') => {
      const referenced = new Set(Array.from(namespaces.values()).flatMap((row) => [
        row.active_generation_id,
        row.building_generation_id,
      ]));
      let retired = 0;
      for (const generation of generations) {
        if ((!purpose || generation.purpose === purpose)
          && generation.status === 'ready'
          && !referenced.has(generation.id)) {
          generation.status = 'retired';
          retired++;
        }
      }
      return retired;
    }),
    deleteItemsForNamespaceGeneration: vi.fn(() => 0),
    deleteItemsByVectorIds: vi.fn(() => 0),
    deleteNamespace: vi.fn((namespace: string) => {
      let removedJobs = 0;
      for (const [id, job] of jobs) {
        if (job.namespace !== namespace) continue;
        jobs.delete(id);
        removedJobs++;
      }
      const removedNamespace = namespaces.delete(namespace) ? 1 : 0;
      return { items: 0, jobs: removedJobs, namespace: removedNamespace };
    }),
  };

  const embedding = {
    embed: vi.fn(),
    embedQuery: vi.fn(async () => ({ vector: [1, 0, 0], tokens: 1 })),
    fingerprint: vi.fn(() => 'local:stable-code-model'),
  };
  db = {
    countFiles: vi.fn((id: number) => fileCounts[id] ?? 0),
    listProjects: vi.fn(() => projectIds.map((id) => ({ id, is_synthetic: false, root_path: roots.get(id)! }))),
    getProject: vi.fn((id: number) => projectIds.includes(id)
      ? { id, name: `p${id}`, is_synthetic: false, root_path: roots.get(id)! }
      : null),
    listFiles: vi.fn((id: number) => Array.from({ length: fileCounts[id] ?? 0 }, (_, index) => ({
      id: index + 1,
      path: `src/file-${index + 1}.ts`,
      language: 'typescript',
      summary: `Summary ${index + 1}`,
      concepts: '[]',
    }))),
    getFile: vi.fn((id: number, path: string) => {
      const index = /^src\/file-(\d+)\.ts$/.exec(path)?.[1];
      const ordinal = index ? Number(index) : 0;
      if (ordinal < 1 || ordinal > (fileCounts[id] ?? 0)) return undefined;
      return {
        id: ordinal,
        path,
        language: 'typescript',
        summary: `Summary ${ordinal}`,
        concepts: '[]',
      };
    }),
    getSymbolsByFile: vi.fn((projectId: number, filePath: string) => (symbols[projectId] ?? [])
      .filter((symbol) => (symbol.filePath ?? 'src/file-1.ts') === filePath)
      .map((symbol) => ({
        id: symbol.id,
        file_path: filePath,
        name: `symbol${symbol.id}`,
        kind: 'function',
        signature: `function symbol${symbol.id}(input: number): number`,
        comment: null,
        line: 1,
      }))),
    listSnapshotsForSemanticIndex: vi.fn(() => []),
    listAgentMemoryForSemanticIndex: vi.fn(() => []),
    getAgentMemoryById: vi.fn(() => undefined),
    deleteProject: vi.fn(),
  };
  const router = {
    resolve: vi.fn((namespace: string, generationId: number) => {
      const projectMatch = /:p(\d+)$/.exec(namespace);
      const projectId = projectMatch ? Number(projectMatch[1]) : null;
      const purpose = namespace.startsWith('code:')
        ? 'code' as const
        : namespace.startsWith('docs:')
          ? 'docs' as const
          : 'memory' as const;
      const dbPath = namespace.startsWith('docs:')
        ? 'D:/global/semantic/docs-vectors.db'
        : namespace === 'memory:user'
          ? 'D:/global/semantic/memory-vectors.db'
          : `D:/p${projectId}/.mcp-indexer/vectors.db`;
      return {
        namespace,
        generationId,
        purpose,
        scope: namespace.startsWith('code:') ? 'code' : 'project_memory',
        projectId,
        collectionId: null,
        dbPath,
        tableName: `${purpose}_g_${generationId}`,
      };
    }),
    removeProject: vi.fn(),
    dropGeneration: vi.fn(async () => undefined),
  };
  const vectorStore = {
    isAvailable: vi.fn(async () => true),
    deleteByIds: vi.fn(async (ids: string[]) => ids.length),
    deleteByIdsForGeneration: vi.fn(async (_namespace: string, _generationId: number, ids: string[]) => ids.length),
    deleteByItemKeysForGeneration: vi.fn(async (
      _namespace: string,
      _generationId: number,
      itemKeys: string[],
    ) => itemKeys.length),
    removeProject: vi.fn(async (projectId: number) => {
      for (const namespace of [
        `code:p${projectId}`,
        `snapshot:p${projectId}`,
        `memory:project:p${projectId}`,
      ]) store.deleteNamespace(namespace);
    }),
    dropGeneration: vi.fn(async () => undefined),
    dropLegacyKnowledgeTables: vi.fn(async () => 0),
    hasGeneration: vi.fn(async () => true),
    compactGenerationDatabase: vi.fn(async () => ({ before_bytes: 10_000, after_bytes: 4_000 })),
    listIds: vi.fn(async (namespace: string, generationId: number) => {
      if (options.physicalIds?.[namespace]) return options.physicalIds[namespace];
      return store.listItems({ generation_id: generationId, namespace })
        .flatMap((item: { vector_id: string | null }) => item.vector_id ? [item.vector_id] : []);
    }),
  };
  const docStore = {
    listCollections: vi.fn(() => options.docChunks ? [{ id: 2 }] : []),
    listChunksByCollection: vi.fn(() => options.docChunks ?? []),
    countChunksByCollection: vi.fn(() => options.docChunks?.length ?? 0),
  };
  const docsRetryEmbeddings = vi.fn(async () => ({ embedded: 0, tokens: 0, total: 0 }));
  const docsIndexer = {
    retryEmbeddings: docsRetryEmbeddings,
    retryEmbeddingsUnlocked: docsRetryEmbeddings,
  };
  const snapshotService = {
    backfillEmbeddings: vi.fn(async () => ({ embedded: 0, skipped: 0, failed: 0, total: 0 })),
  };
  const agentMemoryService = {
    backfillEmbeddings: vi.fn(async () => ({ embedded: 0, skipped: 0, failed: 0, total: 0 })),
    embedAndUpsert: vi.fn(async () => ({ ok: true })),
  };
  const investigationSemanticIndex = {
    listProject: vi.fn(async (_projectId: number): Promise<Array<Record<string, unknown>>> => []),
    backfillProject: vi.fn(async () => ({ embedded: 0, skipped: 0, failed: 0, total: 0 })),
    embedAndUpsert: vi.fn(async () => ({ ok: true })),
  };
  const deps = {
    db,
    semanticStore: store,
    router,
    vectorStore,
    codeEmbedding: embedding,
    docsEmbedding: embedding,
    memoryEmbedding: embedding,
    costTracker: {},
    lshSink: {},
    snapshotService,
    agentMemoryService,
    investigationSemanticIndex,
    docStore,
    docsIndexer,
    withProjectLock: vi.fn(async (_projectId: number, operation: () => Promise<unknown>) => operation()),
    ...(options.recoverMutationFences
      ? { recoverMutationFences: options.recoverMutationFences }
      : {}),
  };
  const coordinator = new SemanticIndexCoordinator(deps as never);
  return {
    coordinator, store, db, embedding, generations, namespaces, jobs, router,
    vectorStore, docStore, docsIndexer, snapshotService, agentMemoryService,
    investigationSemanticIndex, deps,
  };
}

beforeEach(() => {
  retryEmbeddingsMock.mockReset();
  retryEmbeddingsMock.mockResolvedValue({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });
});

describe('SemanticIndexCoordinator code generations', () => {
  it('keeps docs backfill scans on the worker and coalesces callers until its query finishes', async () => {
    const h = makeHarness({ docChunks: [] });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const query = vi.fn(async () => { await waiting; return []; });
    Object.assign(h.deps, { listJobsOffThread: query });
    h.store.listJobs.mockClear();
    const first = h.coordinator.retryPendingDocsBackfills();
    const second = h.coordinator.retryPendingDocsBackfills();
    expect(second).toBe(first);
    expect(query).toHaveBeenCalledTimes(1);
    expect(h.store.listJobs).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toBe(0);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ namespacePrefix: 'docs:c', generationId: null }));
    expect(h.store.listJobs).not.toHaveBeenCalled();
    await h.coordinator.dispose();
  });

  it('does not reopen a docs job completed while the worker query was in flight', async () => {
    const h = makeHarness({ docChunks: [] });
    const job = h.store.enqueueNamespaceBackfill({ namespace: 'docs:c2', cursor: { collection_id: 2 } });
    const stale = structuredClone(job);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    Object.assign(h.deps, { listJobsOffThread: async () => { await waiting; return [stale]; } });
    h.store.getProfile.mockImplementation((purpose: 'code' | 'docs' | 'memory') => ({
      purpose, embedding_target: { kind: 'disabled' }, reranker_target: { kind: 'disabled' },
    }));
    const retry = h.coordinator.retryPendingDocsBackfills();
    h.store.updateJob(job.id, { status: 'completed' });
    release(); await retry;
    expect(h.store.getJob(job.id)?.status).toBe('completed');
    expect(h.docsIndexer.retryEmbeddings).not.toHaveBeenCalled();
    await h.coordinator.dispose();
  });

  it('automatically starts only the opened project for a local profile', async () => {
    const h = makeHarness({ projects: [1, 2], fileCounts: { 1: 1, 2: 1 } });
    const run = vi.spyOn(h.coordinator, 'reindexCodeProject').mockResolvedValue({
      purpose: 'code', generation_id: 9, completed_namespaces: ['code:p1'], failed_namespaces: [],
    });

    const marker = h.coordinator.activateCodeProject(1);

    expect(marker).toMatchObject({
      namespace: 'semantic:reindex:code:p1',
      cursor: expect.objectContaining({ reason: 'automatic-local-project-open', force: false }),
    });
    await vi.waitFor(() => expect(h.jobs.get(marker!.id)?.status).toBe('completed'));
    expect(run).toHaveBeenCalledWith(1, false);
    expect(run).not.toHaveBeenCalledWith(2, expect.anything());
  });

  it('never starts an automatic provider backfill', () => {
    const h = makeHarness();
    h.store.getProfile.mockImplementation((purpose: 'code' | 'docs' | 'memory') => ({
      purpose,
      embedding_target: purpose === 'code'
        ? { kind: 'provider', providerId: 'remote', model: 'embed', protocol: 'openai-embeddings' }
        : { kind: 'disabled' },
      reranker_target: { kind: 'disabled' },
    }));

    expect(h.coordinator.activateCodeProject(1)).toBeNull();
    expect([...h.jobs.values()]).toEqual([]);
  });

  it('serves a clean active generation on reopen without scheduling a full semantic pass', () => {
    const generation: Generation = {
      id: 8,
      purpose: 'code',
      fingerprint: 'code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    };
    const h = makeHarness({
      existingGeneration: generation,
      namespaceStates: [{
        namespace: 'code:p1', purpose: 'code', active_generation_id: 8,
        building_generation_id: null, expected_items: 1, indexed_items: 1,
        failed_items: 0, delta_items: 0, last_error: null,
      }],
    });
    const run = vi.spyOn(h.coordinator, 'reindexCodeProject');

    expect(h.coordinator.activateCodeProject(1)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect([...h.jobs.values()]).toEqual([]);
  });

  it('pauses a queued local backfill when the last project lease closes', async () => {
    const h = makeHarness();
    const marker = h.coordinator.activateCodeProject(1)!;
    expect(h.coordinator.deactivateCodeProject(1)).toBe(true);

    await vi.waitFor(() => expect(h.jobs.get(marker.id)?.status).toBe('paused'));
    expect(h.jobs.get(marker.id)).toMatchObject({ failed_items: 0 });
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
  });

  it('normalizes interrupted work on startup without enumerating or indexing projects', () => {
    const h = makeHarness({ projects: [1, 2], fileCounts: { 1: 1, 2: 1 } });
    const interrupted = h.store.createJob({
      generation_id: null,
      namespace: 'code:p1',
      kind: 'backfill',
      cursor: { reason: 'code-delta', events: [{ kind: 'upsert', path: 'src/file-1.ts' }] },
      expected_items: 1,
    });
    h.store.updateJob(interrupted.id, { status: 'running', processed_items: 1 });
    h.db.listProjects.mockClear();
    h.embedding.embedQuery.mockClear();
    retryEmbeddingsMock.mockClear();

    h.coordinator.recoverInterruptedJobsPassively();

    expect(h.jobs.get(interrupted.id)).toMatchObject({
      status: 'paused',
      processed_items: 0,
      error: expect.stringContaining('waiting for an explicit resume'),
    });
    expect(h.db.listProjects).not.toHaveBeenCalled();
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
  });

  it('cancels paused work from a generation no longer referenced by its namespace', () => {
    const generations: Generation[] = [{
      id: 2,
      purpose: 'code',
      fingerprint: 'old-code-model',
      embedding_target: { kind: 'onnx', model: 'old-code-model' },
      dimension: 3,
      status: 'retired',
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      error: null,
    }, {
      id: 3,
      purpose: 'code',
      fingerprint: 'current-code-model',
      embedding_target: { kind: 'onnx', model: 'current-code-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    }];
    const h = makeHarness({
      existingGenerations: generations,
      namespaceStates: [{
        namespace: 'code:p1', purpose: 'code', active_generation_id: 3,
        building_generation_id: null, expected_items: 1, indexed_items: 1,
        failed_items: 0, delta_items: 0, last_error: null,
      }],
    });
    const obsolete = h.store.createJob({
      generation_id: 2,
      namespace: 'code:p1',
      kind: 'backfill',
      expected_items: 1,
    });
    h.store.updateJob(obsolete.id, {
      status: 'paused',
      error: 'interrupted by application restart; waiting for an explicit resume',
    });

    h.coordinator.recoverInterruptedJobsPassively();

    expect(h.jobs.get(obsolete.id)).toMatchObject({
      status: 'cancelled',
      error: expect.stringContaining('superseded'),
    });
    expect(() => h.coordinator.resumeJob(obsolete.id)).toThrow(/superseded/);
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
  });

  it('keeps watcher deltas pending when no project generation was explicitly requested', async () => {
    const h = makeHarness();

    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/file-1.ts' }]);
    await h.coordinator.catchUpCodeProject(1);

    expect(h.generations).toEqual([]);
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
    expect([...h.jobs.values()]).toContainEqual(expect.objectContaining({
      namespace: 'code:p1',
      generation_id: null,
      kind: 'backfill',
      status: 'pending',
      cursor: expect.objectContaining({
        reason: 'code-delta',
        events: [{ kind: 'upsert', path: 'src/file-1.ts' }],
      }),
    }));
  });

  it('persists worker-captured previous item keys without reading the project DB on main', () => {
    const h = makeHarness();
    h.db.getFile.mockClear();
    h.db.getSymbolsByFile.mockClear();

    h.coordinator.noteCodeDelta(
      1,
      [{ kind: 'upsert', path: 'src/file-1.ts' }],
      ['file:7', 'symbol:11', 'symbol_body:11', 'symbol_group:11'],
    );

    expect(h.db.getFile).not.toHaveBeenCalled();
    expect(h.db.getSymbolsByFile).not.toHaveBeenCalled();
    const job = [...h.jobs.values()].find((row) => row.namespace === 'code:p1');
    expect(job?.cursor?.previous_item_keys).toEqual([
      'file:7',
      'symbol:11',
      'symbol_body:11',
      'symbol_group:11',
    ]);
  });

  it.each(['resolve', 'reject'] as const)('drains explicit project final job writes before disposal (%s)', async outcome => {
    const h = makeHarness();
    const held = deferred<{ purpose: 'code'; generation_id: number; completed_namespaces: string[]; failed_namespaces: never[] }>();
    const run = vi.spyOn(h.coordinator, 'reindexCodeProject').mockReturnValue(held.promise);
    const job = h.coordinator.enqueueCodeProjectReindex(1, false);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    let closed = false;
    const disposal = h.coordinator.dispose().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(() => h.coordinator.enqueueCodeProjectReindex(1)).toThrow('shutting down');
    if (outcome === 'resolve') held.resolve({ purpose: 'code', generation_id: 9, completed_namespaces: ['code:p1'], failed_namespaces: [] });
    else held.reject(new Error('embedding shutdown'));
    await disposal;
    expect(h.jobs.get(job.id)?.status).toBe(outcome === 'resolve' ? 'completed' : 'paused');
    const final = JSON.stringify(h.jobs.get(job.id));
    await new Promise(resolve => setImmediate(resolve));
    expect(JSON.stringify(h.jobs.get(job.id))).toBe(final);
    await h.coordinator.dispose();
  });

  it('coalesces explicit project markers and dispatches the latest requested force mode', async () => {
    const h = makeHarness();
    h.db.listFiles.mockImplementation(() => { throw new Error('Queueing must not hydrate indexed file rows'); });
    const run = vi.spyOn(h.coordinator, 'reindexCodeProject').mockResolvedValue({
      purpose: 'code',
      generation_id: 9,
      completed_namespaces: ['code:p1'],
      failed_namespaces: [],
    });

    const first = h.coordinator.enqueueCodeProjectReindex(1, false);
    const second = h.coordinator.enqueueCodeProjectReindex(1, true);

    expect(second.id).toBe(first.id);
    expect([...h.jobs.values()].filter((job) =>
      job.namespace === 'semantic:reindex:code:p1')).toHaveLength(1);
    expect([...h.jobs.values()].some((job) =>
      job.namespace === 'semantic:reindex:code')).toBe(false);
    await vi.waitFor(() => expect(h.jobs.get(first.id)?.status).toBe('completed'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(1, true);
  });

  it('coalesces path deltas and keeps wildcard overflow passive until explicit reindex', async () => {
    const generation: Generation = {
      id: 8, purpose: 'code', fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' }, dimension: 3,
      status: 'ready', expected_items: 1, indexed_items: 1, failed_items: 0, error: null,
    };
    const state: NamespaceState = {
      namespace: 'code:p1', purpose: 'code', active_generation_id: 8,
      building_generation_id: null, expected_items: 1, indexed_items: 1,
      failed_items: 0, delta_items: 0, last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });

    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/file-1.ts' }]);
    h.coordinator.noteCodeDelta(1, [
      { kind: 'upsert', path: 'src/file-1.ts' },
      { kind: 'delete', path: 'src/gone.ts' },
    ]);
    const coalesced = [...h.jobs.values()].filter((job) => job.namespace === 'code:p1');
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0]).toMatchObject({ expected_items: 2 });
    expect(coalesced[0].cursor?.events).toEqual([
      { kind: 'upsert', path: 'src/file-1.ts' },
      { kind: 'delete', path: 'src/gone.ts' },
    ]);
    expect(h.namespaces.get('code:p1')?.delta_items).toBe(2);

    h.coordinator.noteCodeDelta(1, Array.from({ length: 513 }, (_, index) => ({
      kind: 'upsert' as const,
      path: `src/bulk-${index}.ts`,
    })));
    expect(coalesced[0]).toMatchObject({ expected_items: 1 });
    expect(coalesced[0].cursor?.events).toEqual([{ kind: 'upsert', path: '*' }]);
    expect(coalesced[0].cursor).toMatchObject({ requires_explicit_reindex: true });
    expect(h.namespaces.get('code:p1')?.delta_items).toBe(1);

    h.embedding.embedQuery.mockClear();
    retryEmbeddingsMock.mockClear();
    await h.coordinator.catchUpCodeProject(1);
    expect(coalesced[0]).toMatchObject({ status: 'pending' });
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
  });

  it('fails fast on SQLITE_BUSY and retries a coalesced watcher delta', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.store.withBusyTimeout
        .mockImplementationOnce(() => {
          const error = new Error('database is locked') as Error & { code: string };
          error.code = 'SQLITE_BUSY';
          throw error;
        })
        .mockImplementation((_timeoutMs: number, operation: () => unknown) => operation());

      expect(() => h.coordinator.noteCodeDelta(1, [
        { kind: 'upsert', path: 'src/retry.ts' },
      ], ['file:7'])).not.toThrow();
      h.coordinator.noteCodeDelta(1, [
        { kind: 'delete', path: 'src/retry.ts' },
        { kind: 'upsert', path: 'src/other.ts' },
      ]);

      await vi.advanceTimersByTimeAsync(50);

      expect(h.store.withBusyTimeout).toHaveBeenCalledWith(0, expect.any(Function));
      const job = [...h.jobs.values()].find((row) => row.namespace === 'code:p1');
      expect(job?.cursor?.events).toEqual([
        { kind: 'delete', path: 'src/retry.ts' },
        { kind: 'upsert', path: 'src/other.ts' },
      ]);
      expect(job?.cursor?.previous_item_keys).toEqual(['file:7']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses exact watcher paths and shares concurrent catch-up calls', async () => {
    const generation: Generation = {
      id: 8, purpose: 'code', fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' }, dimension: 3,
      status: 'ready', expected_items: 1, indexed_items: 1, failed_items: 0, error: null,
    };
    const state: NamespaceState = {
      namespace: 'code:p1', purpose: 'code', active_generation_id: 8,
      building_generation_id: null, expected_items: 1, indexed_items: 1,
      failed_items: 0, delta_items: 0, last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });
    const embedding = deferred<{ embedded: number; skipped: number; tokens: number; failedBatches: number }>();
    retryEmbeddingsMock.mockImplementationOnce(() => embedding.promise);
    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/file-1.ts' }]);

    const first = h.coordinator.catchUpCodeProject(1);
    const duplicate = h.coordinator.catchUpCodeProject(1);
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1));
    expect(retryEmbeddingsMock.mock.calls[0]?.[2]).toMatchObject({
      paths: ['src/file-1.ts'],
    });

    embedding.resolve({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });
    await Promise.all([first, duplicate]);
    expect([...h.jobs.values()].find((job) => job.kind === 'delta')).toMatchObject({
      status: 'completed',
    });
    expect(h.namespaces.get('code:p1')).toMatchObject({ delta_items: 0, failed_items: 0 });
  });

  it('waits for the project structural mutex before consuming a code delta', async () => {
    const h = makeHarness({ fileCounts: { 1: 1 }, vectorItems: { 'code:p1': 1 } });
    const structural = deferred<void>();
    h.deps.withProjectLock.mockImplementationOnce(async (
      _projectId: number,
      operation: () => Promise<unknown>,
    ) => {
      await structural.promise;
      return operation();
    });

    const run = h.coordinator.ensureCodeProject(1);
    await vi.waitFor(() => expect(h.deps.withProjectLock).toHaveBeenCalledWith(1, expect.any(Function)));
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();

    structural.resolve();
    await run;
    expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the old active generation serving and pauses the job when a batch fails', async () => {
    const oldGeneration: Generation = {
      id: 41,
      purpose: 'code',
      fingerprint: 'old-model',
      embedding_target: { kind: 'onnx', model: 'old' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    };
    const oldState: NamespaceState = {
      namespace: 'code:p1',
      purpose: 'code',
      active_generation_id: 41,
      building_generation_id: null,
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const h = makeHarness({ existingGeneration: oldGeneration, namespaceStates: [oldState] });
    retryEmbeddingsMock.mockResolvedValue({ embedded: 0, skipped: 0, tokens: 0, failedBatches: 1 });

    const result = await h.coordinator.reindex('code', true);

    expect(result.completed_namespaces).toEqual([]);
    expect(result.failed_namespaces[0]).toMatchObject({ namespace: 'code:p1' });
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: 41,
      building_generation_id: 42,
      failed_items: 1,
    });
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();
    expect(Array.from(h.jobs.values()).at(-1)).toMatchObject({
      status: 'paused',
      failed_items: 1,
      error: '1 embedding batch(es) failed',
    });
    expect(h.generations.find((generation) => generation.id === 42)).toMatchObject({
      status: 'building',
      failed_items: 1,
      error: '1 embedding batch(es) failed',
    });
  });

  it('does not activate a non-empty namespace when zero vector items landed', async () => {
    const h = makeHarness({ fileCounts: { 1: 1 }, vectorItems: { 'code:p1': 0 } });

    const result = await h.coordinator.reindex('code', true);

    expect(result.failed_namespaces[0]?.error)
      .toBe('vector coverage incomplete: file:1#0 is not current');
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: null,
      expected_items: 1,
      failed_items: 1,
    });
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();
  });

  it('rejects activation when the ledger is complete but sqlite-vec is missing an id', async () => {
    const h = makeHarness({
      fileCounts: { 1: 1 },
      vectorItems: { 'code:p1': 1 },
      physicalIds: { 'code:p1': [] },
    });

    const result = await h.coordinator.reindex('code', true);

    expect(result.failed_namespaces[0]?.error)
      .toContain('physical vector coverage incomplete for code:p1: 0/1 ids');
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();
    expect(h.store.deleteItemsByVectorIds).toHaveBeenCalledWith(
      result.generation_id,
      'code:p1',
      expect.arrayContaining([expect.any(String)]),
    );
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: null,
      building_generation_id: result.generation_id,
      failed_items: 1,
    });
  });

  it('classifies an unavailable vector worker before creating a generation', async () => {
    const h = makeHarness();
    h.vectorStore.isAvailable.mockResolvedValue(false);

    await expect(h.coordinator.reindex('code', true)).rejects.toMatchObject({
      code: 'SEMANTIC_VECTOR_WORKER_UNAVAILABLE',
    });
    expect(h.store.createGeneration).not.toHaveBeenCalled();
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(h.router.dropGeneration).not.toHaveBeenCalled();
  });

  it('treats disabled profiles as an FTS-only no-op without retry loops', async () => {
    const h = makeHarness({
      docChunks: [],
      existingGeneration: {
        id: 7,
        purpose: 'code',
        fingerprint: 'old-code-model',
        embedding_target: { kind: 'onnx', model: 'old-code-model' },
        dimension: 3,
        status: 'building',
        expected_items: 1,
        indexed_items: 0,
        failed_items: 0,
        error: null,
      },
      namespaceStates: [{
        namespace: 'code:p1',
        purpose: 'code',
        active_generation_id: null,
        building_generation_id: 7,
        expected_items: 1,
        indexed_items: 0,
        failed_items: 0,
        delta_items: 0,
        last_error: null,
      }],
    });
    const pendingDocs = h.store.enqueueNamespaceBackfill({
      namespace: 'docs:c2',
      cursor: { collection_id: 2 },
    });
    h.store.enqueueNamespaceBackfill.mockClear();
    h.store.getProfile.mockImplementation((purpose: 'code' | 'docs' | 'memory') => ({
      purpose,
      embedding_target: { kind: 'disabled' },
      reranker_target: { kind: 'disabled' },
    }));

    await expect(h.coordinator.reindex('code')).resolves.toMatchObject({
      purpose: 'code',
      generation_id: null,
      skipped: 'disabled',
      failed_namespaces: [],
    });
    await expect(h.coordinator.reindex('docs')).resolves.toMatchObject({
      purpose: 'docs',
      generation_id: null,
      skipped: 'disabled',
    });
    await expect(h.coordinator.ensureCodeProject(1)).resolves.toBeUndefined();
    await expect(h.coordinator.prepareDocsCollection(2)).resolves.toBeUndefined();
    await expect(h.coordinator.ensureDocsCollection(2)).resolves.toBeUndefined();
    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/file-1.ts' }]);
    await expect(h.coordinator.retryPendingDocsBackfills()).resolves.toBe(0);

    expect(pendingDocs).toMatchObject({
      status: 'paused',
      error: 'docs semantic profile is disabled',
    });
    expect(h.store.createGeneration).not.toHaveBeenCalled();
    expect(h.store.createJob).not.toHaveBeenCalled();
    expect(h.store.enqueueNamespaceBackfill).not.toHaveBeenCalled();
    expect(h.docsIndexer.retryEmbeddings).not.toHaveBeenCalled();
    expect(retryEmbeddingsMock).not.toHaveBeenCalled();
    await h.coordinator.dispose();
  });

  it('persists and later drains a docs backfill when preparation fails before generation creation', async () => {
    const h = makeHarness({ docChunks: [] });
    h.vectorStore.isAvailable.mockResolvedValue(false);
    try {
      await expect(h.coordinator.prepareDocsCollection(2)).rejects.toMatchObject({
        code: 'SEMANTIC_VECTOR_WORKER_UNAVAILABLE',
      });
      expect(h.generations).toHaveLength(0);
      const durable = Array.from(h.jobs.values()).find((job) =>
        job.namespace === 'docs:c2' && job.generation_id === null);
      expect(durable).toMatchObject({
        kind: 'backfill',
        status: 'pending',
        cursor: expect.objectContaining({ collection_id: 2 }),
        error: expect.stringContaining('semantic vector worker unavailable'),
      });

      h.vectorStore.isAvailable.mockResolvedValue(true);
      await expect(h.coordinator.retryPendingDocsBackfills()).resolves.toBe(1);

      expect(durable).toMatchObject({
        status: 'completed',
        processed_items: 1,
        failed_items: 0,
        error: null,
      });
      expect(h.namespaces.get('docs:c2')).toMatchObject({
        active_generation_id: h.generations[0].id,
        building_generation_id: null,
      });
    } finally {
      await h.coordinator.dispose();
    }
  });

  it('allows a genuinely empty namespace because its zero-item coverage is complete', async () => {
    const h = makeHarness({
      fileCounts: { 1: 0 },
      vectorItems: { 'code:p1': 0 },
      coverage: { 1: { total: 0, embedded: 0 } },
    });
    retryEmbeddingsMock.mockResolvedValue({ embedded: 0, skipped: 0, tokens: 0, failedBatches: 0 });

    const result = await h.coordinator.reindex('code', true);

    expect(result.failed_namespaces).toEqual([]);
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: result.generation_id,
      building_generation_id: null,
      expected_items: 0,
      indexed_items: 0,
    });
  });

  it('does not let an unrelated symbol row mask a missing file vector', async () => {
    const h = makeHarness({
      fileCounts: { 1: 1 },
      semanticItems: {
        'code:p1': [{
          item_key: 'symbol:99', source_hash: 'symbol-hash:99', vector_id: 's99',
          chunk_index: 0, status: 'indexed',
        }],
      },
    });

    const result = await h.coordinator.reindex('code', true);

    expect(result.failed_namespaces[0]?.error)
      .toBe('vector coverage incomplete: file:1#0 is not current');
    expect(h.store.listItems).toHaveReturnedWith(expect.arrayContaining([
      expect.objectContaining({ item_key: 'symbol:99' }),
    ]));
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();
  });

  it('verifies file, signature and every current body chunk by source hash', async () => {
    const h = makeHarness({
      fileCounts: { 1: 1 },
      symbols: { 1: [{ id: 10, sigHash: 'sig-hash:10', bodyHash: 'body-hash:10' }] },
    });
    retryEmbeddingsMock.mockResolvedValue({ embedded: 4, skipped: 0, tokens: 4, failedBatches: 0 });

    const result = await h.coordinator.reindex('code', true);

    expect(result.failed_namespaces).toEqual([]);
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: result.generation_id,
      expected_items: 4,
      indexed_items: 4,
    });
  });

  it('leaves an in-flight build inactive when a delta arrives, then activates on the post-drain catch-up', async () => {
    const h = makeHarness();
    const first = deferred<{ embedded: number; skipped: number; tokens: number; failedBatches: number }>();
    retryEmbeddingsMock
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });

    const initialBuild = h.coordinator.ensureCodeProject(1);
    await vi.waitFor(() => expect(h.namespaces.get('code:p1')?.building_generation_id).toBeTruthy());
    h.coordinator.noteCodeDelta(1);
    first.resolve({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });

    await expect(initialBuild).rejects.toThrow('delta queue pending for code:p1');
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: null,
      delta_items: 1,
      failed_items: 0,
    });
    expect(Array.from(h.jobs.values()).at(-1)).toMatchObject({ status: 'pending', error: null });
    expect(h.vectorStore.dropGeneration).toHaveBeenCalledWith('code:p1', h.generations[0].id);
    expect(h.store.deleteItemsForNamespaceGeneration)
      .toHaveBeenCalledWith(h.generations[0].id, 'code:p1');
    expect(Array.from(h.jobs.values()).find((job) => job.kind === 'delta')).toMatchObject({
      status: 'pending',
      cursor: { events: [{ kind: 'upsert', path: '*' }] },
      expected_items: 1,
    });

    await h.coordinator.ensureCodeProject(1);
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: h.generations[0].id,
      building_generation_id: null,
      delta_items: 0,
    });
    expect(h.embedding.embedQuery).toHaveBeenCalledTimes(1);
    expect(h.store.createGeneration).toHaveBeenCalledTimes(1);
    expect(Array.from(h.jobs.values()).find((job) => job.kind === 'delta')).toMatchObject({
      status: 'completed',
      processed_items: 1,
    });
  });

  it('requeues a running delta left by a crashed build and drains it before activation', async () => {
    const generation: Generation = {
      id: 7,
      purpose: 'code',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' },
      dimension: 3,
      status: 'building',
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      error: null,
    };
    const state: NamespaceState = {
      namespace: 'code:p1',
      purpose: 'code',
      active_generation_id: null,
      building_generation_id: 7,
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      delta_items: 1,
      last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });
    const delta = h.store.createJob({
      generation_id: 7,
      namespace: 'code:p1',
      kind: 'delta',
      cursor: { events: [{ kind: 'upsert', path: 'src/file-1.ts' }] },
      expected_items: 1,
    });
    h.store.updateJob(delta.id, { status: 'running', processed_items: 1 });

    await h.coordinator.ensureCodeProject(1);

    expect(h.store.updateJob).toHaveBeenCalledWith(delta.id, expect.objectContaining({
      status: 'pending',
      processed_items: 0,
    }));
    expect(h.jobs.get(delta.id)).toMatchObject({
      status: 'completed',
      processed_items: 1,
      cursor: { events: [{ kind: 'upsert', path: 'src/file-1.ts' }] },
    });
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: 7,
      building_generation_id: null,
      delta_items: 0,
    });
  });

  it('reuses a crashed running delta when catching up an already active generation', async () => {
    const generation: Generation = {
      id: 8,
      purpose: 'code',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    };
    const state: NamespaceState = {
      namespace: 'code:p1',
      purpose: 'code',
      active_generation_id: 8,
      building_generation_id: null,
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });
    const delta = h.store.createJob({
      generation_id: 8,
      namespace: 'code:p1',
      kind: 'delta',
      expected_items: 1,
    });
    h.store.updateJob(delta.id, { status: 'running', processed_items: 1 });
    h.store.createJob.mockClear();

    await h.coordinator.ensureCodeProject(1);

    expect(h.store.createJob).not.toHaveBeenCalled();
    expect(h.jobs.get(delta.id)).toMatchObject({
      status: 'completed',
      processed_items: 1,
      failed_items: 0,
    });
    expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent project builds globally so only one embedding wave owns RAM', async () => {
    const h = makeHarness({
      projects: [1, 2],
      fileCounts: { 1: 1, 2: 1 },
      vectorItems: { 'code:p1': 1, 'code:p2': 1 },
    });
    const firstWave = deferred<{
      embedded: number; skipped: number; tokens: number; failedBatches: number;
    }>();
    const secondWave = deferred<{
      embedded: number; skipped: number; tokens: number; failedBatches: number;
    }>();
    let activeWaves = 0;
    let peakWaves = 0;
    retryEmbeddingsMock
      .mockImplementationOnce(async () => {
        activeWaves++;
        peakWaves = Math.max(peakWaves, activeWaves);
        try { return await firstWave.promise; }
        finally { activeWaves--; }
      })
      .mockImplementationOnce(async () => {
        activeWaves++;
        peakWaves = Math.max(peakWaves, activeWaves);
        try { return await secondWave.promise; }
        finally { activeWaves--; }
      });

    const first = h.coordinator.ensureCodeProject(1);
    const second = h.coordinator.ensureCodeProject(2);
    await vi.waitFor(() => expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1));
    expect(activeWaves).toBe(1);
    expect(peakWaves).toBe(1);

    firstWave.resolve({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });
    await vi.waitFor(() => expect(retryEmbeddingsMock).toHaveBeenCalledTimes(2));
    expect(activeWaves).toBe(1);
    expect(peakWaves).toBe(1);
    secondWave.resolve({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });
    await Promise.all([first, second]);

    expect(h.store.createGeneration).toHaveBeenCalledTimes(1);
    expect(h.embedding.embedQuery).toHaveBeenCalledTimes(1);
    expect(peakWaves).toBe(1);
    expect(h.namespaces.get('code:p1')?.active_generation_id)
      .toBe(h.namespaces.get('code:p2')?.active_generation_id);
  });

  it('captures an active-generation delta when an explicit rebuild creates its replacement', async () => {
    const generation: Generation = {
      id: 8,
      purpose: 'code',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    };
    const state: NamespaceState = {
      namespace: 'code:p1',
      purpose: 'code',
      active_generation_id: 8,
      building_generation_id: null,
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });
    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/file-1.ts' }]);
    const delta = [...h.jobs.values()].find((job) => job.kind === 'delta');

    const result = await h.coordinator.reindexCodeProject(1, true);

    expect(result.failed_namespaces).toEqual([]);
    expect(result.generation_id).not.toBe(8);
    expect(delta).toMatchObject({
      generation_id: 8,
      status: 'completed',
      processed_items: 1,
      failed_items: 0,
    });
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: result.generation_id,
      building_generation_id: null,
      delta_items: 0,
    });
  });

  it('holds a project tombstone across an already-enumerated reindex and physical removal', async () => {
    const generation: Generation = {
      id: 7,
      purpose: 'code',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    };
    const state: NamespaceState = {
      namespace: 'code:p1',
      purpose: 'code',
      active_generation_id: 7,
      building_generation_id: null,
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });
    const activeBuild = deferred<{
      embedded: number; skipped: number; tokens: number; failedBatches: number;
    }>();
    retryEmbeddingsMock.mockImplementationOnce(() => activeBuild.promise);

    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/file-1.ts' }]);
    const firstCatchup = h.coordinator.catchUpCodeProject(1);
    await vi.waitFor(() => expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1));

    // This rollout has resolved its generation and queued code:p1 behind the
    // active catch-up before removal publishes the tombstone.
    const staleReindex = h.coordinator.reindex('code', true);
    await vi.waitFor(() => expect(h.store.createGeneration).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const workerEntered = deferred<void>();
    const workerRelease = deferred<void>();
    h.vectorStore.removeProject.mockImplementationOnce(async (projectId: number) => {
      workerEntered.resolve();
      await workerRelease.promise;
      for (const namespace of [
        `code:p${projectId}`,
        `snapshot:p${projectId}`,
        `memory:project:p${projectId}`,
      ]) h.store.deleteNamespace(namespace);
    });
    const removal = h.coordinator.removeProject(1);
    expect(h.coordinator.allowsNamespaceMutation('code:p1')).toBe(false);
    expect(h.coordinator.allowsNamespaceMutation('docs:c2')).toBe(true);
    expect(h.coordinator.allowsNamespaceMutation('memory:user')).toBe(true);

    activeBuild.resolve({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });
    await workerEntered.promise;
    const routeCallsAtRemoval = h.router.resolve.mock.calls.length;

    // All three locks are held by removeProject here. Late drains are no-ops
    // and cannot create a job or resolve/reopen the project vectors path.
    await Promise.all([
      h.coordinator.ensureCodeProject(1),
      h.coordinator.ensureMemoryNamespace('snapshot:p1'),
      h.coordinator.ensureMemoryNamespace('memory:project:p1'),
    ]);
    h.coordinator.noteCodeDelta(1, [{ kind: 'upsert', path: 'src/late.ts' }]);
    expect(h.router.resolve.mock.calls).toHaveLength(routeCallsAtRemoval);

    await h.coordinator.ensureMemoryNamespace('memory:user');
    expect(h.namespaces.has('memory:user')).toBe(true);

    workerRelease.resolve();
    const [, reindexResult] = await Promise.all([firstCatchup, staleReindex, removal]);

    expect(reindexResult.completed_namespaces).toEqual([]);
    expect(h.deps.withProjectLock).toHaveBeenCalledWith(1, expect.any(Function));
    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(1);
    expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(h.store.beginNamespaceGeneration.mock.calls
      .filter(([input]) => input.namespace === 'code:p1')).toEqual([]);
    expect([...h.namespaces.keys()].filter((namespace) =>
      namespace === 'code:p1'
      || namespace === 'snapshot:p1'
      || namespace === 'memory:project:p1')).toEqual([]);
    expect([...h.jobs.values()].filter((job) =>
      job.namespace === 'code:p1'
      || job.namespace === 'snapshot:p1'
      || job.namespace === 'memory:project:p1')).toEqual([]);
    expect([...h.jobs.values()]).toContainEqual(expect.objectContaining({
      namespace: 'project-removal:p1',
      kind: 'cleanup',
      status: 'completed',
    }));
  });

  it('observes an external CLI removal marker and drains it through the owner worker', async () => {
    const h = makeHarness();
    const marker = h.store.requestProjectRemoval({
      projectId: 1,
      requestedBy: 'cli',
      finalizeProject: true,
    });

    // The coordinator did not create this marker and its in-memory Set was
    // never touched, yet the durable fence must stop a late writer at once.
    expect(h.coordinator.allowsNamespaceMutation('code:p1')).toBe(false);
    await h.coordinator.ensureMemoryNamespace('snapshot:p1');
    expect(h.store.beginNamespaceGeneration).not.toHaveBeenCalled();

    await expect(h.coordinator.retryPendingProjectRemovals()).resolves.toBe(1);
    expect(h.deps.withProjectLock).toHaveBeenCalledWith(1, expect.any(Function));
    expect(h.vectorStore.removeProject).toHaveBeenCalledWith(1);
    expect(h.db.deleteProject).toHaveBeenCalledWith(1);
    expect(h.jobs.get(marker.id)).toMatchObject({
      status: 'completed', processed_items: 1, failed_items: 0,
      cursor: expect.objectContaining({ finalize_project: true }),
    });

    // Completed requests are terminal and are not swept forever.
    await expect(h.coordinator.retryPendingProjectRemovals()).resolves.toBe(0);
    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(1);
  });

  it('removes a renamed project idempotently without touching global namespaces', async () => {
    const states: NamespaceState[] = [
      ['code:p1', 'code'],
      ['snapshot:p1', 'memory'],
      ['memory:project:p1', 'memory'],
      ['docs:c2', 'docs'],
      ['memory:user', 'memory'],
    ].map(([namespace, purpose]) => ({
      namespace,
      purpose,
      active_generation_id: 7,
      building_generation_id: null,
      expected_items: 0,
      indexed_items: 0,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    } as NamespaceState));
    const h = makeHarness({ namespaceStates: states });
    h.db.getProject.mockImplementation((id: number) => id === 1
      ? { id, name: 'renamed-project', is_synthetic: false, root_path: tempDirs.at(-1)! }
      : undefined);

    await Promise.all([
      h.coordinator.removeProject(1),
      h.coordinator.removeProject(1),
    ]);

    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(1);
    expect([...h.namespaces.keys()].sort()).toEqual(['docs:c2', 'memory:user']);
    expect(h.coordinator.allowsNamespaceMutation('code:p1')).toBe(false);

    // Catalog deletion may have happened before a retry after a crash. The
    // durable marker makes that retry a control-plane no-op, not a DB reopen.
    h.db.getProject.mockReturnValue(undefined);
    await h.coordinator.removeProject(1);
    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(1);
    expect([...h.namespaces.keys()].sort()).toEqual(['docs:c2', 'memory:user']);

    const restarted = new SemanticIndexCoordinator(h.deps as never);
    expect(restarted.allowsNamespaceMutation('code:p1')).toBe(false);
    expect(restarted.allowsNamespaceMutation('docs:c2')).toBe(true);
    expect(restarted.allowsNamespaceMutation('memory:user')).toBe(true);
  });

  it('waits for structural idle and releases the tombstone only after retained data is cleared', async () => {
    const h = makeHarness();
    const structurallyIdle = deferred<void>();
    const finalizer = vi.fn(() => undefined);
    h.deps.withProjectLock.mockImplementationOnce(async (
      _projectId: number,
      operation: () => Promise<unknown>,
    ) => {
      await structurallyIdle.promise;
      return operation();
    });

    const removal = h.coordinator.removeProject(1, {
      retainProject: true,
      finalize: finalizer,
    });
    await vi.waitFor(() => expect(h.deps.withProjectLock).toHaveBeenCalledTimes(1));
    expect(h.vectorStore.removeProject).not.toHaveBeenCalled();
    expect(finalizer).not.toHaveBeenCalled();
    expect(h.coordinator.allowsNamespaceMutation('code:p1')).toBe(false);

    structurallyIdle.resolve();
    await removal;

    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(1);
    expect(finalizer).toHaveBeenCalledTimes(1);
    expect(h.coordinator.allowsNamespaceMutation('code:p1')).toBe(true);
    expect([...h.jobs.values()]).toContainEqual(expect.objectContaining({
      namespace: 'project-removal:p1',
      status: 'cancelled',
    }));
  });

  it('coalesces only equal project-removal operations and rejects conflicting semantics', async () => {
    const h = makeHarness();
    const structurallyIdle = deferred<void>();
    const deleteFinalizer = vi.fn(() => undefined);
    const ignoredDeleteFinalizer = vi.fn(() => undefined);
    const clearFinalizer = vi.fn(() => undefined);
    h.deps.withProjectLock.mockImplementationOnce(async (
      _projectId: number,
      operation: () => Promise<unknown>,
    ) => {
      await structurallyIdle.promise;
      return operation();
    });

    const deletion = h.coordinator.removeProject(1, { finalize: deleteFinalizer });
    await vi.waitFor(() => expect(h.deps.withProjectLock).toHaveBeenCalledTimes(1));

    const sameDeletion = h.coordinator.removeProject(1, { finalize: ignoredDeleteFinalizer });
    expect(sameDeletion).toBe(deletion);
    await expect(h.coordinator.removeProject(1, {
      retainProject: true,
      finalize: clearFinalizer,
    })).rejects.toThrow('semantic delete is already running; cannot start clear');
    await expect(h.coordinator.removeProject(1))
      .rejects.toThrow('semantic delete is already running; cannot start cleanup');
    expect(h.vectorStore.removeProject).not.toHaveBeenCalled();

    structurallyIdle.resolve();
    await deletion;

    expect(deleteFinalizer).toHaveBeenCalledTimes(1);
    expect(ignoredDeleteFinalizer).not.toHaveBeenCalled();
    expect(clearFinalizer).not.toHaveBeenCalled();
    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(1);
  });

  it('promotes an existing cleanup marker to a crash-recoverable project deletion', async () => {
    const h = makeHarness();
    const marker = h.store.requestProjectRemoval({
      projectId: 1,
      requestedBy: 'server-cleanup',
      finalizeProject: false,
    });
    const crashBeforeCatalogDelete = vi.fn(() => {
      throw new Error('simulated crash before catalog delete');
    });

    await expect(h.coordinator.removeProject(1, {
      finalize: crashBeforeCatalogDelete,
    })).rejects.toThrow('simulated crash before catalog delete');

    expect(h.jobs.get(marker.id)).toMatchObject({
      status: 'paused',
      cursor: expect.objectContaining({ finalize_project: true }),
    });
    expect(h.db.deleteProject).not.toHaveBeenCalled();
    await h.coordinator.dispose();

    const restarted = new SemanticIndexCoordinator(h.deps as never);
    await expect(restarted.retryPendingProjectRemovals()).resolves.toBe(1);

    expect(h.vectorStore.removeProject).toHaveBeenCalledTimes(2);
    expect(h.db.deleteProject).toHaveBeenCalledTimes(1);
    expect(h.db.deleteProject).toHaveBeenCalledWith(1);
    expect(h.jobs.get(marker.id)).toMatchObject({
      status: 'completed',
      processed_items: 1,
      cursor: expect.objectContaining({ finalize_project: true }),
    });
    await restarted.dispose();
  });

  it('reuses a ready generation with the current fingerprint without probing again', async () => {
    const existing: Generation = {
      id: 7,
      purpose: 'code',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'code-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 0,
      indexed_items: 0,
      failed_items: 0,
      error: null,
    };
    const h = makeHarness({ existingGeneration: existing });

    await h.coordinator.ensureCodeProject(1);

    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(h.store.createGeneration).not.toHaveBeenCalled();
    expect(h.namespaces.get('code:p1')?.active_generation_id).toBe(7);
  });

  it('creates a replacement generation when the effective backend fingerprint changes', async () => {
    const h = makeHarness({ projects: [1], fileCounts: { 1: 0 } });
    h.embedding.fingerprint.mockReturnValue('semantic-embedding:v2:context-a');

    await h.coordinator.ensureCodeProject(1);
    const first = h.store.createGeneration.mock.results[0]?.value as Generation;
    expect(first).toMatchObject({
      fingerprint: 'semantic-embedding:v2:context-a:space-dimension:3',
      dimension: 3,
      embedding_target: { kind: 'onnx', model: 'code-model' },
    });

    // Same target and dimension, but a provider base/auth/config change is
    // represented by a different runtime fingerprint and must not reuse g1.
    h.embedding.fingerprint.mockReturnValue('semantic-embedding:v2:context-b');
    await h.coordinator.ensureCodeProject(1);

    expect(h.store.createGeneration).toHaveBeenCalledTimes(2);
    const second = h.store.createGeneration.mock.results[1]?.value as Generation;
    expect(second).toMatchObject({
      fingerprint: 'semantic-embedding:v2:context-b:space-dimension:3',
      dimension: 3,
      embedding_target: first.embedding_target,
    });
    expect(second.id).not.toBe(first.id);
  });

  it('drops abandoned and previous tables only after their last physical-DB reference is gone', async () => {
    const generation = (id: number): Generation => ({
      id,
      purpose: 'code',
      fingerprint: `model-${id}`,
      embedding_target: { kind: 'onnx', model: `model-${id}` },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    });
    const state: NamespaceState = {
      namespace: 'code:p1',
      purpose: 'code',
      active_generation_id: 1,
      building_generation_id: 2,
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const h = makeHarness({ existingGenerations: [generation(1), generation(2)], namespaceStates: [state] });
    const build = deferred<{ embedded: number; skipped: number; tokens: number; failedBatches: number }>();
    retryEmbeddingsMock.mockImplementationOnce(() => build.promise);

    const run = h.coordinator.reindex('code', true);
    await vi.waitFor(() => expect(retryEmbeddingsMock).toHaveBeenCalledTimes(1));

    // beginNamespaceGeneration replaced the abandoned building pointer, so
    // g2 is orphaned and dropped. g1 is still active and must keep serving.
    expect(h.vectorStore.dropGeneration).toHaveBeenCalledTimes(1);
    expect(h.vectorStore.dropGeneration).toHaveBeenCalledWith('code:p1', 2);
    expect(h.vectorStore.dropGeneration).not.toHaveBeenCalledWith('code:p1', 1);
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: 1,
      building_generation_id: 3,
    });

    build.resolve({ embedded: 1, skipped: 0, tokens: 1, failedBatches: 0 });
    await run;

    expect(h.vectorStore.dropGeneration.mock.calls).toEqual([
      ['code:p1', 2],
      ['code:p1', 1],
    ]);
    expect(h.namespaces.get('code:p1')).toMatchObject({
      active_generation_id: 3,
      building_generation_id: null,
    });
    expect(h.generations.filter((row) => row.status === 'ready').map((row) => row.id)).toEqual([3]);
  });

  it('explicitly removes and compacts only obsolete physical generation tables', async () => {
    const generation = (id: number, status: Generation['status']): Generation => ({
      id,
      purpose: 'code',
      fingerprint: `model-${id}`,
      embedding_target: { kind: 'onnx', model: `model-${id}` },
      dimension: 3,
      status,
      expected_items: 1,
      indexed_items: status === 'ready' ? 1 : 0,
      failed_items: 0,
      error: null,
    });
    const h = makeHarness({
      existingGenerations: [generation(2, 'retired'), generation(3, 'ready')],
      namespaceStates: [{
        namespace: 'code:p1', purpose: 'code', active_generation_id: 3,
        building_generation_id: null, expected_items: 1, indexed_items: 1,
        failed_items: 0, delta_items: 0, last_error: null,
      }],
    });
    const historical = h.store.createJob({
      generation_id: 2,
      namespace: 'code:p1',
      kind: 'backfill',
      expected_items: 1,
    });
    h.store.updateJob(historical.id, { status: 'completed' });
    // A durable pending marker is not executing and must not make cleanup
    // permanently unavailable after an application restart.
    h.store.createJob({
      generation_id: null,
      namespace: 'semantic:reindex:code:p1',
      kind: 'build',
    });
    h.store.deleteItemsForNamespaceGeneration.mockReturnValueOnce(12);

    const result = await h.coordinator.cleanupUnusedVectors(1);

    expect(h.vectorStore.dropGeneration).toHaveBeenCalledWith('code:p1', 2);
    expect(h.vectorStore.dropGeneration).not.toHaveBeenCalledWith('code:p1', 3);
    expect(h.vectorStore.dropLegacyKnowledgeTables).toHaveBeenCalledWith('memory:project:p1');
    expect(h.vectorStore.compactGenerationDatabase).toHaveBeenCalledWith('code:p1', 2);
    expect(result).toMatchObject({
      tables_removed: 1,
      items_removed: 12,
      databases_compacted: 1,
      bytes_reclaimed: 6_000,
      skipped_referenced: 1,
      failures: [],
    });
  });

  it('sweeps retired Knowledge tables from docs, user memory, and project memory databases', async () => {
    const h = makeHarness();

    await h.coordinator.cleanupUnusedVectors();

    expect(h.vectorStore.dropLegacyKnowledgeTables.mock.calls).toEqual([
      ['docs:c0'],
      ['memory:user'],
      ['memory:project:p1'],
    ]);
  });

  it('refuses project cleanup while that project has a running physical build', async () => {
    const h = makeHarness({
      existingGenerations: [{
        id: 4,
        purpose: 'code',
        fingerprint: 'model-4',
        embedding_target: { kind: 'onnx', model: 'model-4' },
        dimension: 3,
        status: 'building',
        expected_items: 1,
        indexed_items: 0,
        failed_items: 0,
        error: null,
      }],
      namespaceStates: [{
        namespace: 'code:p1', purpose: 'code', active_generation_id: null,
        building_generation_id: 4, expected_items: 1, indexed_items: 0,
        failed_items: 0, delta_items: 0, last_error: null,
      }],
    });
    const running = h.store.createJob({
      generation_id: 4,
      namespace: 'code:p1',
      kind: 'backfill',
    });
    h.store.updateJob(running.id, { status: 'running' });

    await expect(h.coordinator.cleanupUnusedVectors(1)).rejects.toThrow(
      'wait for semantic builds to finish before cleaning unused vectors',
    );
    expect(h.vectorStore.dropGeneration).not.toHaveBeenCalled();
  });

  it('does not allocate another generation while an abandoned DROP keeps failing', async () => {
    const generation = (id: number): Generation => ({
      id,
      purpose: 'code',
      fingerprint: `stale-${id}`,
      embedding_target: { kind: 'onnx', model: `stale-${id}` },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    });
    const state: NamespaceState = {
      namespace: 'code:p1', purpose: 'code', active_generation_id: 1,
      building_generation_id: 2, expected_items: 1, indexed_items: 0,
      failed_items: 1, delta_items: 0, last_error: 'old build failed',
    };
    const h = makeHarness({
      existingGenerations: [generation(1), { ...generation(2), status: 'building' }],
      namespaceStates: [state],
    });
    h.vectorStore.dropGeneration.mockRejectedValue(new Error('database is busy'));

    await expect(h.coordinator.reindex('code', true)).rejects.toThrow('database is busy');
    await expect(h.coordinator.reindex('code', true)).rejects.toThrow('database is busy');

    expect(h.store.createGeneration).not.toHaveBeenCalled();
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(h.namespaces.get('code:p1')?.building_generation_id).toBe(2);
    expect(Array.from(h.jobs.values()).filter((job) => job.kind === 'cleanup'))
      .toEqual([expect.objectContaining({ status: 'paused', error: 'database is busy' })]);
    expect(h.router.dropGeneration).not.toHaveBeenCalled();
  });

  it('deduplicates cleanup and retains a memory table while another namespace in the same file references it', async () => {
    const sharedGeneration: Generation = {
      id: 11,
      purpose: 'memory',
      fingerprint: 'memory-11',
      embedding_target: { kind: 'onnx', model: 'memory' },
      dimension: 3,
      status: 'ready',
      expected_items: 2,
      indexed_items: 2,
      failed_items: 0,
      error: null,
    };
    const snapshot: NamespaceState = {
      namespace: 'snapshot:p1', purpose: 'memory', active_generation_id: 12,
      building_generation_id: null, expected_items: 1, indexed_items: 1,
      failed_items: 0, delta_items: 0, last_error: null,
    };
    const memory: NamespaceState = {
      namespace: 'memory:project:p1', purpose: 'memory', active_generation_id: 11,
      building_generation_id: null, expected_items: 1, indexed_items: 1,
      failed_items: 0, delta_items: 0, last_error: null,
    };
    const h = makeHarness({ existingGeneration: sharedGeneration, namespaceStates: [snapshot, memory] });
    const cleanup = (h.coordinator as unknown as {
      cleanupGenerationIfUnreferenced(namespace: string, generationId: number): Promise<void>;
    }).cleanupGenerationIfUnreferenced.bind(h.coordinator);

    await cleanup('snapshot:p1', 11);
    expect(h.vectorStore.dropGeneration).not.toHaveBeenCalled();

    h.namespaces.get('memory:project:p1')!.active_generation_id = 12;
    const pendingDrop = deferred<undefined>();
    h.vectorStore.dropGeneration.mockImplementationOnce(() => pendingDrop.promise);
    const first = cleanup('snapshot:p1', 11);
    const duplicate = cleanup('memory:project:p1', 11);
    await vi.waitFor(() => expect(h.vectorStore.dropGeneration).toHaveBeenCalledTimes(1));
    pendingDrop.resolve(undefined);
    await Promise.all([first, duplicate]);

    expect(h.vectorStore.dropGeneration).toHaveBeenCalledTimes(1);
    expect(h.store.retireUnreferencedGenerations).toHaveBeenCalledWith('memory');
  });

  it('explicit memory repair runs even when the namespace reports no pending deltas', async () => {
    const h = makeHarness();
    await h.coordinator.ensureMemoryNamespace('memory:project:p1');
    h.agentMemoryService.backfillEmbeddings.mockClear();
    await h.coordinator.ensureMemoryNamespace('memory:project:p1');
    expect(h.agentMemoryService.backfillEmbeddings).not.toHaveBeenCalled();
    const guard = vi.fn();
    await h.coordinator.ensureMemoryNamespace('memory:project:p1', true, guard);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(h.agentMemoryService.backfillEmbeddings).toHaveBeenCalledOnce();
    expect(h.namespaces.get('memory:project:p1')).toMatchObject({delta_items:0,failed_items:0});
  });

  it('revalidates the confirmed target inside the namespace queue before probing', async () => {
    const h = makeHarness();
    const guard = vi.fn(() => { throw new Error('target changed while queued'); });
    await expect(h.coordinator.ensureMemoryNamespace('memory:project:p1',true,guard)).rejects.toThrow('target changed');
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(h.agentMemoryService.backfillEmbeddings).not.toHaveBeenCalled();
  });

  it('does not automatically consume an explicit memory repair after restart', async () => {
    const h = makeHarness();
    Object.assign(h.store,{requiresExplicitNamespaceReindex:vi.fn(() => true)});
    await expect(h.coordinator.ensureMemoryNamespace('memory:project:p1')).rejects.toThrow('retry manually');
    expect(h.agentMemoryService.backfillEmbeddings).not.toHaveBeenCalled();
    await expect(h.coordinator.ensureMemoryNamespace('memory:project:p1',true)).resolves.toBeUndefined();
  });

  it('activates empty memory namespaces instead of pre-staging them forever', async () => {
    const h = makeHarness({ projects: [1], fileCounts: { 1: 0 } });

    const result = await h.coordinator.reindex('memory', true);

    expect(result.failed_namespaces).toEqual([]);
    expect(result.completed_namespaces).toEqual([
      'snapshot:p1',
      'memory:project:p1',
      'memory:user',
    ]);
    for (const namespace of result.completed_namespaces) {
      expect(h.namespaces.get(namespace)).toMatchObject({
        active_generation_id: result.generation_id,
        building_generation_id: null,
        expected_items: 0,
        indexed_items: 0,
      });
    }
  });

  it('refuses a third memory space while two generations actively serve the same SQLite', async () => {
    const generation = (id: number): Generation => ({
      id, purpose: 'memory', fingerprint: `memory-${id}`,
      embedding_target: { kind: 'onnx', model: `memory-${id}` }, dimension: 3,
      status: 'ready', expected_items: 1, indexed_items: 1, failed_items: 0, error: null,
    });
    const state = (namespace: string, active: number): NamespaceState => ({
      namespace, purpose: 'memory', active_generation_id: active,
      building_generation_id: null, expected_items: 1, indexed_items: 1,
      failed_items: 0, delta_items: 0, last_error: null,
    });
    const h = makeHarness({
      existingGenerations: [generation(1), generation(2)],
      namespaceStates: [state('snapshot:p1', 1), state('memory:project:p1', 2)],
    });

    await expect(h.coordinator.reindex('memory', true))
      .rejects.toThrow('memory generation rollout is incomplete');
    expect(h.store.createGeneration).not.toHaveBeenCalled();
    expect(h.embedding.embedQuery).not.toHaveBeenCalled();
    expect(h.vectorStore.dropGeneration).not.toHaveBeenCalled();
  });

  it('derives docs coverage from current chunk content, semantic_items and the physical id', async () => {
    const content = 'Current documentation body.';
    const hash = hashEmbeddingInput(buildEmbeddingText('Guide', null, content, null));
    const h = makeHarness({
      docChunks: [{
        id: 7,
        heading_path: 'Guide',
        content,
        api_signature: null,
        // Compatibility mirrors are deliberately stale and ignored.
        embedding_hash: 'legacy-stale-hash',
        embedding_fingerprint: 'legacy-model',
      }],
      semanticItems: {
        'docs:c2': [{
          item_key: 'doc_chunk:7', source_hash: hash, vector_id: 'doc_chunk:7',
          chunk_index: 0, status: 'indexed',
        }],
      },
    });
    const verify = (h.coordinator as unknown as {
      verifyDocsVectorCoverage(collectionId: number, generationId: number, namespace: string): Promise<number>;
    }).verifyDocsVectorCoverage.bind(h.coordinator);

    await expect(verify(2, 11, 'docs:c2')).resolves.toBe(1);
  });

  it('prepares a new docs namespace before ingestion and activates it after exact catch-up', async () => {
    const content = 'A newly ingested collection.';
    const hash = hashEmbeddingInput(buildEmbeddingText(null, null, content, null));
    const h = makeHarness({
      docChunks: [{ id: 7, heading_path: null, content, api_signature: null }],
      semanticItems: {
        'docs:c2': [{
          item_key: 'doc_chunk:7', source_hash: hash, vector_id: 'doc_chunk:7',
          chunk_index: 0, status: 'indexed',
        }],
      },
    });

    await h.coordinator.prepareDocsCollection(2);
    expect(h.namespaces.get('docs:c2')).toMatchObject({
      active_generation_id: null,
      building_generation_id: h.generations[0].id,
    });

    await h.coordinator.ensureDocsCollection(2);
    expect(h.docsIndexer.retryEmbeddings).toHaveBeenCalledWith(
      { collectionId: 2, force: false },
      expect.any(Object),
    );
    expect(h.namespaces.get('docs:c2')).toMatchObject({
      active_generation_id: h.generations[0].id,
      building_generation_id: null,
      indexed_items: 1,
    });
    // On-demand generations become ready when every namespace that actually
    // references them is complete; unrelated projects are not implicit work.
    expect(h.generations[0].status).toBe('ready');
  });

  it('does not point building at the already-active docs generation during prepare', async () => {
    const active: Generation = {
      id: 7,
      purpose: 'docs',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'docs-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
    };
    const h = makeHarness({
      docChunks: [{ id: 7, heading_path: null, content: 'Already active.', api_signature: null }],
      existingGeneration: active,
      namespaceStates: [{
        namespace: 'docs:c2', purpose: 'docs', active_generation_id: 7,
        building_generation_id: null, expected_items: 1, indexed_items: 1,
        failed_items: 0, delta_items: 0, last_error: null,
      }],
    });

    await expect(h.coordinator.prepareDocsCollection(2)).resolves.toBeUndefined();
    expect(h.store.beginNamespaceGeneration).not.toHaveBeenCalled();
    expect(h.namespaces.get('docs:c2')).toMatchObject({
      active_generation_id: 7,
      building_generation_id: null,
    });
  });

  it('does not activate docs when a relational fence starts during the physical proof', async () => {
    const content = 'Stable h0 documentation.';
    const hash = hashEmbeddingInput(buildEmbeddingText(null, null, content, null));
    const generation: Generation = {
      id: 7,
      purpose: 'docs',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'docs-model' },
      dimension: 3,
      status: 'building',
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      error: null,
    };
    const h = makeHarness({
      docChunks: [{ id: 7, heading_path: null, content, api_signature: null }],
      semanticItems: {
        'docs:c2': [{
          item_key: 'doc_chunk:7', source_hash: hash, vector_id: 'doc_chunk:7',
          chunk_index: 0, status: 'indexed',
        }],
      },
      existingGeneration: generation,
      namespaceStates: [{
        namespace: 'docs:c2', purpose: 'docs', active_generation_id: null,
        building_generation_id: 7, expected_items: 1, indexed_items: 0,
        failed_items: 0, delta_items: 0, last_error: null,
      }],
    });
    let fence: { job_id: number; token: string } | null = null;
    h.vectorStore.listIds.mockImplementationOnce(async () => {
      // Simulate a writer that committed its pre-mutation fence immediately
      // before changing relational state. Normal API writers also acquire the
      // namespace lock, but the final transaction gate must remain defensive.
      const job = h.store.noteNamespaceMutation({
        namespace: 'docs:c2', itemKeys: ['*'], operation: 'upsert',
        fence: { token: 'during-proof', owner: 'external-writer' },
      });
      fence = { job_id: job.id, token: 'during-proof' };
      return ['doc_chunk:7'];
    });

    await expect(h.coordinator.ensureDocsCollection(2)).rejects.toThrow('delta queue pending');
    expect(fence).not.toBeNull();
    expect(h.namespaces.get('docs:c2')).toMatchObject({
      active_generation_id: null,
      building_generation_id: 7,
      delta_items: 1,
    });

    h.coordinator.endDocsCollectionMutation(fence);
    await expect(h.coordinator.ensureDocsCollection(2)).resolves.toBeUndefined();
    expect(h.namespaces.get('docs:c2')).toMatchObject({
      active_generation_id: 7,
      building_generation_id: null,
      delta_items: 0,
    });
  });

  it('does not start an expensive docs backfill while a source fence is live', async () => {
    const h = makeHarness({ docChunks: [] });
    const fence = await h.coordinator.beginDocsCollectionMutation(2, 'upsert');
    h.docsIndexer.retryEmbeddings.mockClear();

    await expect(h.coordinator.ensureDocsCollection(2)).rejects.toThrow('delta queue pending');
    expect(h.docsIndexer.retryEmbeddings).not.toHaveBeenCalled();

    h.coordinator.endDocsCollectionMutation(fence);
    await expect(h.coordinator.ensureDocsCollection(2)).resolves.toBeUndefined();
    expect(h.docsIndexer.retryEmbeddings).toHaveBeenCalledOnce();
  });

  it('retries failed off-main fence recovery before a later docs mutation', async () => {
    const recoverMutationFences = vi.fn()
      .mockRejectedValueOnce(new Error('maintenance worker restarted'))
      .mockResolvedValueOnce(0);
    const h = makeHarness({ docChunks: [], recoverMutationFences });

    await expect(h.coordinator.beginDocsCollectionMutation(2, 'upsert'))
      .rejects.toThrow('maintenance worker restarted');
    await expect(h.coordinator.beginDocsCollectionMutation(2, 'upsert'))
      .resolves.toMatchObject({ job_id: expect.any(Number), token: expect.any(String) });

    expect(recoverMutationFences).toHaveBeenCalledTimes(2);
    expect(recoverMutationFences).toHaveBeenLastCalledWith(
      ['docs:c', 'snapshot:p', 'memory:project:p', 'memory:user'],
      expect.any(String),
    );
  });

  it('serializes collection deletion behind an in-progress docs build', async () => {
    const content = 'Delete only after build.';
    const hash = hashEmbeddingInput(buildEmbeddingText(null, null, content, null));
    const h = makeHarness({
      docChunks: [{ id: 7, heading_path: null, content, api_signature: null }],
      semanticItems: {
        'docs:c2': [{
          item_key: 'doc_chunk:7', source_hash: hash, vector_id: 'doc_chunk:7',
          chunk_index: 0, status: 'indexed',
        }],
      },
    });
    const retry = deferred<{ embedded: number; tokens: number; total: number }>();
    h.docsIndexer.retryEmbeddings.mockReturnValueOnce(retry.promise);
    const build = h.coordinator.ensureDocsCollection(2);
    await vi.waitFor(() => expect(h.docsIndexer.retryEmbeddings).toHaveBeenCalledOnce());

    const operation = vi.fn(async () => 42);
    const deletion = h.coordinator.runDocsCollectionExclusive(2, operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    retry.resolve({ embedded: 0, tokens: 0, total: 0 });
    await expect(build).resolves.toBeUndefined();
    await expect(deletion).resolves.toBe(42);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not create an orphan fence when ingestion begins during collection deletion', async () => {
    const h = makeHarness({ docChunks: [] });
    const entered = deferred<void>();
    const release = deferred<void>();
    const deletion = h.coordinator.runDocsCollectionExclusive(2, async () => {
      entered.resolve();
      await release.promise;
      h.docStore.listCollections.mockReturnValue([]);
      return 42;
    });
    await entered.promise;

    h.store.noteNamespaceMutation.mockClear();
    const begin = h.coordinator.beginDocsCollectionMutation(2, 'upsert');
    await Promise.resolve();
    expect(h.store.noteNamespaceMutation).not.toHaveBeenCalled();

    release.resolve();
    await expect(deletion).resolves.toBe(42);
    await expect(begin).rejects.toThrow('Documentation collection 2 not found');
    expect(h.store.noteNamespaceMutation).not.toHaveBeenCalled();
    expect(Array.from(h.jobs.values()).filter((job) => job.namespace === 'docs:c2')).toEqual([]);
  });

  it('rejects docs changed during the build and extra stale semantic items', async () => {
    const h = makeHarness({
      docChunks: [{
        id: 7, heading_path: null, content: 'Changed body.', api_signature: null,
        embedding_hash: null, embedding_fingerprint: null,
      }],
      semanticItems: {
        'docs:c2': [
          {
            item_key: 'doc_chunk:7', source_hash: 'old-hash', vector_id: 'doc_chunk:7',
            chunk_index: 0, status: 'indexed',
          },
          {
            item_key: 'doc_chunk:99', source_hash: 'stale', vector_id: 'doc_chunk:99',
            chunk_index: 0, status: 'indexed',
          },
        ],
      },
    });
    const verify = (h.coordinator as unknown as {
      verifyDocsVectorCoverage(collectionId: number, generationId: number, namespace: string): Promise<number>;
    }).verifyDocsVectorCoverage.bind(h.coordinator);

    await expect(verify(2, 11, 'docs:c2'))
      .rejects.toThrow('docs vector coverage incomplete: doc_chunk:7#0 is not current');
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();
  });

  it('gates snapshots on the current source hash and exact chunk coverage', async () => {
    const snapshot = { id: 8, project_id: 1, title: 'Decision', content: 'Use local vectors.' };
    const hash = snapshotEmbeddingTextHash(snapshot, 'local:stable-code-model');
    const h = makeHarness({
      semanticItems: {
        'snapshot:p1': [{
          item_key: 'snapshot:8', source_hash: hash, vector_id: 'sn8',
          chunk_index: 0, status: 'indexed',
        }],
      },
    });
    h.db.listSnapshotsForSemanticIndex.mockReturnValue([snapshot]);
    const verify = (h.coordinator as unknown as {
      verifySnapshotVectorCoverage(projectId: number, generationId: number, namespace: string): Promise<number>;
    }).verifySnapshotVectorCoverage.bind(h.coordinator);

    await expect(verify(1, 11, 'snapshot:p1')).resolves.toBe(1);
    h.store.listItems.mockReturnValueOnce([{
      item_key: 'snapshot:8', source_hash: 'stale', vector_id: 'sn8',
      chunk_index: 0, status: 'indexed',
    }]);
    await expect(verify(1, 11, 'snapshot:p1'))
      .rejects.toThrow('snapshot vector coverage incomplete: snapshot:8#0 is not current');
  });

  it.each([
    ['snapshot:p1', 'snapshot'],
    ['memory:project:p1', 'memory'],
  ] as const)('does not capture or build through a live external %s fence', async (namespace, kind) => {
    const generation: Generation = {
      id: 31,
      purpose: 'memory',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'memory-model' },
      dimension: 3,
      status: 'building',
      expected_items: 0,
      indexed_items: 0,
      failed_items: 0,
      error: null,
    };
    const state: NamespaceState = {
      namespace,
      purpose: 'memory',
      active_generation_id: null,
      building_generation_id: 31,
      expected_items: 0,
      indexed_items: 0,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const h = makeHarness({ existingGeneration: generation, namespaceStates: [state] });
    const fence = h.store.noteNamespaceMutation({
      namespace,
      itemKeys: ['*'],
      operation: 'upsert',
      fence: { token: `${kind}-live`, owner: 'external-mcp' },
    });

    await expect(h.coordinator.ensureMemoryNamespace(namespace))
      .rejects.toThrow(`delta queue pending for ${namespace}`);

    expect(h.jobs.get(fence.id)).toMatchObject({
      status: 'running',
      cursor: expect.objectContaining({ fence_phase: 'in-flight' }),
    });
    expect(h.snapshotService.backfillEmbeddings).not.toHaveBeenCalled();
    expect(h.agentMemoryService.backfillEmbeddings).not.toHaveBeenCalled();
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();

    h.store.settleNamespaceMutationFence({ job_id: fence.id, token: `${kind}-live` });
    await h.coordinator.ensureMemoryNamespace(namespace);
    expect(h.jobs.get(fence.id)).toMatchObject({ status: 'completed' });
  });

  it('reuses a failed memory build, honors its durable cooldown and permits manual recovery', async () => {
    const h = makeHarness();
    h.snapshotService.backfillEmbeddings.mockRejectedValue(new Error('429 Retry-After: 120'));
    await expect(h.coordinator.ensureMemoryNamespace('snapshot:p1')).rejects.toThrow('429');
    const before = Array.from(h.jobs.values()).filter((job) => ['build', 'backfill'].includes(job.kind));
    await expect(h.coordinator.catchUpMemoryNamespace('snapshot:p1')).rejects.toThrow('cooling down');
    expect(h.snapshotService.backfillEmbeddings).toHaveBeenCalledTimes(1);
    await expect(h.coordinator.ensureMemoryNamespace('snapshot:p1')).rejects.toThrow('429');
    expect(Array.from(h.jobs.values()).filter((job) => ['build', 'backfill'].includes(job.kind))).toHaveLength(before.length);
    expect(h.snapshotService.backfillEmbeddings).toHaveBeenCalledTimes(2);
    h.snapshotService.backfillEmbeddings.mockResolvedValue({ total: 0, failed: 0, embedded: 0, skipped: 0 });
    await expect(h.coordinator.ensureMemoryNamespace('snapshot:p1')).resolves.toBeUndefined();
    expect(h.namespaces.get('snapshot:p1')?.active_generation_id).toBeTruthy();
  });

  it('does not activate h0 when a snapshot mutates between logical proof and listIds', async () => {
    const generation: Generation = {
      id: 7,
      purpose: 'memory',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'memory-model' },
      dimension: 3,
      status: 'building',
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      error: null,
    };
    const state: NamespaceState = {
      namespace: 'snapshot:p1',
      purpose: 'memory',
      active_generation_id: null,
      building_generation_id: 7,
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
    };
    const snapshot = {
      id: 8,
      project_id: 1,
      title: 'Decision',
      content: 'h0: use local vectors',
    };
    const items = [{
      item_key: 'snapshot:8',
      source_hash: snapshotEmbeddingTextHash(snapshot, 'local:stable-code-model'),
      vector_id: 'sn8',
      chunk_index: 0,
      status: 'indexed' as const,
    }];
    const h = makeHarness({
      existingGeneration: generation,
      namespaceStates: [state],
      semanticItems: { 'snapshot:p1': items },
    });
    h.db.listSnapshotsForSemanticIndex.mockImplementation(() => [snapshot]);
    h.snapshotService.backfillEmbeddings
      .mockResolvedValueOnce({ embedded: 1, skipped: 0, failed: 0, total: 1 });
    const secondPass = deferred<void>();
    h.snapshotService.backfillEmbeddings.mockImplementationOnce(async () => {
      await secondPass.promise;
      items[0]!.source_hash = snapshotEmbeddingTextHash(snapshot, 'local:stable-code-model');
      return { embedded: 1, skipped: 0, failed: 0, total: 1 };
    });

    // verifyMemoryItems has already accepted h0 when listIds starts. The
    // relational h1 mutation and its durable delta happen synchronously here,
    // before the physical probe returns the still-stable h0 id set.
    h.vectorStore.listIds.mockImplementationOnce(async () => {
      snapshot.content = 'h1: use per-project local vectors';
      const delta = h.store.createJob({
        generation_id: 7,
        namespace: 'snapshot:p1',
        kind: 'delta',
        expected_items: 1,
      });
      h.store.updateNamespaceProgress('snapshot:p1', { delta_items: 1 });
      expect(delta.status).toBe('pending');
      return ['sn8'];
    });

    const run = h.coordinator.ensureMemoryNamespace('snapshot:p1');
    await vi.waitFor(() => expect(h.snapshotService.backfillEmbeddings).toHaveBeenCalledTimes(2));

    expect(h.namespaces.get('snapshot:p1')).toMatchObject({
      active_generation_id: null,
      building_generation_id: 7,
      delta_items: 1,
    });
    expect(h.store.activateNamespaceGeneration).not.toHaveBeenCalled();

    secondPass.resolve();
    await run;

    expect(h.namespaces.get('snapshot:p1')).toMatchObject({
      active_generation_id: 7,
      building_generation_id: null,
      delta_items: 0,
    });
    expect(h.store.activateNamespaceGeneration).toHaveBeenCalledTimes(1);
    expect(Array.from(h.jobs.values()).filter((job) => job.kind === 'delta'))
      .toEqual([expect.objectContaining({ status: 'completed', processed_items: 1 })]);
  });

  it('includes project investigations in Memory generation coverage', async () => {
    const investigationId = 'cd394975-bcc4-4b46-a148-f3406884d1dc';
    const investigation = {
      id: investigationId,
      project_id: 1,
      session_id: '50505c2f-6d28-4ca6-9ed9-fc14bdd60812',
      topic: 'local vector routing',
      summary: 'investigations share the project Memory namespace',
      body: 'details',
      source_label: 'Explore',
      agent_type: 'explore',
      tokens: 42,
      created_at: '2026-07-15 10:00:00',
    };
    const hash = investigationEmbeddingTextHash(investigation, 'local:stable-code-model');
    const h = makeHarness({
      semanticItems: {
        'memory:project:p1': [{
          item_key: `investigation:${investigationId}`, source_hash: hash, vector_id: 'inv17',
          chunk_index: 0, status: 'indexed',
        }],
      },
    });
    h.investigationSemanticIndex.listProject.mockResolvedValue([investigation]);
    const verify = (h.coordinator as unknown as {
      verifyMemoryVectorCoverage(
        scope: 'project' | 'user', projectId: number, generationId: number, namespace: string,
      ): Promise<number>;
    }).verifyMemoryVectorCoverage.bind(h.coordinator);

    await expect(verify('project', 1, 11, 'memory:project:p1')).resolves.toBe(1);
    expect(h.vectorStore.listIds).toHaveBeenCalledWith('memory:project:p1', 11);
  });

  it('drains N exact Memory writes in one targeted pass without a full backfill', async () => {
    const generation: Generation = {
      id: 31,
      purpose: 'memory',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'memory-model' },
      dimension: 3,
      status: 'ready',
      expected_items: 10,
      indexed_items: 10,
      failed_items: 0,
      error: null,
    };
    const namespace = 'memory:project:p1';
    const rows = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      project_id: 1,
      scope: 'project',
      name: `memory-${index + 1}`,
      description: '',
      content: `current content ${index + 1}`,
      archived_at: null,
    }));
    const keys = rows.map((row) => `agent_memory:${row.id}`);
    const beforeItems = rows.map((row) => ({
      item_key: `agent_memory:${row.id}`,
      source_hash: `stale-${row.id}`,
      vector_id: `am-${row.id}`,
      chunk_index: 0,
      status: 'indexed' as const,
    }));
    const afterItems = rows.map((row) => ({
      item_key: `agent_memory:${row.id}`,
      source_hash: agentMemoryEmbeddingTextHash(row as never, 'local:stable-code-model'),
      vector_id: `am-${row.id}`,
      chunk_index: 0,
      status: 'indexed' as const,
    }));
    const h = makeHarness({
      existingGeneration: generation,
      namespaceStates: [{
        namespace,
        purpose: 'memory',
        active_generation_id: 31,
        building_generation_id: null,
        expected_items: 10,
        indexed_items: 10,
        failed_items: 0,
        delta_items: 0,
        last_error: null,
      }],
    });
    const delta = h.store.noteNamespaceMutation({
      namespace,
      itemKeys: keys,
      operation: 'upsert',
    });
    h.db.getAgentMemoryById.mockImplementation((id: number) =>
      rows.find((row) => row.id === id));
    h.store.listItems
      .mockReturnValueOnce(beforeItems)
      .mockReturnValueOnce(afterItems);
    h.vectorStore.listIds.mockResolvedValueOnce(afterItems.map((item) => item.vector_id));

    await expect(h.coordinator.ensureMemoryNamespace(namespace)).resolves.toBeUndefined();

    expect(h.agentMemoryService.backfillEmbeddings).not.toHaveBeenCalled();
    expect(h.db.listAgentMemoryForSemanticIndex).not.toHaveBeenCalled();
    expect(h.agentMemoryService.embedAndUpsert).toHaveBeenCalledTimes(10);
    expect(h.store.finishNamespaceMutationPass).toHaveBeenCalledOnce();
    expect(h.jobs.get(delta.id)).toMatchObject({
      status: 'completed',
      processed_items: 10,
    });
    expect(Array.from(h.jobs.values()).filter((job) =>
      job.cursor?.reason === 'targeted-memory-delta')).toEqual([
      expect.objectContaining({
        status: 'completed',
        expected_items: 10,
        processed_items: 10,
      }),
    ]);
  });

  it.each(['wildcard', 'truncated', 'explicit', 'unknown'] as const)(
    'falls back to a full Memory proof for a %s mutation cursor',
    async (cursorKind) => {
      const generation: Generation = {
        id: 32,
        purpose: 'memory',
        fingerprint: 'local:stable-code-model',
        embedding_target: { kind: 'onnx', model: 'memory-model' },
        dimension: 3,
        status: 'ready',
        expected_items: 0,
        indexed_items: 0,
        failed_items: 0,
        error: null,
      };
      const namespace = 'memory:project:p1';
      const h = makeHarness({
        existingGeneration: generation,
        namespaceStates: [{
          namespace,
          purpose: 'memory',
          active_generation_id: 32,
          building_generation_id: null,
          expected_items: 0,
          indexed_items: 0,
          failed_items: 0,
          delta_items: 0,
          last_error: null,
        }],
      });
      const delta = h.store.noteNamespaceMutation({
        namespace,
        itemKeys: cursorKind === 'wildcard'
          ? ['*']
          : cursorKind === 'unknown'
            ? ['legacy_memory:1']
            : ['agent_memory:1'],
        operation: 'upsert',
      });
      if (cursorKind === 'truncated') {
        delta.cursor = {
          ...(delta.cursor ?? {}),
          item_keys_truncated: true,
        };
      } else if (cursorKind === 'explicit') {
        delta.cursor = {
          ...(delta.cursor ?? {}),
          requires_explicit_reindex: true,
        };
      }

      await expect(h.coordinator.ensureMemoryNamespace(namespace)).resolves.toBeUndefined();

      expect(h.agentMemoryService.backfillEmbeddings).toHaveBeenCalledOnce();
      expect(h.investigationSemanticIndex.backfillProject).toHaveBeenCalledOnce();
      expect(h.agentMemoryService.embedAndUpsert).not.toHaveBeenCalled();
      expect(h.jobs.get(delta.id)?.status).toBe('completed');
      expect(Array.from(h.jobs.values()).some((job) =>
        job.cursor?.reason === 'targeted-memory-delta')).toBe(false);
    },
  );

  it('rejects extra stale memory items even when every current chunk exists', async () => {
    const memory = {
      id: 9, project_id: 1, scope: 'project',
      name: 'local-vectors', description: 'storage', content: 'Keep vectors per project.',
    };
    const hash = agentMemoryEmbeddingTextHash(memory as never, 'local:stable-code-model');
    const h = makeHarness({
      semanticItems: {
        'memory:project:p1': [
          {
            item_key: 'agent_memory:9', source_hash: hash, vector_id: 'am9',
            chunk_index: 0, status: 'indexed',
          },
          {
            item_key: 'agent_memory:99', source_hash: 'stale', vector_id: 'am99',
            chunk_index: 0, status: 'indexed',
          },
        ],
      },
    });
    h.db.listAgentMemoryForSemanticIndex.mockImplementation((scope: string) =>
      scope === 'project' ? [memory] : []);
    const verify = (h.coordinator as unknown as {
      verifyMemoryVectorCoverage(
        scope: 'project' | 'user', projectId: number, generationId: number, namespace: string,
      ): Promise<number>;
    }).verifyMemoryVectorCoverage.bind(h.coordinator);

    await expect(verify('project', 1, 11, 'memory:project:p1'))
      .rejects.toThrow('memory vector coverage incomplete: found 2/1 exact items');
  });

  it('reconciles a g2 memory extra without deleting from active g1', async () => {
    const generation = (id: number): Generation => ({
      id,
      purpose: 'memory',
      fingerprint: 'local:stable-code-model',
      embedding_target: { kind: 'onnx', model: 'stable-code-model' },
      dimension: 3,
      status: id === 11 ? 'building' : 'ready',
      expected_items: 1,
      indexed_items: id === 11 ? 0 : 1,
      failed_items: 0,
      error: null,
    });
    const h = makeHarness({
      existingGenerations: [generation(1), generation(11)],
      namespaceStates: [{
        namespace: 'memory:project:p1', purpose: 'memory',
        active_generation_id: 1, building_generation_id: 11,
        expected_items: 1, indexed_items: 0, failed_items: 0,
        delta_items: 0, last_error: null,
      }],
    });
    const memory = {
      id: 9, project_id: 1, scope: 'project',
      name: 'local-vectors', description: 'storage', content: 'Keep vectors per project.',
    };
    const current = {
      item_key: 'agent_memory:9',
      source_hash: agentMemoryEmbeddingTextHash(memory as never, 'local:stable-code-model'),
      vector_id: 'am9', chunk_index: 0, status: 'indexed' as const,
    };
    const extra = {
      item_key: 'agent_memory:99', source_hash: 'stale', vector_id: 'am99',
      chunk_index: 0, status: 'indexed' as const,
    };
    h.db.listAgentMemoryForSemanticIndex.mockImplementation((scope: string) =>
      scope === 'project' ? [memory] : []);
    h.store.listItems
      .mockReturnValueOnce([current, extra])
      .mockReturnValueOnce([current]);
    h.vectorStore.listIds.mockResolvedValueOnce(['am9']);
    const verify = (h.coordinator as unknown as {
      verifyMemoryVectorCoverage(
        scope: 'project' | 'user', projectId: number, generationId: number, namespace: string,
      ): Promise<number>;
    }).verifyMemoryVectorCoverage.bind(h.coordinator);

    await expect(verify('project', 1, 11, 'memory:project:p1')).resolves.toBe(1);

    expect(h.vectorStore.deleteByItemKeysForGeneration).toHaveBeenCalledWith(
      'memory:project:p1',
      11,
      ['agent_memory:99'],
    );
    expect(h.vectorStore.deleteByIds).not.toHaveBeenCalled();
    expect(h.namespaces.get('memory:project:p1')?.active_generation_id).toBe(1);
  });
});
