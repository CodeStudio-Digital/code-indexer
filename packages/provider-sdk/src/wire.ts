/**
 * Canonical wire-format types shared between the coder runner and every
 * provider adapter.
 *
 * These were historically defined in `@mcp/code-agent/core/messages.ts` and
 * `@mcp/code-agent/core/tool.ts`. They moved here so `@mcp/provider-sdk` can
 * own the streaming-adapter contract (`ChatProvider`/`ChatRequest`) WITHOUT
 * depending back into `@mcp/code-agent` — which would re-create the dependency
 * cycle the SDK exists to break. The old modules now re-export these names, so
 * every existing importer keeps working unchanged.
 */

// ─── Tool schema (was core/tool.ts) ──────────────────────────────
/**
 * Tool definition shared by native tools (fs/shell/git) and bridged MCP tools.
 * `parameters` is a JSON Schema object describing the tool input. Each provider
 * adapter knows how to translate this into its vendor-specific tool spec.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

// ─── Normalized message blocks (was core/messages.ts) ────────────
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
   * When true, the dashboard hides the message from the user-visible
   * transcript while the model still sees it in context. Used for
   * runtime-injected reminders. Provider serializers ignore this field — it
   * only affects rendering and persistence.
   */
  isMeta?: boolean;
  /**
   * Skill IDs the user pre-selected in the chat sidebar when sending this
   * message (migration 095). Pure metadata: never forwarded to the provider
   * inside `content`, never serialized by any adapter.
   */
  selectedSkillIds?: string[];
}

// ─── Usage + streaming deltas (was core/messages.ts) ─────────────
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
 *
 * NOTE: consumers MUST keep a `default` branch when switching on `type` —
 * new delta variants are additive within a major SDK version.
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
   * the OpenAI Responses API used by ChatGPT/Codex with `store: true`).
   */
  | { type: 'response_id'; id: string; messageCount: number }
  /**
   * Image emitted by a server-managed `image_generation` tool call. Currently
   * only Codex/ChatGPT models with `image_generation` capability emit these.
   */
  | {
      type: 'image_generated';
      id: string;
      mediaType: string;
      base64: string;
      revisedPrompt?: string;
    }
  | { type: 'done'; stop_reason?: string };
