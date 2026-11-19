import { semanticJobIsExecuting, type SemanticGenerationView, type SemanticJobView, type SemanticModelView, type SemanticNamespaceStatusView, type SemanticProfilePurpose, type SemanticProfileView, type SemanticTarget, type SemanticTargetKind } from './semantic-api.js';
import type { AdminProvider } from './types.js';
import { BUNDLED_EMBEDDING_TARGET } from '@mcp/shared/providers/bundled-semantic-model.js';

export const PURPOSES: SemanticProfilePurpose[] = ['code', 'docs', 'memory'];

function defaultTarget(capability: 'embedding' | 'rerank'): SemanticTarget {
  if (capability === 'embedding') {
    return { ...BUNDLED_EMBEDDING_TARGET };
  }
  return { kind: 'onnx', model: 'auto', dtype: 'q8' };
}

export function fallbackProfile(purpose: SemanticProfilePurpose): SemanticProfileView {
  return {
    purpose,
    embedding_target: defaultTarget('embedding'),
    reranker_target: defaultTarget('rerank'),
  };
}

export function targetModel(target: SemanticTarget): string | null {
  return target.kind === 'disabled' ? null : target.model;
}

export function targetSource(target: SemanticTarget, providers: AdminProvider[]): string {
  if (target.kind === 'provider') {
    return providers.find((provider) => provider.id === target.providerId)?.name ?? target.providerId;
  }
  if (target.kind === 'local_http') return target.baseUrl;
  if (target.kind === 'onnx') return `${target.kind} · ${target.dtype ?? 'q8'}`;
  return target.kind;
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function targetIsComplete(target: SemanticTarget): boolean {
  if (target.kind === 'disabled') return true;
  if (!target.model.trim()) return false;
  if (target.kind === 'provider') return !!target.providerId.trim();
  if (target.kind === 'local_http') return isLoopbackUrl(target.baseUrl);
  return true;
}

export function modelId(model: SemanticModelView): string {
  return model.model_id;
}

export function latestGeneration(
  purpose: SemanticProfilePurpose,
  generations: SemanticGenerationView[],
): SemanticGenerationView | null {
  const matches = generations.filter((generation) => generation.purpose === purpose);
  const building = matches.find((generation) => generation.status === 'building');
  if (building) return building;
  return matches[0] ?? null;
}

export function generationProgress(generation: SemanticGenerationView | null): {
  indexed: number;
  total: number;
  failed: number;
  percent: number;
} {
  const indexed = generation?.indexed_items ?? 0;
  const total = generation?.expected_items ?? 0;
  const failed = generation?.failed_items ?? 0;
  return {
    indexed,
    total,
    failed,
    percent: total > 0 ? Math.min(100, (indexed / total) * 100) : 0,
  };
}

export function generationVariant(status: string | undefined) {
  if (status === 'ready') return 'success' as const;
  if (status === 'failed') return 'destructive' as const;
  if (status === 'building') return 'info' as const;
  if (status === 'retired') return 'muted' as const;
  return 'warning' as const;
}

function semanticJobPurpose(
  job: SemanticJobView,
  generations: SemanticGenerationView[],
): SemanticProfilePurpose | null {
  if (job.namespace === 'semantic:reindex:code'
    || job.namespace.startsWith('semantic:reindex:code:p')
    || job.namespace.startsWith('code:p')) return 'code';
  if (job.namespace === 'semantic:reindex:docs'
    || job.namespace.startsWith('docs:')) return 'docs';
  if (job.namespace === 'semantic:reindex:memory'
    || job.namespace.startsWith('snapshot:p')
    || job.namespace.startsWith('memory:')) return 'memory';
  if (job.generation_id != null) {
    return generations.find((generation) => Number(generation.id) === job.generation_id)?.purpose ?? null;
  }
  return null;
}

export function isExecutingSemanticJob(job: SemanticJobView): boolean {
  return semanticJobIsExecuting(job);
}

export function latestPurposeJob(
  purpose: SemanticProfilePurpose,
  jobs: SemanticJobView[],
  generations: SemanticGenerationView[],
): SemanticJobView | null {
  const matches = jobs
    .filter((job) => semanticJobPurpose(job, generations) === purpose)
    .sort((left, right) => right.id - left.id);
  return matches.find(isExecutingSemanticJob)
    ?? matches[0]
    ?? null;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / (1024 ** unit);
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function coveragePercent(status: SemanticNamespaceStatusView | null): number {
  if (!status?.expected_items) return 0;
  return Math.min(100, (status.indexed_items / status.expected_items) * 100);
}

export function targetForKind(
  kind: SemanticTargetKind,
  capability: 'embedding' | 'rerank',
  providers: AdminProvider[],
): SemanticTarget {
  if (kind === 'disabled') return { kind: 'disabled' };
  if (kind === 'onnx') return defaultTarget(capability);
  if (kind === 'local_http') {
    return {
      kind,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: '',
      protocol: capability === 'embedding' ? 'openai-embeddings' : 'openai-rerank',
    };
  }
  const provider = providers.find((item) => item.enabled) ?? providers[0];
  const protocol =
    provider?.kind === 'cloudflare'
      ? 'cloudflare'
      : provider?.kind === 'bedrock'
        ? 'bedrock'
        : capability === 'embedding'
          ? 'openai-embeddings'
          : 'openai-rerank';
  return { kind, providerId: provider?.id ?? '', model: '', protocol };
}
