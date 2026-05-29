/**
 * Admin API client for embedding and vector-store configs.
 *
 * Mirrors the shape of `api.ts` (provider CRUD) but hits the
 * `/api/admin/embeddings` and `/api/admin/vector-stores` endpoints.
 */

export type EmbeddingKind = 'cloudflare' | 'bedrock' | 'local' | 'null';

export type VectorStoreKind =
  | 'cloudflare'
  | 'qdrant'
  | 'bedrock-opensearch'
  | 'pinecone'
  | 'sqlite-vec'
  | 'null';

export type RerankerKind = 'cloudflare' | 'cohere' | 'null';

export interface EmbeddingConfig {
  id: string;
  kind: EmbeddingKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

export interface VectorStoreConfig {
  id: string;
  kind: VectorStoreKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

export interface RerankerConfig {
  id: string;
  kind: RerankerKind;
  name: string;
  enabled: boolean;
  is_default: boolean;
  config: Record<string, unknown>;
  updated_at: string;
}

export async function fetchEmbeddings(): Promise<EmbeddingConfig[]> {
  const r = await fetch('/api/admin/embeddings');
  const j = (await r.json()) as { configs: EmbeddingConfig[] };
  return j.configs;
}

export async function upsertEmbedding(c: EmbeddingConfig): Promise<EmbeddingConfig> {
  const r = await fetch(`/api/admin/embeddings/${encodeURIComponent(c.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: c.kind,
      name: c.name,
      enabled: c.enabled,
      is_default: c.is_default,
      config: c.config,
    }),
  });
  if (!r.ok) throw new Error(`save failed: ${r.status}`);
  return (await r.json()) as EmbeddingConfig;
}

export async function fetchVectorStores(): Promise<VectorStoreConfig[]> {
  const r = await fetch('/api/admin/vector-stores');
  const j = (await r.json()) as { configs: VectorStoreConfig[] };
  return j.configs;
}

export async function upsertVectorStore(c: VectorStoreConfig): Promise<VectorStoreConfig> {
  const r = await fetch(`/api/admin/vector-stores/${encodeURIComponent(c.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: c.kind,
      name: c.name,
      enabled: c.enabled,
      is_default: c.is_default,
      config: c.config,
    }),
  });
  if (!r.ok) throw new Error(`save failed: ${r.status}`);
  return (await r.json()) as VectorStoreConfig;
}

export async function fetchRerankers(): Promise<RerankerConfig[]> {
  const r = await fetch('/api/admin/rerankers');
  const j = (await r.json()) as { configs: RerankerConfig[] };
  return j.configs;
}

export async function upsertReranker(c: RerankerConfig): Promise<RerankerConfig> {
  const r = await fetch(`/api/admin/rerankers/${encodeURIComponent(c.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: c.kind,
      name: c.name,
      enabled: c.enabled,
      is_default: c.is_default,
      config: c.config,
    }),
  });
  if (!r.ok) throw new Error(`save failed: ${r.status}`);
  return (await r.json()) as RerankerConfig;
}

/**
 * Field spec for each kind — drives the dynamic form in the dialog.
 * Keeps the UI generic without requiring a tagged-union schema shared
 * between client and server.
 */
export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
}

export const EMBEDDING_FIELDS: Record<EmbeddingKind, FieldSpec[]> = {
  cloudflare: [
    { key: 'workerUrl', label: 'Worker URL', type: 'text', placeholder: 'https://mcp-indexer.you.workers.dev', required: true },
    { key: 'workerToken', label: 'Worker Token', type: 'password' },
    { key: 'model', label: 'Model', type: 'text', placeholder: '@cf/baai/bge-base-en-v1.5' },
    { key: 'dimensions', label: 'Dimensions', type: 'text', placeholder: '768' },
  ],
  bedrock: [
    { key: 'region', label: 'AWS Region', type: 'text', placeholder: 'us-east-1', required: true },
    { key: 'model', label: 'Model ID', type: 'text', placeholder: 'amazon.titan-embed-text-v2:0' },
    { key: 'dimensions', label: 'Dimensions', type: 'text', placeholder: '1024' },
    { key: 'accessKeyId', label: 'Access Key ID (optional)', type: 'text' },
    { key: 'secretAccessKey', label: 'Secret Access Key (optional)', type: 'password' },
  ],
  local: [
    { key: 'model', label: 'Model', type: 'text', placeholder: 'Xenova/multilingual-e5-small' },
    { key: 'cacheDir', label: 'Model Cache Dir (optional)', type: 'text' },
  ],
  null: [],
};

export const VECTOR_STORE_FIELDS: Record<VectorStoreKind, FieldSpec[]> = {
  cloudflare: [
    { key: 'workerUrl', label: 'Worker URL', type: 'text', placeholder: 'https://mcp-indexer.you.workers.dev', required: true },
    { key: 'workerToken', label: 'Worker Token', type: 'password' },
  ],
  qdrant: [
    { key: 'url', label: 'Qdrant URL', type: 'text', placeholder: 'http://localhost:6333', required: true },
    { key: 'collection', label: 'Collection', type: 'text', placeholder: 'mcp_code_index' },
    { key: 'apiKey', label: 'API Key (optional)', type: 'password' },
  ],
  'bedrock-opensearch': [
    { key: 'endpoint', label: 'OpenSearch Endpoint', type: 'text', placeholder: 'https://xxx.us-east-1.aoss.amazonaws.com', required: true },
    { key: 'region', label: 'AWS Region', type: 'text', placeholder: 'us-east-1', required: true },
    { key: 'indexName', label: 'Index Name', type: 'text', placeholder: 'mcp-code-index' },
    {
      key: 'serviceName',
      label: 'Service',
      type: 'select',
      options: [
        { value: 'aoss', label: 'Serverless (aoss)' },
        { value: 'es', label: 'Managed (es)' },
      ],
    },
    { key: 'accessKeyId', label: 'Access Key ID (optional)', type: 'text' },
    { key: 'secretAccessKey', label: 'Secret Access Key (optional)', type: 'password' },
  ],
  pinecone: [
    { key: 'host', label: 'Index Host', type: 'text', placeholder: 'my-index-abcd.svc.us-east-1-aws.pinecone.io', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    { key: 'namespace', label: 'Namespace (optional)', type: 'text' },
  ],
  'sqlite-vec': [
    { key: 'path', label: 'Database Path (optional)', type: 'text', placeholder: 'defaults beside the index DB' },
  ],
  null: [],
};

export const RERANKER_FIELDS: Record<RerankerKind, FieldSpec[]> = {
  cloudflare: [
    { key: 'workerUrl', label: 'Worker URL', type: 'text', placeholder: 'https://mcp-indexer.you.workers.dev', required: true },
    { key: 'workerToken', label: 'Worker Token', type: 'password' },
  ],
  cohere: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true },
    { key: 'model', label: 'Model', type: 'text', placeholder: 'rerank-v3.5' },
  ],
  null: [],
};
