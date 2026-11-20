import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { get as getProvider } from '@mcp/store/provider/providers.js';
import { OpenAICompatEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { NormalizedEmbeddingService } from '@mcp/indexer/search/semantic-targets.js';
import { OpenAICompatibleReranker } from '@mcp/indexer/search/reranker.js';
import { verifySemanticRetrieval, type SearchDiagnostics } from '@mcp/indexer/search/hybrid.js';

export const embedModel = 'nvidia/nemotron-3-embed-1b:free';
export const rerankModel = 'nvidia/nemotron-3.5-rerank-8b:free';
const base = 'https://openrouter.ai/api/v1';

export function verifyNemotronRanking(diag: SearchDiagnostics, previouslyScreened: boolean): 'reranked' | 'provider-screened-rrf' {
  const refusal = /content safety screening/i.test(diag.rerankerError ?? '');
  const onlyRerankerFailed = refusal && diag.effectiveMode === 'hybrid'
    && diag.fallbackReason === diag.rerankerError && !diag.vectorError;
  verifySemanticRetrieval(onlyRerankerFailed ? { ...diag, rerankerError: undefined, fallback: false } : diag, true);
  if (previouslyScreened || refusal) return 'provider-screened-rrf';
  if (!diag.rerankerApplied) throw new Error('Expected an applied Nemotron reranker');
  return 'reranked';
}

/** An explicit opt-in benchmark. Only the two repository subtrees selected by
 * bench-rag-repository enter requests. Cache successful responses by exact wire
 * payload so interrupted runs and paired ablations reuse identical inference. */
export function openNemotronBenchmark(cachePath: string) {
  const catalog = new Database(join(homedir(), '.mcp-code-indexer', 'index.db'), { readonly: true, fileMustExist: true });
  let key: string;
  try {
    const provider = getProvider(catalog, 'openrouter');
    if (!provider?.enabled || !provider.api_key || (provider.base_url && provider.base_url.replace(/\/$/, '') !== base)) {
      throw new Error('Expected the enabled OpenRouter provider at its official endpoint');
    }
    key = provider.api_key;
  } finally { catalog.close(); }
  const cache = new Database(cachePath);
  cache.exec('CREATE TABLE IF NOT EXISTS responses (digest TEXT PRIMARY KEY, response TEXT NOT NULL)');
  cache.exec('CREATE TABLE IF NOT EXISTS screened_queries (digest TEXT PRIMARY KEY)');
  const queryDigest = (query: string) => createHash('sha256').update(rerankModel).update(query).digest('hex');
  const original = globalThis.fetch;
  const usage = { requests: 0, cacheHits: 0, tokensReported: 0, costReportedUSD: 0, costReports: 0 };
  globalThis.fetch = async (url, init) => {
    const body = String(init?.body);
    const model = JSON.parse(body).model as string;
    const endpoint = String(url);
    if (!((endpoint === base + '/embeddings' && model === embedModel) || (endpoint === base + '/rerank' && model === rerankModel))) {
      throw new Error('Unexpected request in OpenRouter benchmark');
    }
    const digest = createHash('sha256').update(endpoint).update(body).digest('hex');
    const cached = cache.prepare('SELECT response FROM responses WHERE digest=?').get(digest) as { response: string } | undefined;
    if (cached) { usage.cacheHits++; return new Response(cached.response, { headers: { 'Content-Type': 'application/json' } }); }
    usage.requests++;
    const response = await original(url, { ...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(120_000) });
    if (endpoint.endsWith('/rerank') && response.status === 422 && /content safety screening/i.test(await response.clone().text())) {
      cache.prepare('INSERT OR IGNORE INTO screened_queries VALUES (?)').run(queryDigest(JSON.parse(body).query));
    }
    if (!response.ok) return response;
    const payload = await response.text();
    const result = JSON.parse(payload) as { error?: unknown; usage?: { total_tokens?: number; cost?: number } };
    if (!result.error) {
      cache.prepare('INSERT OR IGNORE INTO responses VALUES (?,?)').run(digest, payload);
      usage.tokensReported += result.usage?.total_tokens ?? 0;
      if (typeof result.usage?.cost === 'number') { usage.costReports++; usage.costReportedUSD += result.usage.cost; }
    }
    return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
  };
  const service = new NormalizedEmbeddingService(new OpenAICompatEmbeddingService({
    baseURL: base, providerId: 'openrouter', apiKey: key, model: embedModel, inputFormat: 'query-passage',
  }));
  const queries = new Map<string, number[]>();
  const embedding = {
    embed: service.embed.bind(service), fingerprint: service.fingerprint.bind(service),
    async embedQuery(query: string) {
      const cached = queries.get(query);
      if (cached) return { vector: cached, tokens: 0 };
      const result = await service.embedQuery(query);
      queries.set(query, result.vector);
      return result;
    },
  };
  const reranker = new OpenAICompatibleReranker({ endpoint: base + '/rerank', apiKey: key, model: rerankModel,
    name: 'provider:openrouter', strict: true });
  return { embedding, reranker, usage,
    wasScreened: (query: string) => !!cache.prepare('SELECT 1 FROM screened_queries WHERE digest=?').get(queryDigest(query)),
    close() { globalThis.fetch = original; cache.close(); } };
}
