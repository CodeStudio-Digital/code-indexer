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
    // Fall back to MCP_MODEL_CACHE_DIR so the Electron host can point the
    // model cache at a stable per-user dir (userData/models) without the
    // admin having to set it per config — survives app updates, never
    // written into the read-only asar bundle.
    this.cacheDir = opts?.cacheDir || process.env.MCP_MODEL_CACHE_DIR;
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
        // Pin the model cache to a stable location when configured (Electron
        // packaging sets this so models survive app updates).
        if (this.cacheDir && mod.env) (mod.env as { cacheDir?: string }).cacheDir = this.cacheDir;
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
}
