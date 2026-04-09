import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../../utils/config.js';
import { CodeIndexDB } from '../../store/db.js';
import { createEmbeddingService, NullEmbeddingService } from '../../core/search/embeddings.js';
import type { EmbeddingService } from '../../core/search/embeddings.js';
import { createVectorStore, NullVectorStore, type VectorStore } from '../../store/vectors.js';
import { ProviderStore } from '../../store/provider-store.js';

export function getDB(): CodeIndexDB {
  const config = loadConfig();
  return new CodeIndexDB(config.dbPath);
}

/**
 * Build embedding + vector services for CLI commands. Prefers the admin-managed
 * configs in ProviderStore and falls back to legacy .env values so existing
 * users keep working without reconfiguring.
 */
function buildProviderStore(config: ReturnType<typeof loadConfig>): ProviderStore {
  const store = new ProviderStore(config.dbPath);
  store.seedFromEnvIfEmpty();
  return store;
}

export function getEmbeddingService(config: ReturnType<typeof loadConfig>): EmbeddingService {
  try {
    const store = buildProviderStore(config);
    return createEmbeddingService(
      store,
      config.embeddings.enabled && config.embeddings.workerUrl
        ? { workerUrl: config.embeddings.workerUrl, workerToken: config.embeddings.workerToken }
        : undefined
    );
  } catch {
    return new NullEmbeddingService();
  }
}

export function getVectorStore(config: ReturnType<typeof loadConfig>): VectorStore | null {
  try {
    const store = buildProviderStore(config);
    const vs = createVectorStore(
      store,
      config.embeddings.enabled && config.embeddings.workerUrl
        ? { workerUrl: config.embeddings.workerUrl, workerToken: config.embeddings.workerToken }
        : undefined
    );
    return vs instanceof NullVectorStore ? null : vs;
  } catch {
    return null;
  }
}

export async function promptStdin(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
