/**
 * DocsResearchSessionsStore — CRUD over `docs_research_sessions`
 * (migration 097).
 *
 * Lives in the docs-agent package rather than @mcp/store because the
 * schema is docs-specific and the only consumer is `runDocsAgent`.
 * If a second consumer appears, this is a candidate to promote.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { DocsResearchTrigger, ResearchConfidence } from '../types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export type DocsResearchStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface DocsResearchSessionRow {
  id: number;
  triggered_by: DocsResearchTrigger;
  parent_coder_session_id: number | null;
  query: string;
  collections_json: string | null;
  status: DocsResearchStatus;
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

export interface CreateDocsResearchSessionInput {
  triggered_by: DocsResearchTrigger;
  parent_coder_session_id?: number | null;
  query: string;
  collections?: string[];
}

export interface CompleteDocsResearchSessionInput {
  status: DocsResearchStatus;
  num_turns: number;
  num_searches: number;
  num_chunks_read: number;
  query_rewrites_used: number;
  reranks_used: number;
  final_markdown: string | null;
  final_chunk_ids: number[];
  confidence: ResearchConfidence | null;
  error_message?: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export class DocsResearchSessionsStore {
  constructor(private db: DB) {}

  /** Insert a new session row in status='running'. Returns the new id. */
  create(input: CreateDocsResearchSessionInput): number {
    const result = this.db
      .prepare(
        `INSERT INTO docs_research_sessions (
           triggered_by, parent_coder_session_id, query, collections_json
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.triggered_by,
        input.parent_coder_session_id ?? null,
        input.query,
        input.collections && input.collections.length > 0
          ? JSON.stringify(input.collections)
          : null,
      );
    return Number(result.lastInsertRowid);
  }

  /** Fetch a session by id. Returns null when missing. */
  get(id: number): DocsResearchSessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM docs_research_sessions WHERE id = ?')
      .get(id) as DocsResearchSessionRow | undefined;
    return row ?? null;
  }

  /** Most recent sessions, capped by `limit`. Newest first. */
  list(opts: { parentCoderSessionId?: number; status?: DocsResearchStatus; limit?: number } = {}): DocsResearchSessionRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit ?? 50 };
    if (opts.parentCoderSessionId != null) {
      where.push('parent_coder_session_id = @parentCoderSessionId');
      params.parentCoderSessionId = opts.parentCoderSessionId;
    }
    if (opts.status) {
      where.push('status = @status');
      params.status = opts.status;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM docs_research_sessions ${whereSql}
         ORDER BY started_at DESC, id DESC
         LIMIT @limit`,
      )
      .all(params) as DocsResearchSessionRow[];
    return rows;
  }

  /** Finalize a session — sets status + final fields + completed_at. */
  complete(id: number, patch: CompleteDocsResearchSessionInput): void {
    this.db
      .prepare(
        `UPDATE docs_research_sessions SET
            status               = @status,
            num_turns            = @num_turns,
            num_searches         = @num_searches,
            num_chunks_read      = @num_chunks_read,
            query_rewrites_used  = @query_rewrites_used,
            reranks_used         = @reranks_used,
            final_markdown       = @final_markdown,
            final_chunk_ids_json = @final_chunk_ids_json,
            confidence           = @confidence,
            error_message        = @error_message,
            input_tokens         = @input_tokens,
            output_tokens        = @output_tokens,
            cost_usd             = @cost_usd,
            completed_at         = datetime('now')
          WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status,
        num_turns: patch.num_turns,
        num_searches: patch.num_searches,
        num_chunks_read: patch.num_chunks_read,
        query_rewrites_used: patch.query_rewrites_used,
        reranks_used: patch.reranks_used,
        final_markdown: patch.final_markdown,
        final_chunk_ids_json:
          patch.final_chunk_ids.length > 0 ? JSON.stringify(patch.final_chunk_ids) : null,
        confidence: patch.confidence,
        error_message: patch.error_message ?? null,
        input_tokens: patch.input_tokens,
        output_tokens: patch.output_tokens,
        cost_usd: patch.cost_usd,
      });
  }

  /** Drop a research session row. Used by `DELETE /api/docs-agent/sessions/:id`. */
  delete(id: number): boolean {
    const result = this.db.prepare('DELETE FROM docs_research_sessions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}
