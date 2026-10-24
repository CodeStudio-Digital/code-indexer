import type { SemanticPurpose, MemoryNamespaceSource, EmbeddingTarget, RerankerTarget, SemanticProfileRow, SemanticGenerationRow, SemanticModelCatalogRow, SemanticJobRow, JsonProfileRow, JsonGenerationRow, JsonModelRow, JsonJobRow } from './semantic-store-types.js';
export function semanticPurposeForNamespace(namespace: string): SemanticPurpose {
  if (/^code:p\d+$/.test(namespace)) return 'code';
  if (/^docs:c\d+$/.test(namespace)) return 'docs';
  if (/^(?:snapshot:p\d+|memory:project:p\d+|memory:user)$/.test(namespace)) return 'memory';
  throw new Error(`Unsupported semantic namespace: ${namespace}`);
}

export function memoryNamespaceSource(namespace: string): MemoryNamespaceSource | null {
  if (namespace === 'memory:user') return { scope: 'user', projectId: 0 };
  const match = /^memory:project:p(\d+)$/.exec(namespace);
  if (!match) return null;
  const projectId = Number(match[1]);
  return Number.isSafeInteger(projectId) && projectId > 0
    ? { scope: 'project', projectId }
    : null;
}

export const PROJECT_REMOVAL_NAMESPACE_PREFIX = 'project-removal:p';

export function projectRemovalNamespace(projectId: number): string {
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error(`Invalid project id for semantic removal: ${projectId}`);
  }
  return `${PROJECT_REMOVAL_NAMESPACE_PREFIX}${projectId}`;
}

export function projectIdFromRemovalNamespace(namespace: string): number | null {
  const match = /^project-removal:p(\d+)$/.exec(namespace);
  if (!match) return null;
  const projectId = Number(match[1]);
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null;
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function withEmbeddingDefaults(target: EmbeddingTarget): EmbeddingTarget {
  return target.kind === 'onnx' && target.dtype === undefined
    ? { ...target, dtype: 'q8' }
    : target;
}

export function withRerankerDefaults(target: RerankerTarget): RerankerTarget {
  return target.kind === 'onnx' && target.dtype === undefined
    ? { ...target, dtype: 'q8' }
    : target;
}

export function hydrateProfile(row: JsonProfileRow): SemanticProfileRow {
  return {
    ...row,
    embedding_target: withEmbeddingDefaults(parseJson<EmbeddingTarget>(row.embedding_target)),
    reranker_target: withRerankerDefaults(parseJson<RerankerTarget>(row.reranker_target)),
  };
}

export function hydrateGeneration(row: JsonGenerationRow): SemanticGenerationRow {
  return {
    ...row,
    embedding_target: withEmbeddingDefaults(parseJson<EmbeddingTarget>(row.embedding_target)),
  };
}

export function hydrateModel(row: JsonModelRow): SemanticModelCatalogRow {
  return { ...row, config: parseJson<Record<string, unknown>>(row.config) };
}

export function hydrateJob(row: JsonJobRow): SemanticJobRow {
  return { ...row, cursor: row.cursor ? parseJson<Record<string, unknown>>(row.cursor) : null };
}
