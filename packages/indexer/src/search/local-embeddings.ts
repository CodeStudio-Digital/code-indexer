/**
 * Local embedding engine via transformers.js (ONNX/wasm) — no
 * network, no Cloudflare round-trip, no per-query cost. The point of this for
 * a desktop IDE: RAG that works fully offline.
 *
 * The bundled multilingual Granite model uses CLS pooling and raw text.
 * Previously configured E5 indexes retain their document and query prefixes.
 *
 * `@huggingface/transformers` is imported lazily on first use. The desktop
 * HTTP host instantiates this engine only inside semantic-vector-worker; the
 * generic class remains reusable by standalone/CLI processes.
 */
import { createIdleResource, type IdleResource } from '@mcp/shared/utils/idle-disposer.js';
import { createHash } from 'node:crypto';
import { BUNDLED_EMBEDDING_TARGET } from '@mcp/shared/providers/bundled-semantic-model.js';
import type { EmbeddingService } from './embeddings.js';
import { resolveModelCacheDir } from './model-cache.js';
import { resolveBundledEmbeddingPath } from './bundled-model-path.js';
import { resolveOnnxIdleTtlMs } from './onnx-idle.js';
import {
  onnxSessionOptions, preferredOnnxEmbeddingDevice, type OnnxEmbeddingDevice,
} from './onnx-resource-policy.js';
import type { SemanticOnnxDtype } from '@mcp/store/semantic-store.js';

const DEFAULT_MODEL = BUNDLED_EMBEDDING_TARGET.model;
const BATCH = 8;
const COREML_USE_CPU_AND_GPU = 0x020;

/** Minimal shape of the transformers.js feature-extraction pipeline. */
type FeatureExtractor = ((
  texts: string[],
  opts: { pooling: 'mean' | 'cls'; normalize: boolean; truncation: boolean; max_length: number },
) => Promise<{ tolist: () => number[][]; dispose?: () => void }>) & {
  /** Releases the underlying ONNX session(s) — native memory returns to the OS. */
  dispose(): Promise<unknown>;
};

type EmbeddingSession = { extractor: FeatureExtractor; device: OnnxEmbeddingDevice };

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
  const model = input.model || DEFAULT_MODEL;
  const protocol = resolveProtocol(model, input.protocol);
  const bundled = model === BUNDLED_EMBEDDING_TARGET.model;
  const protocolHash = createHash('sha256')
    .update(JSON.stringify({
      revision: input.revision ?? (bundled ? BUNDLED_EMBEDDING_TARGET.revision : ''),
      dtype: input.dtype ?? 'q8',
      ...protocol,
    }))
    .digest('hex')
    .slice(0, 12);
  return `local:${model}:${protocolHash}`;
}

function resolveProtocol(model: string, protocol?: LocalEmbeddingProtocol): Required<LocalEmbeddingProtocol> {
  const bundled = model === BUNDLED_EMBEDDING_TARGET.model;
  return {
    documentTemplate: protocol?.documentTemplate ?? (bundled ? '{text}' : 'passage: {text}'),
    queryTemplate: protocol?.queryTemplate ?? (bundled ? '{text}' : 'query: {text}'),
    pooling: protocol?.pooling ?? (bundled ? 'cls' : 'mean'),
    normalize: protocol?.normalize ?? true,
    maxTokens: Math.max(1, Math.floor(protocol?.maxTokens ?? 512)),
  };
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
  private preferredDevice: OnnxEmbeddingDevice;
  private loadedDevice: OnnxEmbeddingDevice | null = null;
  private readonly lease: IdleResource<EmbeddingSession>;

  constructor(opts?: {
    model?: string;
    cacheDir?: string;
    revision?: string;
    dtype?: SemanticOnnxDtype;
    protocol?: LocalEmbeddingProtocol;
    idleTtlMs?: number;
    device?: 'cpu';
  }) {
    this.model = opts?.model || DEFAULT_MODEL;
    // Only the explicit admin override is stored; the auto default
    // (~/.mcp/models) is resolved lazily at load time via resolveModelCacheDir.
    this.cacheDir = opts?.cacheDir;
    this.revision = opts?.revision;
    this.dtype = opts?.dtype ?? 'q8';
    this.protocol = resolveProtocol(this.model, opts?.protocol);
    this.preferredDevice = opts?.device ?? preferredOnnxEmbeddingDevice();
    // The session used to live forever after first use; the idle lease
    // evicts it after a quiet period and re-creates lazily. `acquire`
    // refcounts, so a dispose can never land mid-inference.
    this.lease = createIdleResource<EmbeddingSession>({
      name: `local-embeddings(${this.model})`,
      idleTtlMs: resolveOnnxIdleTtlMs(opts?.idleTtlMs),
      create: () => this.loadExtractor(),
      destroy: async ({ extractor }) => { await extractor.dispose(); },
    });
  }

  /**
   * Perf-monitor introspection: which model and whether the ONNX session
   * is currently resident in memory (the weights are native allocations —
   * they show in RSS, never in the JS heap).
   */
  diagnostics() {
    return {
      model: this.model,
      dtype: this.dtype,
      dimension: this.dimension,
      loaded: this.lease.isLoaded(),
      executionProvider: this.loadedDevice,
    };
  }

  private async loadExtractor(): Promise<EmbeddingSession> {
    const bundled = this.model === BUNDLED_EMBEDDING_TARGET.model;
    if (bundled && (this.dtype !== BUNDLED_EMBEDDING_TARGET.dtype
      || (this.revision && this.revision !== BUNDLED_EMBEDDING_TARGET.revision))) {
      throw new Error('The bundled Granite embedding model supports the shipped revision in q8.');
    }
    let mod: {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
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
    const modelPath = bundled ? resolveBundledEmbeddingPath() : this.model;
    const sources = bundled ? { local_files_only: true } : {
      cache_dir: resolveModelCacheDir(this.cacheDir),
      local_files_only: this.model === 'Xenova/multilingual-e5-small' && !!process.env.MCP_BUNDLED_SEMANTIC_MODELS_DIR,
      ...(this.revision ? { revision: this.revision } : {}),
    };
    const load = async (device: OnnxEmbeddingDevice): Promise<EmbeddingSession> => {
      const extractor = await mod.pipeline('feature-extraction', modelPath, {
        ...sources,
        dtype: this.dtype,
        device,
        session_options: {
          ...onnxSessionOptions(),
          ...(device === 'dml' ? { enableMemPattern: false } : {}),
          ...(device === 'coreml' ? {
            executionProviders: [{ name: 'coreml', coreMlFlags: COREML_USE_CPU_AND_GPU }],
          } : {}),
        },
      }) as FeatureExtractor;
      if (this.loadedDevice !== device) {
        console.info(`[local-embeddings] ${this.model}: ONNX device=${device}`);
        this.loadedDevice = device;
      }
      return { extractor, device };
    };
    const device = this.preferredDevice;
    try {
      return await load(device);
    } catch (error) {
      if (device === 'cpu') throw error;
      this.fallbackToCpu(device, error);
      return load('cpu');
    }
  }

  private fallbackToCpu(device: OnnxEmbeddingDevice, error: unknown): void {
    this.preferredDevice = 'cpu';
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[local-embeddings] ${device} failed for ${this.model}, using CPU: ${message}`);
  }

  private async withExtractor<T>(run: (extractor: FeatureExtractor) => Promise<T>): Promise<T> {
    let attempted: OnnxEmbeddingDevice | undefined;
    try {
      return await this.lease.acquire(({ extractor, device }) => {
        attempted = device;
        return run(extractor);
      });
    } catch (error) {
      if (!attempted || attempted === 'cpu') throw error;
      if (this.preferredDevice !== 'cpu') {
        this.fallbackToCpu(attempted, error);
        // Wait outside the acquisition so other in-flight GPU calls can finish
        // before the native session is released. New calls await this eviction.
        await this.lease.dispose();
      }
      return this.lease.acquire(({ extractor }) => run(extractor));
    }
  }

  /** transformers.js doesn't surface token counts; estimate for cost parity. */
  private estimateTokens(texts: string[]): number {
    return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    // The whole multi-batch loop runs inside ONE acquire — eviction can
    // never strike between batches of the same embed() call.
    return this.withExtractor(async (extractor) => {
      const vectors: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts
          .slice(i, i + BATCH)
          .map((t) => applyTemplate(this.protocol.documentTemplate, t));
        vectors.push(...await this.extractVectors(extractor, batch));
      }
      return { vectors, tokens: this.estimateTokens(texts) };
    });
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    return this.withExtractor(async (extractor) => {
      const [vector] = await this.extractVectors(extractor, [applyTemplate(this.protocol.queryTemplate, text)]);
      return { vector, tokens: this.estimateTokens([text]) };
    });
  }

  private async extractVectors(extractor: FeatureExtractor, texts: string[]): Promise<number[][]> {
    const output = await extractor(texts, {
      pooling: this.protocol.pooling,
      normalize: this.protocol.normalize,
      truncation: true,
      max_length: this.protocol.maxTokens,
    });
    try {
      const vectors = output.tolist();
      const dimension = this.dimension ?? vectors[0]?.length;
      if (vectors.length !== texts.length || !dimension || vectors.some(vector =>
        vector.length !== dimension || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0),
      )) throw new Error('Local embedding returned invalid vectors');
      this.dimension = dimension;
      return vectors;
    } finally {
      output.dispose?.();
    }
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
    // Keep a single active batch per ONNX session to bound native memory.
    return 1;
  }
}
