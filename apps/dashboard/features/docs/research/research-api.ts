/**
 * API client for /api/docs-agent/research and the sessions endpoints.
 */

export type ResearchStatus = 'running' | 'completed' | 'failed' | 'aborted';
export type ResearchConfidence = 'high' | 'medium' | 'low';

export interface DocsResearchTelemetry {
  turns: number;
  searches: number;
  chunks_read: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

export interface DocsResearchResult {
  sessionId: string;
  markdown: string;
  chunks_cited: number[];
  confidence: ResearchConfidence | null;
  errorMessage?: string;
  telemetry: DocsResearchTelemetry;
}

export interface DocsResearchSessionRow {
  id: string;
  triggered_by: 'user' | 'coder';
  parent_coder_session_id: string | null;
  query: string;
  collections_json: string | null;
  status: ResearchStatus;
  num_turns: number;
  num_searches: number;
  num_chunks_read: number;
  query_rewrites_used: number;
  reranks_used: number;
  final_markdown: string | null;
  final_chunk_ids_json: string | null;
  confidence: ResearchConfidence | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  started_at: string;
  completed_at: string | null;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

export async function runResearch(input: {
  query: string;
  collections?: string[];
  maxTurns?: number;
}): Promise<DocsResearchResult> {
  const response = await fetch('/api/docs-agent/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: input.query,
      collections: input.collections,
      max_turns: input.maxTurns,
    }),
  });
  return jsonOrThrow<DocsResearchResult>(response);
}

export async function listResearchSessions(opts: {
  status?: ResearchStatus;
  parentCoderSessionId?: string;
  limit?: number;
} = {}): Promise<DocsResearchSessionRow[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.parentCoderSessionId != null)
    params.set('parent_coder_session_id', String(opts.parentCoderSessionId));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const url = `/api/docs-agent/sessions${params.toString() ? '?' + params.toString() : ''}`;
  const response = await fetch(url);
  const json = await jsonOrThrow<{ sessions: DocsResearchSessionRow[] }>(response);
  return json.sessions;
}

export async function getResearchSession(id: string): Promise<{
  session: DocsResearchSessionRow;
  cited_chunks: Array<{
    id: number;
    heading_path: string | null;
    source_uri: string | null;
    summary: string | null;
  }>;
}> {
  const response = await fetch(`/api/docs-agent/sessions/${id}`);
  return jsonOrThrow(response);
}

export async function deleteResearchSession(id: string): Promise<void> {
  const response = await fetch(`/api/docs-agent/sessions/${id}`, { method: 'DELETE' });
  await jsonOrThrow(response);
}
