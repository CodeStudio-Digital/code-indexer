import type { AgentMessage, ChatDelta } from '../core/messages.js';
import type { JsonSchema } from '../core/tool.js';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Enable thinking/reasoning mode (Gemini thinkingConfig, Anthropic extended thinking, Codex reasoning.effort). */
  thinking?: boolean;
  /**
   * For stateful providers (ChatGPT/Codex with `store: true`): identifier of
   * the prior response. When present, the provider sends only the message
   * delta and lets the backend reconstruct the prefix from the stored response.
   */
  previousResponseId?: string;
  /**
   * Companion to `previousResponseId`: how many messages were already on the
   * server side. The provider ships `messages.slice(previousResponseMessageCount)`.
   */
  previousResponseMessageCount?: number;
  /**
   * Sampling parameters resolved by the runner via `resolveTemperature()`.
   * Each provider reads `inference.temperature` and translates it to its
   * vendor schema (or omits it when the model rejects sampling — e.g. OpenAI
   * o-series, Anthropic with extended thinking). Range [0, 1] enforced by the
   * resolver; providers do not re-clamp.
   */
  inference?: {
    temperature?: number;
  };
}

/**
 * A provider-agnostic streaming chat interface with tool-calling.
 *
 * Each adapter (Anthropic, OpenAI/ZAI/DeepSeek, Gemini) translates the
 * normalized AgentMessage / ToolSpec format to its vendor schema and back.
 */
export interface ChatProvider {
  readonly name: string;
  /** Active model. May be reassigned mid-session via setModel(). */
  model: string;
  setModel(model: string): void;
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;
}

export type CoderProviderName = 'anthropic' | 'claude-code' | 'openai' | 'zai' | 'deepseek' | 'gemini';
