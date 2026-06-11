/**
 * Local, in-process embedding service via transformers.js (ONNX/wasm) — no
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
 * `@huggingface/transformers` is imported lazily on first use so the (heavy)
 * ONNX runtime only loads when local embeddings are actually selected.
 */
import type { EmbeddingService } from './embeddings.js';
import { resolveModelCacheDir } from './model-cache.js';

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const BATCH = 32;

/** Minimal shape of the transformers.js feature-extraction pipeline. */
type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

export class LocalEmbeddingService implements EmbeddingService {
  private model: string;
  private cacheDir?: string;
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  constructor(opts?: { model?: string; cacheDir?: string }) {
    this.model = opts?.model || DEFAULT_MODEL;
    // Only the explicit admin override is stored; the auto default
    // (~/.mcp/models) is resolved lazily at load time via resolveModelCacheDir.
    this.cacheDir = opts?.cacheDir;
  }

  private async getExtractor(): Promise<FeatureExtractor> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        let mod: {
          pipeline: (task: string, model: string) => Promise<unknown>;
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
        return (await mod.pipeline('feature-extraction', this.model)) as unknown as FeatureExtractor;
      })();
    }
    return this.extractorPromise;
  }

  /** transformers.js doesn't surface token counts; estimate for cost parity. */
  private estimateTokens(texts: string[]): number {
    return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const extractor = await this.getExtractor();
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map((t) => `passage: ${t}`);
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      vectors.push(...out.tolist());
    }
    return { vectors, tokens: this.estimateTokens(texts) };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const extractor = await this.getExtractor();
    const out = await extractor([`query: ${text}`], { pooling: 'mean', normalize: true });
    const vector = out.tolist()[0] ?? [];
    return { vector, tokens: this.estimateTokens([text]) };
  }

  fingerprint(): string {
    return `local:${this.model}`;
  }

  maxConcurrency(): number {
    // CPU-bound single ONNX pipeline session — concurrent embed() calls
    // would serialize on the session anyway and only raise peak memory.
    return 1;
  }
}
