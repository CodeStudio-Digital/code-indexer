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
}

export interface PlanBlock {
  type: 'plan';
  id: string;
  plan: string;
  approved?: boolean;
  feedback?: string;
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
  | ThinkingBlock;

export interface AgentMessage {
  role: AgentRole;
  content: ContentBlock[];
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens written into prompt cache this call (Anthropic ephemeral cache writes). */
  cache_creation_input_tokens?: number;
  /** Tokens served from prompt cache this call (Anthropic + OpenAI/ZAI/DeepSeek). */
  cache_read_input_tokens?: number;
  /** Tokens spent on thinking/reasoning (Gemini thinkingConfig, Anthropic extended thinking). */
  thinking_tokens?: number;
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
  | { type: 'done'; stop_reason?: string };
