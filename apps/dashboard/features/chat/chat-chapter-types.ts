import type { SessionId } from '../../hooks/useAgentStream.js';
import { type ContentBlock } from './chat-session-types.js';

type ConversationChapterSource = 'auto' | 'manual' | 'legacy' | 'rebuild' | 'import';

interface ConversationChapterFile {
  path: string;
  state: string;
}

export interface ConversationChapterContent {
  title?: string;
  summary?: string;
  user_requests?: string[];
  decisions?: string[];
  work_completed?: string[];
  files?: ConversationChapterFile[];
  open_issues?: string[];
  resolved_issues?: string[];
}

export interface ConversationResumeContent {
  objective?: string;
  current_focus?: string;
  constraints?: string[];
  pending_tasks?: string[];
  next_step?: string;
}

/** Append-only chapter row returned by the conversation chapter API. */
export interface ConversationChapter {
  id: string;
  seq: number;
  revision: number;
  session_id: SessionId;
  ordinal: number;
  start_message_seq: number;
  end_message_seq: number;
  source: ConversationChapterSource;
  chapter_kind?: 'context' | 'milestone' | 'rebuild';
  advances_context_boundary?: 0 | 1;
  trigger: string | null;
  title: string;
  chapter_json?: string | ConversationChapterContent | null;
  chapter_text?: string | null;
  resume_json?: string | ConversationResumeContent | null;
  resume_text?: string | null;
  version: number;
  metrics_json?: string | Record<string, unknown> | null;
  created_at: string;
  superseded_at?: string | null;
}

export interface ConversationChapterPage {
  items: ConversationChapter[];
  next_cursor: string | null;
  status?: ConversationChapterStatus;
}

interface ConversationChapterAttempt {
  id: string;
  seq: number;
  revision: number;
  status: 'started' | 'summarized' | 'deterministic_fallback' | 'noop' | 'checkpoint_failed';
  trigger: string;
  summary_provider?: string | null;
  summary_model?: string | null;
  error_message?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export interface ConversationChapterStatus {
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
  last_attempt: ConversationChapterAttempt | null;
}

/** Original transcript row returned for a chapter range. */
export interface ConversationChapterSourceMessage {
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content?: ContentBlock[] | string;
  content_json?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  is_meta?: 0 | 1;
  selected_skill_ids_json?: string | null;
  created_at?: string;
}

export interface ConversationChapterSourcePage {
  items: ConversationChapterSourceMessage[];
  next_cursor: string | null;
  /** Results outside the page window, paired by the server with visible calls. */
  tool_results?: Array<{ tool_use_id: string; content: string; is_error: boolean; _truncated?: boolean; _originalLength?: number }>;
  preceding_user_seq?: number | null;
}
