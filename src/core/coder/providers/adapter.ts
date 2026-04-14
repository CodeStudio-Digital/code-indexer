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
  /** Enable thinking/reasoning mode (Gemini thinkingConfig, Anthropic extended thinking). */
  thinking?: boolean;
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

export type CoderProviderName = 'anthropic' | 'openai' | 'zai' | 'deepseek' | 'gemini';
