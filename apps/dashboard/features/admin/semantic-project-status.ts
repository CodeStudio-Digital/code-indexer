import type {
  ProjectSemanticStatusResult,
  SemanticNamespaceStatusView,
} from './semantic-api.js';

export type ProjectSemanticScope = 'code' | 'snapshot' | 'project_memory';

interface ProjectSemanticScopeSummary {
  scope: ProjectSemanticScope;
  namespace: string;
  status: SemanticNamespaceStatusView | null;
}

interface ProjectSemanticStorageSummary {
  dbPaths: string[];
  sizeBytes: number;
}

const SCOPE_NAMESPACES: ReadonlyArray<{
  scope: ProjectSemanticScope;
  namespace: (projectId: number) => string;
}> = [
  { scope: 'code', namespace: (projectId) => `code:p${projectId}` },
  { scope: 'snapshot', namespace: (projectId) => `snapshot:p${projectId}` },
  { scope: 'project_memory', namespace: (projectId) => `memory:project:p${projectId}` },
];

export function summarizeProjectSemanticScopes(
  result: ProjectSemanticStatusResult,
): ProjectSemanticScopeSummary[] {
  const byNamespace = new Map(
    (result.status?.namespaces ?? []).map((status) => [status.namespace, status]),
  );
  return SCOPE_NAMESPACES.map(({ scope, namespace }) => {
    const id = namespace(result.project.id);
    return { scope, namespace: id, status: byNamespace.get(id) ?? null };
  });
}

/** Counts each physical SQLite file once even though all three project scopes
 * report the same `vectors.db` path and file size. */
export function summarizeProjectVectorStorage(
  scopes: readonly ProjectSemanticScopeSummary[],
): ProjectSemanticStorageSummary {
  const sizeByPath = new Map<string, number>();
  for (const { status } of scopes) {
    if (!status?.dbPath) continue;
    sizeByPath.set(
      status.dbPath,
      Math.max(sizeByPath.get(status.dbPath) ?? 0, status.size_bytes),
    );
  }
  return {
    dbPaths: [...sizeByPath.keys()],
    sizeBytes: [...sizeByPath.values()].reduce((total, size) => total + size, 0),
  };
}
