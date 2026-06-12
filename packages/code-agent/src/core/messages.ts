/**
 * Normalized message types for the coder agent.
 *
 * The runner uses these as a single canonical format. Each provider adapter
 * is responsible for translating to/from its vendor-specific schema.
 */

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /**
   * True when content was truncated at push-time. `originalSize` is the byte
   * length before truncation. The marker is deterministic so the elided block
   * never mutates across turns — preserving the prefix-cache (ZAI/GLM auto
   * cache and Anthropic ephemeral cache).
   */
  truncated?: boolean;
  originalSize?: number;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string; // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  base64: string;
  /**
   * Agent-directed hint for the vision-fallback describer: what to look for /
   * how to describe this image when the active model can't see it (e.g. a
   * `view_image.describe` / `preview_screenshot.lookFor` instruction). Ignored
   * by every provider adapter — consumed ONLY by the vision-fallback transform.
   */
  describeHint?: string;
}

/**
 * A document attachment. For plain-text-like files (md/txt/json/csv/yaml/code)
 * we store the decoded UTF-8 string in `text` — cheap and works across providers.
 * For PDFs we keep the base64 and let the adapter route it (Anthropic native;
 * OpenAI does server-side text extraction fallback).
 */
export interface DocumentBlock {
  type: 'document';
  name: string;
  mediaType: string;
  text?: string;
  base64?: string;
}

export interface QuestionBlock {
  type: 'question';
  id: string;
  question: string;
  options?: Array<{ label: string; value: string }>;
  allowFreeform?: boolean;
  answer?: string;
  /** Optional ≤16-char UI label rendered above the question. */
  header?: string;
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  plan: string;
  approved?: boolean;
  feedback?: string;
  /**
   * Optional hint from the model: "informational" plans are answer-only
   * deliverables (no edits/shell follow-up). The dashboard can surface a
   * quick-approve cue for these without bypassing user review.
   */
  kind?: 'informational' | 'mutating';
}

/**
 * Spec-mode artifact — emitted by `submit_spec` while waiting for human
 * approval. Carries the full markdown body so dashboards can render a
 * preview without a follow-up read, plus the repo-relative `spec_path`
 * the runner persisted it at (`.mcp/specs/<slug>-<unix>.md`).
 */
export interface SpecBlock {
  type: 'spec';
  id: string;
  name: string;
  body: string;
  spec_path: string;
  parent_id?: string;
  /** Logical drive path when the spec was mirrored into the company drive. */
  drive_path?: string;
  approved?: boolean;
  requested_changes?: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | QuestionBlock
  | PlanBlock
  | SpecBlock
  | ThinkingBlock;

export interface AgentMessage {
  role: AgentRole;
  content: ContentBlock[];
  /**
   * PR-4 (Row 8 from docs/agent-research/COMPARISON.md). When true, the
   * dashboard hides the message from the user-visible transcript while the
   * model still sees it in context. Used for runtime-injected reminders:
   * stop-guard nudge, auto-continue recap, subordinate deliverable
   * reminder, plan-mode "continue investigation" notes.
   *
   * Provider serializers ignore this field — it only affects rendering and
   * persistence. Mirrors claude-code's `isMeta:true` carryover marker on
   * its `task_budget` continuation messages (`query.ts`).
   */
  isMeta?: boolean;
  /**
   * Skill IDs the user pre-selected in the chat sidebar when sending this
   * message (migration 095). Pure metadata: never forwarded to the provider
   * inside `content`, never serialized by any adapter. The runner reads
   * this on `assembleMessagesForChat` and injects an `<active_skills>` block
   * into the trailing user message at request time (same per-turn mechanism
   * as `<active-context>`). The UI uses it to render audit pills above the
   * user bubble.
   */
  selectedSkillIds?: string[];
}

/**
 * Build a user-message content array from a text + optional attachments.
 * Images go through as ImageBlock; everything else as DocumentBlock — same
 * routing the providers expect.
 *
 * Used everywhere a human message can carry attachments: the initial
 * runCoder fresh-start, MasterLifecycle.sendUserMessage, and the master
 * tools that forward content to subordinates.
 */
export function attachmentsToBlocks(
  text: string,
  attachments?: ReadonlyArray<{
    name?: string;
    mediaType: string;
    base64?: string;
    text?: string;
  }>,
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const att of attachments ?? []) {
    if (att.mediaType.startsWith('image/') && att.base64) {
      blocks.push({ type: 'image', mediaType: att.mediaType, base64: att.base64 });
    } else {
      blocks.push({
        type: 'document',
        name: att.name ?? 'attachment',
        mediaType: att.mediaType,
        text: att.text,
        base64: att.base64,
      });
    }
  }
  return blocks;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * TRUE total prompt size of this call, normalized by the adapter.
   * Anthropic-style APIs split the prompt into uncached `input_tokens` +
   * cache_read/cache_creation (total = sum); OpenAI-style APIs report the
   * full prompt in `input_tokens` with cache as a breakdown (total = input).
   * Consumers should read it via `promptTokensTotal(usage)`.
   */
  prompt_tokens_total?: number;
  /** Tokens written into prompt cache this call (Anthropic ephemeral cache writes). */
  cache_creation_input_tokens?: number;
  /** Tokens served from prompt cache this call (Anthropic + OpenAI/ZAI/DeepSeek). */
  cache_read_input_tokens?: number;
  /** Tokens spent on thinking/reasoning (Gemini thinkingConfig, Anthropic extended thinking). */
  thinking_tokens?: number;
}

/**
 * True prompt size of a call. Prefers the adapter-normalized
 * `prompt_tokens_total`; falls back to raw `input_tokens`, which never
 * OVERcounts (it may undercount for additive-style providers that predate
 * the field — same behaviour as before the field existed). Returns null
 * when usage is absent or zeroed so callers can fall back to an estimate.
 */
export function promptTokensTotal(usage: ChatUsage | null | undefined): number | null {
  if (!usage) return null;
  if (usage.prompt_tokens_total != null && usage.prompt_tokens_total > 0) {
    return usage.prompt_tokens_total;
  }
  return usage.input_tokens > 0 ? usage.input_tokens : null;
}

export interface ChatProviderResponseMeta {
  /**
   * Provider endpoint path, sanitized to exclude host, query secrets, and body.
   * Example: `/v1/messages`.
   */
  path?: string | null;
  request?: {
    api_model?: string | null;
    requested_model?: string | null;
    display_model?: string | null;
    max_tokens?: number | null;
    stream?: boolean | null;
    betas?: string[] | null;
    thinking_type?: string | null;
    effort?: string | null;
  };
  response?: {
    status?: number | null;
    ok?: boolean | null;
    request_id?: string | null;
    retry_after?: string | null;
    x_should_retry?: string | null;
    rate_limits?: Record<string, string | null> | null;
  };
}

/**
 * Streaming events emitted by ChatProvider.chat() and re-emitted by the runner.
 */
export type ChatDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_args'; id: string; partial_json: string }
  | { type: 'tool_call_end'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'response_meta'; meta: ChatProviderResponseMeta }
  /**
   * Server-side response identifier returned by stateful APIs (currently only
   * the OpenAI Responses API used by ChatGPT/Codex with `store: true`). The
   * runner persists this in `coder_sessions.last_response_id` so the next
   * turn can pass `previous_response_id` and skip restating the prior input.
   * `messageCount` is the size of the AgentMessage[] sent in this turn —
   * the next turn ships only `messages.slice(messageCount)`.
   */
  | { type: 'response_id'; id: string; messageCount: number }
  /**
   * Image emitted by a server-managed `image_generation` tool call. Currently
   * only Codex/ChatGPT models with `image_generation` capability emit these.
   * The runner converts them to `ImageBlock` entries on the assistant
   * content so the UI renders them inline.
   */
  | {
      type: 'image_generated';
      id: string;
      mediaType: string;
      base64: string;
      revisedPrompt?: string;
    }
  | { type: 'done'; stop_reason?: string };
