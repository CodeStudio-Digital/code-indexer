import { semanticVectorTableName, globalSemanticVectorPaths, parseId, fileSize, physicalDbKey, embeddingTargetsEqual, SemanticEmbeddingTargetMismatchError, ProjectSemanticRemovalPendingError } from './local-vector-values.js';
import type { LocalSemanticNamespace, LocalVectorRoute, LocalVectorRouterOptions, LocalVectorNamespaceStatus } from './local-vector-router-types.js';
import { dirname, join } from 'node:path';

import { mcpDataDir } from '@mcp/shared/utils/config.js';
import { resolveProjectDbLocation } from './project-db/paths.js';
import { ProjectVectorStorePool } from './project-vector-store-pool.js';

import { generationMatchesEmbeddingFingerprint, type VectorWriteTarget } from './vectors.js';
import type { SemanticNamespaceGenerationRow, SemanticPurpose } from './semantic-store.js';
export class LocalVectorRouteResolver {
  readonly pool: ProjectVectorStorePool;
  protected readonly dataDir: string;
  protected readonly env: NodeJS.ProcessEnv;

  constructor(protected readonly options: LocalVectorRouterOptions) {
    this.dataDir = options.dataDir ?? mcpDataDir(options.env);
    this.env = options.env ?? process.env;
    this.pool = options.pool ?? new ProjectVectorStorePool({
      maxOpen: options.maxOpen ?? 8,
      idleTtlMs: options.idleTtlMs ?? 60_000,
    });
  }

  resolve(namespace: string, generationId: number): LocalVectorRoute {
    const table = (purpose: SemanticPurpose): string => semanticVectorTableName(purpose, generationId);
    let match = /^code:p(\d+)$/.exec(namespace);
    if (match) return this.projectRoute(namespace, parseId(match[1], namespace), generationId, 'code', 'code', table('code'));
    match = /^snapshot:p(\d+)$/.exec(namespace);
    if (match) return this.projectRoute(namespace, parseId(match[1], namespace), generationId, 'memory', 'snapshot', table('memory'));
    match = /^memory:project:p(\d+)$/.exec(namespace);
    if (match) return this.projectRoute(namespace, parseId(match[1], namespace), generationId, 'memory', 'project_memory', table('memory'));
    match = /^docs:c(\d+)$/.exec(namespace);
    if (match) {
      const collectionId = parseId(match[1], namespace);
      return {
        namespace: namespace as LocalSemanticNamespace,
        purpose: 'docs', scope: 'docs', projectId: null, collectionId,
        generationId, dbPath: globalSemanticVectorPaths(this.dataDir).docs, tableName: table('docs'),
      };
    }
    if (namespace === 'memory:user') {
      return {
        namespace, purpose: 'memory', scope: 'user_memory', projectId: null, collectionId: null,
        generationId, dbPath: globalSemanticVectorPaths(this.dataDir).userMemory, tableName: table('memory'),
      };
    }
    throw new Error(`Unsupported semantic namespace: ${namespace}`);
  }

  /** Resolve the immutable generation currently serving search traffic. */
  resolveForRead(namespace: string): LocalVectorRoute | null {
    const state = this.namespaceState(namespace);
    if (!state?.active_generation_id) return null;
    const route = this.resolve(namespace, state.active_generation_id);
    return this.projectAccessBlocked(route) ? null : route;
  }

  /** Writes build the replacement generation; without one, update the active generation. */
  resolveForWrite(namespace: string): LocalVectorRoute | null {
    const state = this.namespaceState(namespace);
    const generationId = state?.building_generation_id ?? state?.active_generation_id;
    if (!generationId) return null;
    const route = this.resolve(namespace, generationId);
    return this.projectAccessBlocked(route) ? null : route;
  }

  getNamespaceStatus(namespace: string): LocalVectorNamespaceStatus {
    return this.buildNamespaceStatus(namespace, this.namespaceState(namespace));
  }

  /** Resolve a diagnostics snapshot with one namespace-state query and one
   * filesystem size probe per physical database. Admin surfaces commonly ask
   * for code, snapshots and memory together; those share the same vectors.db. */
  getNamespaceStatuses(namespaces: string[]): LocalVectorNamespaceStatus[] {
    const states = this.options.semanticStore?.listNamespaceGenerations() ?? [];
    const stateByNamespace = new Map(states.map((state) => [state.namespace, state]));
    const sizeByDbPath = new Map<string, number>();
    return namespaces.map((namespace) => this.buildNamespaceStatus(
      namespace,
      stateByNamespace.get(namespace) ?? null,
      sizeByDbPath,
    ));
  }

  protected buildNamespaceStatus(
    namespace: string,
    state: SemanticNamespaceGenerationRow | null,
    sizeByDbPath?: Map<string, number>,
  ): LocalVectorNamespaceStatus {
    // Generation 1 is used only to parse the namespace and resolve its physical path.
    const base = this.resolve(namespace, state?.active_generation_id ?? state?.building_generation_id ?? 1);
    const dbKey = physicalDbKey(base.dbPath);
    let sizeBytes = sizeByDbPath?.get(dbKey);
    if (sizeBytes === undefined) {
      sizeBytes = ['', '-wal', '-shm'].reduce(
        (total, suffix) => total + fileSize(base.dbPath + suffix),
        0,
      );
      sizeByDbPath?.set(dbKey, sizeBytes);
    }
    return {
      namespace,
      purpose: state?.purpose ?? base.purpose,
      dbPath: base.dbPath,
      size_bytes: sizeBytes,
      active: state?.active_generation_id ? this.resolve(namespace, state.active_generation_id) : null,
      building: state?.building_generation_id ? this.resolve(namespace, state.building_generation_id) : null,
      expected_items: state?.expected_items ?? 0,
      indexed_items: state?.indexed_items ?? 0,
      failed_items: state?.failed_items ?? 0,
      delta_items: state?.delta_items ?? 0,
      last_error: state?.last_error ?? null,
      updated_at: state?.updated_at ?? null,
    };
  }

  /** Last-line defense against vectors produced by a newly-saved profile being
   * written into an older active/building table with the same dimension. The
   * worker owns the real SemanticStore, so production writes always pass here. */
  protected assertCurrentWriteTarget(route: LocalVectorRoute): void {
    const semantic = this.options.semanticStore;
    if (!semantic?.getGeneration || !semantic.getProfile) return;
    const generation = semantic.getGeneration(route.generationId);
    if (!generation) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation metadata is missing',
      );
    }
    if (generation.purpose !== route.purpose) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `generation purpose ${generation.purpose} does not match ${route.purpose}`,
      );
    }
    const profile = semantic.getProfile(route.purpose);
    if (!profile) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `semantic profile ${route.purpose} is missing`,
      );
    }
    if (profile.embedding_target.kind === 'disabled') {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `semantic profile ${route.purpose} is disabled`,
      );
    }
    if (!embeddingTargetsEqual(generation.embedding_target, profile.embedding_target)) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation embedding target differs from the current semantic profile',
      );
    }
  }

  protected assertPinnedWriteTarget(route: LocalVectorRoute, target: VectorWriteTarget): void {
    if (target.generationId !== route.generationId) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `batch pins generation ${target.generationId}`,
      );
    }
    const semantic = this.options.semanticStore;
    if (!semantic?.getGeneration) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation metadata cannot be validated',
      );
    }
    const generation = semantic.getGeneration(route.generationId);
    if (!generation || generation.purpose !== route.purpose) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation metadata is missing or belongs to another purpose',
      );
    }
    const state = this.namespaceState(route.namespace);
    if (!state || (state.active_generation_id !== route.generationId
      && state.building_generation_id !== route.generationId)) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'generation is no longer referenced by the namespace',
      );
    }
    if (generation.status === 'failed' || generation.status === 'retired') {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        `generation status is ${generation.status}`,
      );
    }
    if (generation.fingerprint !== target.generationFingerprint) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'batch generation fingerprint differs from persisted metadata',
      );
    }
    if (!embeddingTargetsEqual(generation.embedding_target, target.embeddingTarget)) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'batch embedding target differs from persisted generation target',
      );
    }
    if (!generationMatchesEmbeddingFingerprint(
      target.generationFingerprint,
      target.embeddingFingerprint,
    )) {
      throw new SemanticEmbeddingTargetMismatchError(
        route.namespace,
        route.generationId,
        'batch embedding fingerprint does not identify the generation space',
      );
    }
  }

  protected projectRoute(
    namespace: string,
    projectId: number,
    generationId: number,
    purpose: SemanticPurpose,
    scope: LocalVectorRoute['scope'],
    tableName: string,
  ): LocalVectorRoute {
    return {
      namespace: namespace as LocalSemanticNamespace,
      purpose, scope, projectId, collectionId: null, generationId,
      dbPath: this.projectVectorsPath(projectId), tableName,
    };
  }

  protected projectVectorsPath(projectId: number): string {
    const project = this.options.resolveProject(projectId);
    if (!project) throw new Error(`Unknown project id: ${projectId}`);
    const persistedDbPath = project.dbPath ?? project.db_path;
    if (persistedDbPath) return join(dirname(persistedDbPath), 'vectors.db');
    const rootPath = project.rootPath ?? project.root_path;
    return resolveProjectDbLocation(projectId, rootPath, {
      env: this.env,
      forceFallback: this.options.forceProjectFallback,
    }).vectorsPath;
  }

  protected namespaceState(namespace: string): SemanticNamespaceGenerationRow | null {
    if (!this.options.semanticStore) return null;
    return this.options.semanticStore.listNamespaceGenerations({ namespace })[0] ?? null;
  }

  protected projectAccessBlocked(route: LocalVectorRoute): boolean {
    return route.projectId !== null
      && this.options.semanticStore?.hasProjectRemovalRequest?.(route.projectId) === true;
  }

  protected assertProjectAccessAllowed(route: LocalVectorRoute): void {
    if (this.projectAccessBlocked(route)) {
      throw new ProjectSemanticRemovalPendingError(route.projectId!);
    }
  }
}
