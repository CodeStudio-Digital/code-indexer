interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  AUTH_TOKEN: string;
}

interface EmbedRequest {
  texts: string[];
}

interface UpsertRequest {
  vectors: Array<{
    id: string;
    values: number[];
    metadata: Record<string, string>;
  }>;
}

interface SearchRequest {
  vector: number[];
  topK?: number;
  filter?: Record<string, string>;
}

interface DeleteRequest {
  ids: string[];
}

function authorize(request: Request, env: Env): Response | null {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.AUTH_TOKEN}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (no auth required)
    if (path === '/health' && request.method === 'GET') {
      return json({ ok: true, timestamp: Date.now() });
    }

    // Auth required for all other endpoints
    const authError = authorize(request, env);
    if (authError) return authError;

    try {
      if (path === '/embed' && request.method === 'POST') {
        return await handleEmbed(request, env);
      }

      if (path === '/upsert' && request.method === 'POST') {
        return await handleUpsert(request, env);
      }

      if (path === '/search' && request.method === 'POST') {
        return await handleSearch(request, env);
      }

      if (path === '/delete' && request.method === 'POST') {
        return await handleDelete(request, env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal error';
      return json({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const body = await request.json<EmbedRequest>();

  if (!body.texts || !Array.isArray(body.texts) || body.texts.length === 0) {
    return json({ error: 'texts array is required' }, 400);
  }

  const allVectors: number[][] = [];
  const batchSize = 100;

  for (let i = 0; i < body.texts.length; i += batchSize) {
    const batch = body.texts.slice(i, i + batchSize);
    const result = await env.AI.run('@cf/baai/bge-m3', { text: batch }) as { data: number[][] };
    allVectors.push(...result.data);
  }

  return json({ vectors: allVectors, count: allVectors.length });
}

async function handleUpsert(request: Request, env: Env): Promise<Response> {
  const body = await request.json<UpsertRequest>();

  if (!body.vectors || !Array.isArray(body.vectors)) {
    return json({ error: 'vectors array is required' }, 400);
  }

  const vectorizeRecords = body.vectors.map(v => ({
    id: v.id,
    values: v.values,
    metadata: v.metadata,
  }));

  // Vectorize accepts max 1000 per upsert
  let count = 0;
  const batchSize = 1000;
  for (let i = 0; i < vectorizeRecords.length; i += batchSize) {
    const batch = vectorizeRecords.slice(i, i + batchSize);
    await env.VECTORIZE.upsert(batch);
    count += batch.length;
  }

  return json({ count });
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  const body = await request.json<SearchRequest>();

  if (!body.vector || !Array.isArray(body.vector)) {
    return json({ error: 'vector is required' }, 400);
  }

  const topK = Math.min(body.topK ?? 20, 50);
  const queryOptions: VectorizeQueryOptions = {
    topK,
    returnMetadata: 'all',
  };

  if (body.filter) {
    queryOptions.filter = body.filter;
  }

  const results = await env.VECTORIZE.query(body.vector, queryOptions);

  const matches = results.matches.map(m => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata ?? {},
  }));

  return json({ matches });
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  const body = await request.json<DeleteRequest>();

  if (!body.ids || !Array.isArray(body.ids)) {
    return json({ error: 'ids array is required' }, 400);
  }

  // Vectorize deleteByIds in batches
  const batchSize = 1000;
  let count = 0;
  for (let i = 0; i < body.ids.length; i += batchSize) {
    const batch = body.ids.slice(i, i + batchSize);
    await env.VECTORIZE.deleteByIds(batch);
    count += batch.length;
  }

  return json({ count });
}
