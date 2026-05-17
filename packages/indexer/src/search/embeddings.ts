import type { ProviderStore } from '@mcp/store/provider-store.js';

export interface EmbeddingService {
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>;
  embedQuery(text: string): Promise<{ vector: number[]; tokens: number }>;
}

export class CloudflareEmbeddingService implements EmbeddingService {
  private workerUrl: string;
  private authToken: string;
  private batchSize = 100;
  private maxBatchTokens = 50_000; // Cloudflare limit is 60k, keep margin
  private maxSingleTextTokens = 8192; // BGE-M3 max sequence length

  constructor(workerUrl: string, authToken: string) {
    this.workerUrl = workerUrl.replace(/\/$/, '');
    this.authToken = authToken;
  }

  private async fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, init);
      if (response.ok) return response;

      // Only retry on 5xx (server/transient errors)
      if (response.status < 500 || attempt === maxRetries) {
        throw new Error(`Embedding API error: ${response.status} ${await response.text()}`);
      }

      const delay = Math.min(1000 * 2 ** attempt, 8000);
      console.warn(`[embeddings] API returned ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, delay));
    }
    throw new Error('Unreachable');
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private buildBatches(texts: string[]): string[][] {
    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentTokens = 0;

    for (const text of texts) {
      let processed = text;
      if (this.estimateTokens(processed) > this.maxSingleTextTokens) {
        console.warn(`[embeddings] Single text exceeds ${this.maxSingleTextTokens} token limit, truncating (${this.estimateTokens(processed)} est. tokens)`);
        processed = processed.slice(0, this.maxSingleTextTokens * 4);
      }

      const textTokens = this.estimateTokens(processed);

      if (currentBatch.length > 0 &&
          (currentTokens + textTokens > this.maxBatchTokens || currentBatch.length >= this.batchSize)) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }

      currentBatch.push(processed);
      currentTokens += textTokens;
    }

    if (currentBatch.length > 0) batches.push(currentBatch);
    return batches;
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };

    const allVectors: number[][] = [];
    let totalTokens = 0;
    const batches = this.buildBatches(texts);

    for (const batch of batches) {
      const response = await this.fetchWithRetry(`${this.workerUrl}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ texts: batch }),
      });

      const data = await response.json() as { vectors: number[][]; count: number };
      allVectors.push(...data.vectors);

      totalTokens += batch.reduce((sum, t) => sum + this.estimateTokens(t), 0);
    }

    return { vectors: allVectors, tokens: totalTokens };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const result = await this.embed([text]);
    return {
      vector: result.vectors[0] ?? [],
      tokens: result.tokens,
    };
  }
}

/**
 * Amazon Bedrock Titan embeddings. Supports both v1 (amazon.titan-embed-text-v1,
 * 1536 dims) and v2 (amazon.titan-embed-text-v2:0, 1024 dims — default).
 *
 * The AWS SDK is loaded via dynamic import so users who don't use Bedrock
 * don't need to pull in @aws-sdk/client-bedrock-runtime (≈10MB). If the dep
 * is missing the constructor throws with an actionable error.
 *
 * Bedrock doesn't accept batch requests for Titan embeddings — each text
 * costs one InvokeModel call. This is the reality, not a limitation of this
 * wrapper; the indexer caller batches at a higher level and amortizes.
 */
export class BedrockTitanEmbeddingService implements EmbeddingService {
  private region: string;
  private modelId: string;
  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  private clientPromise: Promise<unknown> | null = null;

  constructor(opts: {
    region: string;
    modelId?: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }) {
    this.region = opts.region;
    this.modelId = opts.modelId ?? 'amazon.titan-embed-text-v2:0';
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.sessionToken = opts.sessionToken;
  }

  private async getClient(): Promise<{
    client: { send: (cmd: unknown) => Promise<{ body: Uint8Array }> };
    Command: new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }) => unknown;
  }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        try {
          // Dynamic via variable so TypeScript doesn't require the types to
          // be present at build time. The dep is optional.
          const modName = '@aws-sdk/client-bedrock-runtime';
          const mod = (await import(/* @vite-ignore */ modName)) as {
            BedrockRuntimeClient: new (cfg: unknown) => { send: (cmd: unknown) => Promise<{ body: Uint8Array }> };
            InvokeModelCommand: new (input: unknown) => unknown;
          };
          const client = new mod.BedrockRuntimeClient({
            region: this.region,
            credentials: {
              accessKeyId: this.accessKeyId,
              secretAccessKey: this.secretAccessKey,
              sessionToken: this.sessionToken,
            },
          });
          return { client, Command: mod.InvokeModelCommand as unknown as { new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }): unknown } };
        } catch (e) {
          throw new Error(
            `Bedrock Titan embeddings require @aws-sdk/client-bedrock-runtime. ` +
              `Install it with: pnpm add @aws-sdk/client-bedrock-runtime (${(e as Error).message})`
          );
        }
      })();
    }
    return this.clientPromise as Promise<{
      client: { send: (cmd: unknown) => Promise<{ body: Uint8Array }> };
      Command: new (input: { modelId: string; contentType: string; accept: string; body: Uint8Array }) => unknown;
    }>;
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const { client, Command } = await this.getClient();
    const vectors: number[][] = [];
    let totalTokens = 0;
    for (const text of texts) {
      const body = new TextEncoder().encode(JSON.stringify({ inputText: text }));
      const cmd = new Command({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      });
      const resp = await client.send(cmd);
      const parsed = JSON.parse(new TextDecoder().decode(resp.body)) as {
        embedding: number[];
        inputTextTokenCount?: number;
      };
      vectors.push(parsed.embedding);
      totalTokens += parsed.inputTextTokenCount ?? Math.ceil(text.length / 4);
    }
    return { vectors, tokens: totalTokens };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const r = await this.embed([text]);
    return { vector: r.vectors[0] ?? [], tokens: r.tokens };
  }
}

export class NullEmbeddingService implements EmbeddingService {
  async embed(_texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    return { vectors: [], tokens: 0 };
  }

  async embedQuery(_text: string): Promise<{ vector: number[]; tokens: number }> {
    return { vector: [], tokens: 0 };
  }
}

/**
 * Build an EmbeddingService from the admin-managed embedding_configs table.
 * Priority:
 *   1. Row marked is_default=1 and enabled=1 in provider_store.
 *   2. NullEmbeddingService (no embeddings, search falls back to FTS-only).
 *
 * Legacy .env vars (MCP_INDEX_WORKER_URL/TOKEN) are migrated into the
 * ProviderStore via seedFromEnvIfEmpty() at startup, so they are covered
 * by case 1 after the first run.
 *
 * The function is sync — it only queries SQLite via better-sqlite3 which is
 * synchronous — so callers don't need await.
 */
export function createEmbeddingService(
  store: ProviderStore | null,
): EmbeddingService {
  if (store) {
    const cfg = store.getDefaultEmbedding();
    if (cfg) {
      if (cfg.kind === 'cloudflare') {
        const c = cfg.config as { workerUrl?: string; workerToken?: string };
        if (c.workerUrl) return new CloudflareEmbeddingService(c.workerUrl, c.workerToken ?? '');
      }
      if (cfg.kind === 'bedrock') {
        const c = cfg.config as {
          region?: string;
          modelId?: string;
          accessKeyId?: string;
          secretAccessKey?: string;
          sessionToken?: string;
        };
        if (c.region && c.accessKeyId && c.secretAccessKey) {
          return new BedrockTitanEmbeddingService({
            region: c.region,
            modelId: c.modelId,
            accessKeyId: c.accessKeyId,
            secretAccessKey: c.secretAccessKey,
            sessionToken: c.sessionToken,
          });
        }
      }
    }
  }

  return new NullEmbeddingService();
}
