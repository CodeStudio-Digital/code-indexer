import { SemanticStore, type EmbeddingTarget, type RerankerTarget, type SemanticCapability, type SemanticPurpose } from '@mcp/store/semantic-store.js';
import { createHash } from 'node:crypto';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { semanticTargetContextFingerprint } from '@mcp/indexer/search/semantic-fingerprint.js';
import { resolveProviderSpec } from './model-discovery/index.js';

export function isPurpose(value: string): value is SemanticPurpose {
  return value === 'code' || value === 'docs' || value === 'memory';
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 16);
}

/** Bind an approved target to the provider configuration/authentication that
 * actually passed the probe. Only this digest is persisted; credentials never
 * enter the semantic catalog JSON. */
export function probeFingerprint(
  target: EmbeddingTarget | RerankerTarget,
  providers: ProviderStore,
): string {
  return semanticTargetContextFingerprint(target, providers);
}

function catalogTarget(config: Record<string, unknown> | undefined): unknown {
  return config && 'target' in config ? config.target : config;
}

export function catalogProbeFingerprint(config: Record<string, unknown> | undefined): string | null {
  return config && typeof config.probe_fingerprint === 'string'
    ? config.probe_fingerprint
    : null;
}

function normalizeMaxTokens(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error('maxTokens must be a positive number');
  }
  return Math.floor(value);
}

function normalizeOnnxDtype(value: unknown): 'q8' | 'q4' | 'fp16' | 'fp32' {
  if (value === undefined || value === null || value === '') return 'q8';
  if (value === 'q8' || value === 'q4' || value === 'fp16' || value === 'fp32') return value;
  throw new Error('dtype must be q8, q4, fp16, or fp32');
}

function normalizeTemplate(value: unknown, fallback: string, label: string): string {
  const template = typeof value === 'string' ? value : fallback;
  if (!template.includes('{text}')) throw new Error(`${label} must contain {text}`);
  return template;
}

export function catalogId(
  capability: SemanticCapability,
  target: EmbeddingTarget | RerankerTarget,
): string | null {
  if (target.kind === 'disabled') return null;
  // Preserve migration 227's managed default IDs, while custom ONNX entries
  // include the capability so one repository can expose multiple tasks.
  if (target.kind === 'onnx') {
    const managed = (capability === 'embedding' && target.model === 'Xenova/multilingual-e5-small')
      || (capability === 'rerank' && target.model === 'Xenova/bge-reranker-base');
    return managed ? `onnx:${target.model}` : `onnx:${capability}:${target.model}`;
  }
  if (target.kind === 'provider') {
    return `provider:${target.providerId}:${capability}:${target.protocol}:${target.model}`;
  }
  return `local_http:${capability}:${shortHash(target)}`;
}

export function normalizeEmbeddingTarget(value: unknown): EmbeddingTarget {
  const target = value as Partial<EmbeddingTarget> & Record<string, unknown>;
  if (target.kind === 'disabled') return { kind: 'disabled' };
  const model = typeof target.model === 'string' ? target.model.trim() : '';
  if (!model) throw new Error('embedding target model is required');
  if (target.kind === 'onnx') {
    const e5 = /(?:^|[/_-])e5(?:$|[/_.-])/i.test(model);
    return {
      kind: 'onnx',
      model,
      revision: typeof target.revision === 'string' && target.revision ? target.revision : undefined,
      cacheDir: typeof target.cacheDir === 'string' && target.cacheDir ? target.cacheDir : undefined,
      dtype: normalizeOnnxDtype(target.dtype),
      pooling: target.pooling === 'cls' ? 'cls' : 'mean',
      normalize: target.normalize !== false,
      queryTemplate: normalizeTemplate(
        target.queryTemplate,
        e5 ? 'query: {text}' : '{text}',
        'queryTemplate',
      ),
      documentTemplate: normalizeTemplate(
        target.documentTemplate,
        e5 ? 'passage: {text}' : '{text}',
        'documentTemplate',
      ),
      maxTokens: normalizeMaxTokens(target.maxTokens),
    };
  }
  if (target.kind === 'local_http') {
    const baseUrl = typeof target.baseUrl === 'string' ? target.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!baseUrl) throw new Error('local_http baseUrl is required');
    return { kind: 'local_http', baseUrl, model, protocol: 'openai-embeddings' };
  }
  if (target.kind === 'provider') {
    const providerId = typeof target.providerId === 'string' ? target.providerId.trim() : '';
    if (!providerId) throw new Error('embedding providerId is required');
    const protocol = target.protocol === 'cloudflare' || target.protocol === 'bedrock'
      ? target.protocol
      : 'openai-embeddings';
    return { kind: 'provider', providerId, model, protocol };
  }
  throw new Error('invalid embedding target kind');
}

export function normalizeRerankerTarget(value: unknown): RerankerTarget {
  const target = value as Partial<RerankerTarget> & Record<string, unknown>;
  if (target.kind === 'disabled') return { kind: 'disabled' };
  const model = typeof target.model === 'string' ? target.model.trim() : '';
  if (!model) throw new Error('reranker target model is required');
  if (target.kind === 'onnx') {
    return {
      kind: 'onnx',
      model,
      revision: typeof target.revision === 'string' && target.revision ? target.revision : undefined,
      cacheDir: typeof target.cacheDir === 'string' && target.cacheDir ? target.cacheDir : undefined,
      dtype: normalizeOnnxDtype(target.dtype),
      maxTokens: normalizeMaxTokens(target.maxTokens),
    };
  }
  if (target.kind === 'local_http') {
    const baseUrl = typeof target.baseUrl === 'string' ? target.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!baseUrl) throw new Error('local_http baseUrl is required');
    return {
      kind: 'local_http',
      baseUrl,
      model,
      protocol: target.protocol === 'openai-rerank' ? 'openai-rerank' : 'cohere-rerank',
    };
  }
  if (target.kind === 'provider') {
    const providerId = typeof target.providerId === 'string' ? target.providerId.trim() : '';
    if (!providerId) throw new Error('reranker providerId is required');
    const protocol = target.protocol === 'cloudflare' || target.protocol === 'bedrock'
      ? target.protocol
      : target.protocol === 'openai-rerank'
        ? 'openai-rerank'
        : 'cohere-rerank';
    return { kind: 'provider', providerId, model, protocol };
  }
  throw new Error('invalid reranker target kind');
}

function requiresHeavyFp32Confirmation(
  ...targets: Array<EmbeddingTarget | RerankerTarget>
): boolean {
  return targets.some((target) => target.kind === 'onnx' && target.dtype === 'fp32');
}

export function assertHeavyFp32Confirmed(
  confirmed: unknown,
  ...targets: Array<EmbeddingTarget | RerankerTarget>
): void {
  if (requiresHeavyFp32Confirmation(...targets) && confirmed !== true) {
    throw new Error('FP32 ONNX may use substantially more memory; explicit confirmation is required');
  }
}

export function targetModel(target: EmbeddingTarget | RerankerTarget): string {
  return target.kind === 'disabled' ? 'disabled' : target.model;
}

export function targetProvider(target: EmbeddingTarget | RerankerTarget): string | null {
  return target.kind === 'provider' ? target.providerId : null;
}

export function syncDetectedModels(semantic: SemanticStore, providers: ProviderStore): void {
  const current = new Map(semantic.listModels().map((model) => [model.id, model]));
  const detected = new Set<string>();
  for (const provider of providers.listProviders().filter((row) => row.enabled)) {
    const spec = resolveProviderSpec(provider.kind);
    if (!spec?.semantic) continue;
    for (const capability of ['embedding', 'rerank'] as const) {
      const descriptor = capability === 'embedding' ? spec.semantic.embedding : spec.semantic.rerank;
      if (!descriptor) continue;
      const discovered = providers.listModels(provider.id, true).map((model) => model.model_id);
      const configuredPatterns = descriptor.modelPatterns ?? [];
      const patterns = configuredPatterns.map((pattern) => {
        try { return new RegExp(pattern, 'i'); } catch { return null; }
      }).filter((pattern): pattern is RegExp => pattern !== null);
      const candidates = new Set(descriptor.defaultModels ?? []);
      for (const rawModel of discovered) {
        const model = rawModel.trim();
        if (!model) continue;
        if (configuredPatterns.length === 0 || patterns.some((pattern) => pattern.test(model))) {
          candidates.add(model);
        }
      }
      for (const model of candidates) {
        const target = {
          kind: 'provider', providerId: provider.id, model, protocol: descriptor.protocol,
        } as EmbeddingTarget | RerankerTarget;
        const id = catalogId(capability, target)!;
        detected.add(id);
        const existing = current.get(id);
        const fingerprint = probeFingerprint(target, providers);
        const sameProbe = shortHash(catalogTarget(existing?.config)) === shortHash(target)
          && catalogProbeFingerprint(existing?.config) === fingerprint;
        semantic.upsertModel({
          id,
          capability,
          source: 'detected',
          provider_id: provider.id,
          model_id: model,
          config: { target, probe_fingerprint: fingerprint },
          dimension: sameProbe ? existing?.dimension : null,
          status: sameProbe ? (existing?.status ?? 'unknown') : 'unknown',
          last_probe_error: sameProbe ? existing?.last_probe_error : null,
        });
      }
    }
  }
  for (const model of semantic.listModels({ source: 'detected' })) {
    if (!detected.has(model.id)) semantic.deleteModel(model.id);
  }
}

export function requireSuccessfulProbe(
  semantic: SemanticStore,
  providers: ProviderStore,
  capability: SemanticCapability,
  target: EmbeddingTarget | RerankerTarget,
): void {
  const id = catalogId(capability, target);
  if (!id) return;
  const model = semantic.listModels({ capability }).find((row) => row.id === id);
  const probedTarget = catalogTarget(model?.config);
  // IDs intentionally remain stable so catalog entries do not multiply when
  // protocol details change. Saving, however, must match the complete target
  // that was probed — model name alone is not sufficient.
  if (
    !model
    || model.status !== 'ready'
    || shortHash(probedTarget) !== shortHash(target)
    || catalogProbeFingerprint(model.config) !== probeFingerprint(target, providers)
  ) {
    throw new Error(`${capability} target must pass its probe before it can be saved`);
  }
}
