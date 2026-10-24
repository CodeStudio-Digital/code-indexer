import { join, resolve as resolvePath } from 'node:path';
import { statSync } from 'node:fs';
import { mcpDataDir } from '@mcp/shared/utils/config.js';
import type { EmbeddingTarget, SemanticPurpose } from './semantic-store.js';
export function semanticVectorTableName(purpose: SemanticPurpose, generationId: number): string {
  if (!Number.isSafeInteger(generationId) || generationId < 1) {
    throw new Error(`Invalid semantic generation id: ${generationId}`);
  }
  return `${purpose}_g_${generationId}`;
}

export function globalSemanticVectorPaths(dataDir = mcpDataDir()): {
  dir: string;
  docs: string;
  userMemory: string;
} {
  const dir = join(dataDir, 'semantic');
  return {
    dir,
    docs: join(dir, 'docs-vectors.db'),
    userMemory: join(dir, 'memory-vectors.db'),
  };
}

export function parseId(value: string, namespace: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Invalid semantic namespace: ${namespace}`);
  return id;
}

export function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

export function physicalDbKey(dbPath: string): string {
  const absolute = resolvePath(dbPath);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function canonicalTarget(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTarget);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, canonicalTarget(entry)]),
  );
}

export function embeddingTargetsEqual(left: EmbeddingTarget, right: EmbeddingTarget): boolean {
  // SemanticStore hydrates legacy ONNX rows with the managed q8 default. A
  // batch pinned before that hydration may still carry an omitted dtype; both
  // values identify the same immutable space and must compare canonically.
  const withDefaults = (target: EmbeddingTarget): EmbeddingTarget =>
    target.kind === 'onnx' && target.dtype === undefined
      ? { ...target, dtype: 'q8' }
      : target;
  return JSON.stringify(canonicalTarget(withDefaults(left)))
    === JSON.stringify(canonicalTarget(withDefaults(right)));
}

export class SemanticEmbeddingTargetMismatchError extends Error {
  readonly code = 'SEMANTIC_EMBEDDING_TARGET_MISMATCH';

  constructor(namespace: string, generationId: number, detail: string) {
    super(`Refusing semantic upsert for ${namespace} g${generationId}: ${detail}`);
    this.name = 'SemanticEmbeddingTargetMismatchError';
  }
}

export class ProjectSemanticRemovalPendingError extends Error {
  readonly code = 'PROJECT_SEMANTIC_REMOVAL_PENDING';

  constructor(projectId: number) {
    super(`Project ${projectId} semantic removal is pending; vector access is fenced`);
    this.name = 'ProjectSemanticRemovalPendingError';
  }
}
