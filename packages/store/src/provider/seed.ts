import type { Database as DB } from 'better-sqlite3';
import { listDefinitions as listProviderDefinitions } from '@mcp/services/providers/registry.js';
import * as providers from './providers.js';
import * as embedding from './embedding.js';
import * as vectorStore from './vector-store.js';

type SeedBuiltin = {
  id: string;
  name: string;
  kind: string;
  base_url?: string;
  envKey?: string;
  extra?: Record<string, unknown>;
};

/**
 * Ensure the built-in providers exist as rows so they're visible in the admin
 * UI even before the user sets any API key. Idempotent per-id: only inserts
 * rows that don't exist, never overwrites an existing row.
 *
 * Providers without a matching *_API_KEY env var are inserted as `enabled=0`
 * and `api_key=null`. Providers with an env key are inserted enabled, with
 * the key pre-populated — preserving the .env → DB transition.
 *
 * Promotes the first keyed provider as `is_default=true` only when no
 * default exists yet in the whole table.
 */
export function seedFromEnvIfEmpty(db: DB): void {
  const env = process.env;

  // Each definition has envVars[]. If ANY of its env vars is set, the instance
  // is seeded enabled with the api_key pre-populated. Otherwise the row is
  // inserted disabled so the admin UI can surface it.
  //
  // The instance id matches the shape kind for built-ins, preserving backwards
  // compatibility with existing callers that use -p anthropic.
  const builtins: SeedBuiltin[] = listProviderDefinitions()
    .filter((def) => def.envVars.length > 0)  // only api-key shapes auto-seed
    .map((def) => {
      const envKey = def.envVars.map((v) => env[v]).find(Boolean);
      const extra: Record<string, unknown> = {};
      if (def.capabilities?.zaiCodingMode) extra.zai_has_coding_mode = true;
      return {
        id: def.kind,
        name: def.displayName,
        kind: def.kind,
        base_url: def.defaultBaseURL,
        envKey,
        extra,
      };
    });

  const existingDefault = db
    .prepare('SELECT id FROM provider_configs WHERE is_default = 1 LIMIT 1')
    .get() as { id: string } | undefined;
  let defaultAssigned = !!existingDefault;

  for (const b of builtins) {
    if (providers.get(db, b.id)) continue;
    const hasKey = !!b.envKey;
    const shouldBeDefault = hasKey && !defaultAssigned;
    if (shouldBeDefault) defaultAssigned = true;
    providers.upsert(db, {
      id: b.id,
      name: b.name,
      kind: b.kind,
      base_url: b.base_url ?? null,
      api_key: b.envKey ?? null,
      enabled: hasKey,
      use_for_agent: true,
      use_for_coder: true,
      is_default: shouldBeDefault,
      extra: b.extra ?? {},
    });
  }

  seedEmbeddingAndVectorStore(db, env);
}

function seedEmbeddingAndVectorStore(db: DB, env: NodeJS.ProcessEnv): void {
  // Seed Cloudflare embedding config if worker URL is present in env.
  if (env.MCP_INDEX_WORKER_URL) {
    embedding.upsert(db, {
      id: 'cloudflare',
      kind: 'cloudflare',
      name: 'Cloudflare Vectorize',
      enabled: true,
      is_default: true,
      config: {
        workerUrl: env.MCP_INDEX_WORKER_URL,
        workerToken: env.MCP_INDEX_WORKER_TOKEN ?? '',
        model: env.MCP_INDEX_EMBEDDINGS_MODEL ?? '@cf/baai/bge-base-en-v1.5',
        dimensions: 768,
      },
    });

    // Mirror to vector_store_configs so a fresh install with only legacy .env
    // has a default vector backend visible in the admin UI.
    if (vectorStore.list(db).length === 0) {
      vectorStore.upsert(db, {
        id: 'cloudflare',
        kind: 'cloudflare',
        name: 'Cloudflare Vectorize',
        enabled: true,
        is_default: true,
        config: {
          workerUrl: env.MCP_INDEX_WORKER_URL,
          workerToken: env.MCP_INDEX_WORKER_TOKEN ?? '',
        },
      });
    }
  }

  if (env.QDRANT_URL && !vectorStore.list(db).some((c) => c.id === 'qdrant')) {
    const hasOther = vectorStore.list(db).some((c) => c.is_default);
    vectorStore.upsert(db, {
      id: 'qdrant',
      kind: 'qdrant',
      name: 'Qdrant',
      enabled: true,
      is_default: !hasOther,
      config: {
        url: env.QDRANT_URL,
        collection: env.QDRANT_COLLECTION ?? 'mcp_code_index',
        apiKey: env.QDRANT_API_KEY ?? '',
      },
    });
  }

  if (
    env.PINECONE_HOST &&
    env.PINECONE_API_KEY &&
    !vectorStore.list(db).some((c) => c.id === 'pinecone')
  ) {
    const hasOther = vectorStore.list(db).some((c) => c.is_default);
    vectorStore.upsert(db, {
      id: 'pinecone',
      kind: 'pinecone',
      name: 'Pinecone',
      enabled: true,
      is_default: !hasOther,
      config: {
        host: env.PINECONE_HOST,
        apiKey: env.PINECONE_API_KEY,
        namespace: env.PINECONE_NAMESPACE ?? '',
      },
    });
  }

  // Seed Bedrock OpenSearch if OPENSEARCH_ENDPOINT is set. Uses AWS_REGION +
  // AWS credentials from the same env the Bedrock embedding provider reads.
  if (
    env.OPENSEARCH_ENDPOINT &&
    env.AWS_REGION &&
    !vectorStore.list(db).some((c) => c.id === 'bedrock-opensearch')
  ) {
    const hasOther = vectorStore.list(db).some((c) => c.is_default);
    vectorStore.upsert(db, {
      id: 'bedrock-opensearch',
      kind: 'bedrock-opensearch',
      name: 'Bedrock + OpenSearch',
      enabled: true,
      is_default: !hasOther,
      config: {
        endpoint: env.OPENSEARCH_ENDPOINT,
        region: env.AWS_REGION,
        indexName: env.OPENSEARCH_INDEX ?? 'mcp-code-index',
        serviceName: (env.OPENSEARCH_SERVICE as 'es' | 'aoss' | undefined) ?? 'aoss',
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        sessionToken: env.AWS_SESSION_TOKEN,
      },
    });
  }
}
