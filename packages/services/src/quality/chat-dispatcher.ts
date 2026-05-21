/**
 * pickChatFn — dispatches to the right chat adapter based on the
 * provider kind. Lets `LLMClassifier` stay provider-agnostic.
 *
 * Mapping:
 *   - 'anthropic' / 'claude-code'  → anthropicChat (native Messages API)
 *   - 'gemini' / 'google-oauth'    → geminiChat (native generateContent)
 *   - everything else              → openAiCompatibleChat
 *
 * Most providers in the registry expose an OpenAI-compatible endpoint
 * (Cloudflare, DeepSeek, ZAI, Moonshot, etc.), so the default is the
 * widest-compat path.
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import {
  openAiCompatibleChat,
  type ChatCallOptions,
  type ChatCallResult,
  type ChatMessage,
} from './llm-chat.js';
import { anthropicChat } from './llm-chat-anthropic.js';
import { geminiChat } from './llm-chat-gemini.js';

export type ChatFn = (
  binding: ResolvedBinding,
  messages: ChatMessage[],
  options?: ChatCallOptions,
) => Promise<ChatCallResult>;

const ANTHROPIC_KINDS = new Set(['anthropic', 'claude-code']);
const GEMINI_KINDS = new Set(['gemini', 'google-oauth']);

export function pickChatFn(binding: ResolvedBinding): ChatFn {
  const kind = binding.provider.kind;
  if (ANTHROPIC_KINDS.has(kind)) return anthropicChat;
  if (GEMINI_KINDS.has(kind))    return geminiChat;
  return openAiCompatibleChat;
}

export {
  openAiCompatibleChat,
  anthropicChat,
  geminiChat,
};
