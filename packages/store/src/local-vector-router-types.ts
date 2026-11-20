import { ProjectVectorStorePool } from './project-vector-store-pool.js';
import type { SemanticPurpose, SemanticStore } from './semantic-store.js';
export type LocalSemanticNamespace =
  | `code:p${number}`
  | `snapshot:p${number}`
  | `memory:project:p${number}`
  | `docs:c${number}`
  | 'memory:user';

export interface LocalVectorProject {
  id: number;
  rootPath?: string | null;
  root_path?: string | null;
  dbPath?: string | null;
  db_path?: string | null;
}

export interface LocalVectorRoute {
  namespace: LocalSemanticNamespace;
  purpose: SemanticPurpose;
  scope: 'code' | 'snapshot' | 'project_memory' | 'docs' | 'user_memory';
  projectId: number | null;
  collectionId: number | null;
  generationId: number;
  dbPath: string;
  tableName: string;
}

export interface LocalVectorRouterOptions {
  resolveProject: (projectId: number) => LocalVectorProject | null | undefined;
  semanticStore?: Pick<SemanticStore, 'listNamespaceGenerations'>
    & Partial<Pick<SemanticStore,
      | 'deleteNamespace'
      | 'getGeneration'
      | 'getProfile'
      | 'getProjectTargets'
      | 'listItems'
      | 'upsertItem'
      | 'deleteItemsByVectorIds'
      | 'deleteItemsByItemKeys'
      | 'deleteItemsForNamespaceGeneration'
      | 'hasProjectRemovalRequest'
    >>;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  forceProjectFallback?: boolean;
  pool?: ProjectVectorStorePool;
  maxOpen?: number;
  idleTtlMs?: number;
}

export interface LocalVectorNamespaceStatus {
  namespace: string;
  purpose: SemanticPurpose;
  dbPath: string;
  size_bytes: number;
  active: LocalVectorRoute | null;
  building: LocalVectorRoute | null;
  expected_items: number;
  indexed_items: number;
  failed_items: number;
  delta_items: number;
  last_error: string | null;
  updated_at: string | null;
}
