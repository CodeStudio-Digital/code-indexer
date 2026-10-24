import type {
  JsonValue,
  SessionId,
} from '@mcp/session-storage';
import type { FsCoderMessageRow } from './types.js';

export type FsConversationChapterSource =
  | 'auto'
  | 'manual'
  | 'legacy'
  | 'rebuild'
  | 'import';

export type FsConversationChapterKind =
  | 'context'
  | 'milestone'
  | 'rebuild';

export interface FsConversationChapterRow {
  /** Opaque record identity. It is never used for ordering. */
  id: string;
  /** Stable per-session order used by pagination and display. */
  seq: number;
  revision: number;
  session_id: SessionId;
  ordinal: number;
  start_message_seq: number;
  end_message_seq: number;
  source: FsConversationChapterSource;
  trigger: string;
  title: string;
  chapter_json: string;
  chapter_text: string;
  resume_json: string;
  resume_text: string;
  version: number;
  metrics_json: string | null;
  created_at: string;
  superseded_at: string | null;
  chapter_kind: FsConversationChapterKind;
  advances_context_boundary: 0 | 1;
}

export interface FsConversationChapterSearchResult
  extends FsConversationChapterRow {
  /** In-memory relevance score. Higher is more relevant. */
  rank: number;
}

export interface FsConversationChapterPage<T> {
  items: T[];
  next_cursor: string | null;
  /** Total matching rows, computed from the same artifact read as this page. */
  total_count?: number;
  /** Max persisted row timestamp from the same artifact read. */
  revision?: number;
  status?: FsConversationChapterStatus;
}

export interface FsCommitConversationChapterInput {
  sessionId: SessionId;
  /** Boundary read before summarization; compare-and-set concurrency guard. */
  expectedBoundarySeq: number;
  startMessageSeq: number;
  endMessageSeq: number;
  source: Extract<
    FsConversationChapterSource,
    'auto' | 'manual' | 'import'
  >;
  chapterKind?: Exclude<FsConversationChapterKind, 'rebuild'>;
  trigger: string;
  title: string;
  chapterJson: string;
  chapterText: string;
  resumeJson: string;
  resumeText: string;
  version: number;
  metricsJson?: string | null;
  operation_id?: string;
}

export interface FsRebuiltConversationChapterInput {
  startMessageSeq: number;
  endMessageSeq: number;
  trigger: string;
  title: string;
  chapterJson: string;
  chapterText: string;
  resumeJson: string;
  resumeText: string;
  version: number;
  metricsJson?: string | null;
  chapterKind?: FsConversationChapterKind;
  advancesContextBoundary?: boolean;
}

export interface FsInsertRebuiltConversationChaptersResult {
  items: FsConversationChapterRow[];
  superseded_count: number;
}

export type FsCommitConversationChapterResult =
  | {
      status: 'committed';
      chapter: FsConversationChapterRow;
      boundary_seq: number;
      pruned_count: number;
    }
  | {
      status: 'noop';
      reason: 'boundary_changed' | 'already_committed' | 'no_messages';
      chapter?: FsConversationChapterRow;
      boundary_seq: number;
      pruned_count: 0;
    };

export type FsCompactionAttemptStatus =
  | 'started'
  | 'summarized'
  | 'deterministic_fallback'
  | 'noop'
  | 'checkpoint_failed';

export interface FsCompactionAttemptRow {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  run_id: string;
  turn: number;
  turn_telemetry_id: string | null;
  trigger: string;
  provider_chain: ReadonlyArray<{
    provider: string;
    model: string;
  }>;
  summary_provider: string | null;
  summary_model: string | null;
  status: FsCompactionAttemptStatus;
  strategy: 'none' | 'summarizer' | 'deterministic';
  summarizer_ran: boolean;
  prompt_tokens_before: number | null;
  history_chars_before: number | null;
  history_chars_after: number | null;
  pruned_messages: number;
  chapter_id: string | null;
  boundary_seq: number | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface FsStartCompactionAttemptInput {
  session_id: SessionId;
  run_id: string;
  turn: number;
  turn_telemetry_id?: string | null;
  trigger?: string;
  provider_chain?: Array<{ provider: string; model: string }>;
  prompt_tokens_before?: number | null;
  history_chars_before?: number | null;
  operation_id?: string;
}

export interface FsFinishCompactionAttemptInput {
  status: Exclude<FsCompactionAttemptStatus, 'started'>;
  strategy: 'none' | 'summarizer' | 'deterministic';
  summarizer_ran: boolean;
  summary_provider?: string | null;
  summary_model?: string | null;
  history_chars_after?: number | null;
  pruned_messages?: number;
  chapter_id?: string | null;
  boundary_seq?: number | null;
  error_message?: string | null;
  operation_id?: string;
}

export interface FsConversationChapterStatus {
  state: 'healthy' | 'degraded' | 'empty';
  boundary_seq: number | null;
  unsummarized_messages: number;
  chapter_count: number;
  context_chapters: number;
  milestone_chapters: number;
  rebuilt_chapters: number;
  counters: {
    attempts: number;
    summarized: number;
    deterministic_fallbacks: number;
    checkpoint_failures: number;
    checkpoint_retries: number;
    checkpoint_blocked: number;
    noops: number;
    failures: number;
  };
  last_attempt: FsCompactionAttemptRow | null;
}

export interface FsRecordProviderAttemptInput {
  session_id: SessionId | null;
  run_id: string;
  turn: number;
  attempt: number;
  provider: string | null;
  model: string | null;
  status: number | null;
  ok: boolean;
  generation_id?: string | null;
  request_id?: string | null;
  upstream_provider?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
  retry_after?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  duration_ms: number;
  operation_id?: string;
}

export interface FsProviderAttemptRow {
  id: string;
  seq: number;
  session_id: SessionId;
  run_id: string;
  turn: number;
  attempt: number;
  provider: string | null;
  model: string | null;
  status: number | null;
  ok: boolean;
  generation_id: string | null;
  request_id: string | null;
  upstream_provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_usd: number | null;
  retry_after: string | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  created_at: string;
  metadata: Readonly<Record<string, JsonValue>>;
}

export type FsConversationChapterSourcePage =
  FsConversationChapterPage<FsCoderMessageRow>;
