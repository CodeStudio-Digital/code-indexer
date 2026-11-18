/**
 * Local embedding engine via transformers.js (ONNX/wasm) — no
 * network, no Cloudflare round-trip, no per-query cost. The point of this for
 * a desktop IDE: RAG that works fully offline.
 *
 * Default model is `Xenova/multilingual-e5-small` (384-d) — multilingual so
 * PT-BR comments / snapshots embed well alongside English code identifiers.
 *
 * The e5 family is trained with asymmetric prefixes: documents must be
 * prefixed `passage: ` and queries `query: `. Skipping these measurably hurts
 * retrieval, so they're applied here (not the caller's job).
 *
 * `@huggingface/transformers` is imported lazily on first use. The desktop
 * HTTP host instantiates this engine only inside semantic-vector-worker; the
 * generic class remains reusable by standalone/CLI processes.
 */
import { createIdleResource, type IdleResource } from '@mcp/shared/utils/idle-disposer.js';
import { createHash } from 'node:crypto';
import type { EmbeddingService } from './embeddings.js';
import { resolveModelCacheDir } from './model-cache.js';
import { resolveOnnxIdleTtlMs } from './onnx-idle.js';
import { onnxSessionOptions } from './onnx-resource-policy.js';
import type { SemanticOnnxDtype } from '@mcp/store/semantic-store.js';

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const BATCH = 8;

/** Minimal shape of the transformers.js feature-extraction pipeline. */
type FeatureExtractor = ((
  texts: string[],
  opts: { pooling: 'mean' | 'cls'; normalize: boolean; truncation: boolean; max_length: number },
) => Promise<{ tolist: () => number[][] }>) & {
  /** Releases the underlying ONNX session(s) — native memory returns to the OS. */
  dispose(): Promise<unknown>;
};

export interface LocalEmbeddingProtocol {
  /** Template containing `{text}`. Empty means the raw text. */
  documentTemplate?: string;
  /** Template containing `{text}`. Empty means the raw query. */
  queryTemplate?: string;
  pooling?: 'mean' | 'cls';
  normalize?: boolean;
  maxTokens?: number;
}

export interface LocalEmbeddingFingerprintInput {
  model?: string;
  revision?: string;
  dtype?: SemanticOnnxDtype;
  protocol?: LocalEmbeddingProtocol;
}

/** Pure control-plane fingerprint. It intentionally creates no model/session,
 * allowing Electron main to pin generations while all ONNX objects stay in
 * semantic-vector-worker. */
export function localEmbeddingFingerprint(input: LocalEmbeddingFingerprintInput): string {
  const protocol = {
    documentTemplate: input.protocol?.documentTemplate ?? 'passage: {text}',
    queryTemplate: input.protocol?.queryTemplate ?? 'query: {text}',
    pooling: input.protocol?.pooling ?? 'mean',
    normalize: input.protocol?.normalize ?? true,
    maxTokens: Math.max(1, Math.floor(input.protocol?.maxTokens ?? 512)),
  };
  const protocolHash = createHash('sha256')
    .update(JSON.stringify({
      revision: input.revision ?? '',
      dtype: input.dtype ?? 'q8',
      ...protocol,
    }))
    .digest('hex')
    .slice(0, 12);
  return `local:${input.model || DEFAULT_MODEL}:${protocolHash}`;
}

function applyTemplate(template: string, text: string): string {
  return template.includes('{text}') ? template.replaceAll('{text}', text) : `${template}${text}`;
}

export class LocalEmbeddingService implements EmbeddingService {
  private model: string;
  private cacheDir?: string;
  private revision?: string;
  private dtype: SemanticOnnxDtype;
  private protocol: Required<LocalEmbeddingProtocol>;
  private dimension: number | null = null;
  private lease: IdleResource<FeatureExtractor>;

  constructor(opts?: {
    model?: string;
    cacheDir?: string;
    revision?: string;
    dtype?: SemanticOnnxDtype;
    protocol?: LocalEmbeddingProtocol;
    idleTtlMs?: number;
  }) {
    this.model = opts?.model || DEFAULT_MODEL;
    // Only the explicit admin override is stored; the auto default
    // (~/.mcp/models) is resolved lazily at load time via resolveModelCacheDir.
    this.cacheDir = opts?.cacheDir;
    this.revision = opts?.revision;
    this.dtype = opts?.dtype ?? 'q8';
    this.protocol = {
      // Preserve the existing E5 behavior unless a semantic profile explicitly
      // declares a different model protocol.
      documentTemplate: opts?.protocol?.documentTemplate ?? 'passage: {text}',
      queryTemplate: opts?.protocol?.queryTemplate ?? 'query: {text}',
      pooling: opts?.protocol?.pooling ?? 'mean',
      normalize: opts?.protocol?.normalize ?? true,
      maxTokens: Math.max(1, Math.floor(opts?.protocol?.maxTokens ?? 512)),
    };
    // The session used to live forever after first use; the idle lease
    // evicts it after a quiet period and re-creates lazily. `acquire`
    // refcounts, so a dispose can never land mid-inference.
    this.lease = createIdleResource<FeatureExtractor>({
      name: `local-embeddings(${this.model})`,
      idleTtlMs: resolveOnnxIdleTtlMs(opts?.idleTtlMs),
      create: () => this.loadExtractor(),
      destroy: async (p) => { await p.dispose(); },
    });
  }

  /**
   * Perf-monitor introspection: which model and whether the ONNX session
   * is currently resident in memory (the weights are native allocations —
   * they show in RSS, never in the JS heap).
   */
  diagnostics(): { model: string; dtype: SemanticOnnxDtype; dimension: number | null; loaded: boolean } {
    return {
      model: this.model,
      dtype: this.dtype,
      dimension: this.dimension,
      loaded: this.lease.isLoaded(),
    };
  }

  private async loadExtractor(): Promise<FeatureExtractor> {
    let mod: {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      env?: Record<string, unknown>;
    };
    try {
      const modName = '@huggingface/transformers';
      mod = (await import(/* @vite-ignore */ modName)) as typeof mod;
    } catch (e) {
      throw new Error(
        `Local embeddings require @huggingface/transformers. ` +
          `Install it with: pnpm add @huggingface/transformers (${(e as Error).message})`,
      );
    }
    // Auto-resolve (and create) ~/.mcp/models unless overridden. No env
    // var or manual folder setup required.
    if (mod.env) (mod.env as { cacheDir?: string }).cacheDir = resolveModelCacheDir(this.cacheDir);
    return (await mod.pipeline(
      'feature-extraction',
      this.model,
      {
        dtype: this.dtype,
        session_options: onnxSessionOptions(),
        ...(this.revision ? { revision: this.revision } : {}),
      },
    )) as unknown as FeatureExtractor;
  }

  /** transformers.js doesn't surface token counts; estimate for cost parity. */
  private estimateTokens(texts: string[]): number {
    return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    // The whole multi-batch loop runs inside ONE acquire — eviction can
    // never strike between batches of the same embed() call.
    return this.lease.acquire(async (extractor) => {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts
          .slice(i, i + BATCH)
          .map((t) => applyTemplate(this.protocol.documentTemplate, t));
        const out = await extractor(batch, {
          pooling: this.protocol.pooling,
          normalize: this.protocol.normalize,
          truncation: true,
          max_length: this.protocol.maxTokens,
        });
        const batchVectors = out.tolist();
        this.captureDimension(batchVectors);
        vectors.push(...batchVectors);
      }
      return { vectors, tokens: this.estimateTokens(texts) };
    });
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    return this.lease.acquire(async (extractor) => {
      const out = await extractor([applyTemplate(this.protocol.queryTemplate, text)], {
        pooling: this.protocol.pooling,
        normalize: this.protocol.normalize,
        truncation: true,
        max_length: this.protocol.maxTokens,
      });
      const vector = out.tolist()[0] ?? [];
      this.captureDimension([vector]);
      return { vector, tokens: this.estimateTokens([text]) };
    });
  }

  /** Release the ONNX session now (shutdown). The next embed reloads lazily. */
  async dispose(): Promise<void> {
    await this.lease.dispose();
  }

  fingerprint(): string {
    return localEmbeddingFingerprint({
      model: this.model,
      revision: this.revision,
      dtype: this.dtype,
      protocol: this.protocol,
    });
  }

  maxConcurrency(): number {
    // CPU-bound single ONNX pipeline session — concurrent embed() calls
    // would serialize on the session anyway and only raise peak memory.
    return 1;
  }

  private captureDimension(vectors: number[][]): void {
    for (const vector of vectors) {
      if (vector.length === 0) continue;
      if (this.dimension === null) this.dimension = vector.length;
      else if (this.dimension !== vector.length) {
        throw new Error(`local embedding dimension changed from ${this.dimension} to ${vector.length}`);
      }
    }
  }
}
