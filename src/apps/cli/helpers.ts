import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../../utils/config.js';
import { CodeIndexDB } from '../../store/db.js';
import { createEmbeddingService, NullEmbeddingService } from '../../core/search/embeddings.js';
import type { EmbeddingService } from '../../core/search/embeddings.js';
import { createVectorStore, NullVectorStore, type VectorStore } from '../../store/vectors.js';
import { createAndSeedProviderStore } from '../../core/bootstrap/index.js';

export function getDB(): CodeIndexDB {
  const config = loadConfig();
  return new CodeIndexDB(config.dbPath);
}

/**
 * Build embedding + vector services for CLI commands. Uses the admin-managed
 * configs in ProviderStore as the single source of truth. Legacy .env vars
 * are migrated into the store via seedFromEnvIfEmpty().
 */
export function getEmbeddingService(dbPath: string): EmbeddingService {
  try {
    const store = createAndSeedProviderStore(dbPath);
    return createEmbeddingService(store);
  } catch {
    return new NullEmbeddingService();
  }
}

export function getVectorStore(dbPath: string): VectorStore | null {
  try {
    const store = createAndSeedProviderStore(dbPath);
    const vs = createVectorStore(store);
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
