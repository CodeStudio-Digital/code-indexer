/**
 * Docs research sessions are ordinary filesystem session bundles.
 *
 * The immutable/listing fields live in session.json and the mutable result
 * projection lives under state.json.extra.docs. There is deliberately no
 * SQLite fallback or dual-write path.
 */
import type { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import {
  asSessionId,
  isUuid,
  type CatalogEntry,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type { DocsResearchTrigger, ResearchConfidence } from '../types.js';

export type DocsResearchStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface DocsResearchSessionRow {
  id: SessionId;
  triggered_by: DocsResearchTrigger;
  parent_coder_session_id: SessionId | null;
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
  parent_coder_session_id?: SessionId | null;
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

interface DocsStateProjection {
  triggered_by: DocsResearchTrigger;
  query: string;
  collections: string[];
  num_turns: number;
  num_searches: number;
  num_chunks_read: number;
  query_rewrites_used: number;
  reranks_used: number;
  final_markdown: string | null;
  final_chunk_ids: number[];
  confidence: ResearchConfidence | null;
  error_message: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  completed_at: string | null;
}

function initialProjection(
  input: CreateDocsResearchSessionInput,
): DocsStateProjection {
  return {
    triggered_by: input.triggered_by,
    query: input.query,
    collections: input.collections ?? [],
    num_turns: 0,
    num_searches: 0,
    num_chunks_read: 0,
    query_rewrites_used: 0,
    reranks_used: 0,
    final_markdown: null,
    final_chunk_ids: [],
    confidence: null,
    error_message: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    completed_at: null,
  };
}

function isObject(value: JsonValue | undefined): value is {
  readonly [key: string]: JsonValue;
} {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(
  value: JsonValue | undefined,
  fallback = '',
): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function numberArray(value: JsonValue | undefined): number[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is number =>
          typeof entry === 'number' && Number.isFinite(entry),
      )
    : [];
}

function rowFromEntry(entry: CatalogEntry): DocsResearchSessionRow {
  if (!entry.state) {
    throw new Error(`Docs session ${entry.session.id} has no state.json`);
  }
  const raw = entry.state.extra.docs;
  if (!isObject(raw)) {
    throw new Error(
      `Docs session ${entry.session.id} has no valid state.extra.docs projection`,
    );
  }
  const triggeredBy =
    raw.triggered_by === 'coder' ? 'coder' : 'user';
  const confidence =
    raw.confidence === 'high' ||
    raw.confidence === 'medium' ||
    raw.confidence === 'low'
      ? raw.confidence
      : null;
  const status =
    entry.state.status === 'completed' ||
    entry.state.status === 'failed' ||
    entry.state.status === 'aborted'
      ? entry.state.status
      : 'running';
  const collections = stringArray(raw.collections);
  const finalChunkIds = numberArray(raw.final_chunk_ids);
  return {
    id: entry.session.id,
    triggered_by: triggeredBy,
    parent_coder_session_id: entry.session.parent_session_id,
    query: stringValue(raw.query),
    collections_json:
      collections.length > 0 ? JSON.stringify(collections) : null,
    status,
    num_turns: numberValue(raw.num_turns),
    num_searches: numberValue(raw.num_searches),
    num_chunks_read: numberValue(raw.num_chunks_read),
    query_rewrites_used: numberValue(raw.query_rewrites_used),
    reranks_used: numberValue(raw.reranks_used),
    final_markdown: nullableString(raw.final_markdown),
    final_chunk_ids_json:
      finalChunkIds.length > 0 ? JSON.stringify(finalChunkIds) : null,
    confidence,
    error_message: nullableString(raw.error_message),
    input_tokens: numberValue(raw.input_tokens),
    output_tokens: numberValue(raw.output_tokens),
    cost_usd: numberValue(raw.cost_usd),
    started_at: entry.session.created_at,
    completed_at: nullableString(raw.completed_at),
  };
}

function compareNewest(
  left: DocsResearchSessionRow,
  right: DocsResearchSessionRow,
): number {
  const byTime = Date.parse(right.started_at) - Date.parse(left.started_at);
  return byTime || String(right.id).localeCompare(String(left.id));
}

export class DocsResearchSessionsStore {
  constructor(private readonly sessions: FsSessionStore) {}

  /** Create a `kind=docs` bundle in the parent's scope, or globally. */
  async create(input: CreateDocsResearchSessionInput): Promise<SessionId> {
    let parent: CatalogEntry | null = null;
    if (input.parent_coder_session_id != null) {
      await this.sessions.ensureCatalog();
      parent = this.sessions.catalog.get(input.parent_coder_session_id);
      if (!parent || parent.session.kind !== 'coder') {
        throw new Error(
          `Parent coder session ${input.parent_coder_session_id} not found`,
        );
      }
    }

    const entry = await this.sessions.repository.createSession({
      kind: 'docs',
      scope: parent?.location.scope ?? { kind: 'global' },
      owner_project_id: parent?.session.owner_project_id ?? null,
      linked_projects: parent?.session.linked_projects ?? [],
      parent_session_id: parent?.session.id ?? null,
      title: input.query,
      status: 'running',
      metadata: {
        docs: {
          triggered_by: input.triggered_by,
          query: input.query,
        },
      },
      state: {
        extra: {
          docs: initialProjection(input) as unknown as JsonValue,
        },
      },
    });
    return entry.session.id;
  }

  /** Fetch a docs session by UUID. */
  async get(id: SessionId | string): Promise<DocsResearchSessionRow | null> {
    if (!isUuid(id)) return null;
    await this.sessions.ensureCatalog();
    const entry = this.sessions.catalog.get(asSessionId(String(id)));
    return entry?.session.kind === 'docs' ? rowFromEntry(entry) : null;
  }

  /** Recent docs bundles, newest first. */
  async list(
    opts: {
      parentCoderSessionId?: SessionId;
      status?: DocsResearchStatus;
      limit?: number;
    } = {},
  ): Promise<DocsResearchSessionRow[]> {
    await this.sessions.ensureCatalog();
    return this.sessions.catalog
      .list()
      .filter((entry) => entry.session.kind === 'docs')
      .map(rowFromEntry)
      .filter(
        (row) =>
          opts.parentCoderSessionId == null ||
          row.parent_coder_session_id === opts.parentCoderSessionId,
      )
      .filter((row) => opts.status == null || row.status === opts.status)
      .sort(compareNewest)
      .slice(0, Math.max(0, opts.limit ?? 50));
  }

  /** Atomically update the mutable docs projection in state.json. */
  async complete(
    id: SessionId | string,
    patch: CompleteDocsResearchSessionInput,
  ): Promise<void> {
    const row = await this.get(id);
    if (!row) throw new Error(`Docs session ${String(id)} not found`);
    const entry = this.sessions.catalog.get(asSessionId(String(id)))!;
    const completedAt = new Date().toISOString();
    await this.sessions.repository.updateState(entry.location, (state) => ({
      ...state,
      status: patch.status,
      extra: {
        ...state.extra,
        docs: {
          triggered_by: row.triggered_by,
          query: row.query,
          collections: row.collections_json
            ? (JSON.parse(row.collections_json) as string[])
            : [],
          num_turns: patch.num_turns,
          num_searches: patch.num_searches,
          num_chunks_read: patch.num_chunks_read,
          query_rewrites_used: patch.query_rewrites_used,
          reranks_used: patch.reranks_used,
          final_markdown: patch.final_markdown,
          final_chunk_ids: patch.final_chunk_ids,
          confidence: patch.confidence,
          error_message: patch.error_message ?? null,
          input_tokens: patch.input_tokens,
          output_tokens: patch.output_tokens,
          cost_usd: patch.cost_usd,
          completed_at: completedAt,
        },
      },
    }));
  }

  /** Recoverable deletion: move the complete bundle to same-volume trash. */
  async delete(id: SessionId | string): Promise<boolean> {
    const row = await this.get(id);
    if (!row) return false;
    const entry = this.sessions.catalog.get(asSessionId(String(id)));
    if (!entry) return false;
    await this.sessions.repository.trashSession(entry.location);
    return true;
  }
}
