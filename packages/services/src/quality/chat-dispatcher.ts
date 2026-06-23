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

// Providers that reject unknown body params (OpenAI-proper) or where the
// thinking-suppression knob is unsupported/risky. The gemini + most
// OpenAI-compatible hosts (ZAI/GLM, DeepSeek, Cloudflare, Kimi, Moonshot)
// either honor `disableThinking` or silently ignore the params (verified —
// see llm-chat.ts), so suppression is safe there; OpenAI/ChatGPT/Codex,
// Bedrock, Copilot and OpenRouter (proxies to strict OpenAI models) 400 on
// unknown params, so they must NOT receive the suppression body.
const STRICT_THINKING_PROVIDER_IDS = new Set(['openai', 'openai-chatgpt', 'aws', 'openrouter']);
const STRICT_THINKING_KINDS = new Set(['chatgpt', 'copilot', 'bedrock', 'openai']);

/**
 * Whether it's safe + useful to pass `disableThinking: true` to this binding.
 * Suppressing reasoning on one-shot structured tasks (memory distillation)
 * stops thinking models (Gemini 2.5, GLM) from burning the token budget and
 * returning empty/truncated JSON. Returns false for strict OpenAI-family
 * providers that reject unknown body params.
 *
 * NOTE: `kind:'openai'` is shared by real OpenAI AND OpenAI-compatible hosts
 * (ZAI/DeepSeek/AWS); the compatible ones are re-allowed by provider id below.
 */
export function suppressThinkingFor(binding: ResolvedBinding): boolean {
  const p = binding.provider;
  const COMPAT_OK_IDS = new Set(['zai', 'deepseek']); // kind 'openai' but ignore unknown params
  if (COMPAT_OK_IDS.has(p.id)) return true;
  if (STRICT_THINKING_PROVIDER_IDS.has(p.id)) return false;
  if (STRICT_THINKING_KINDS.has(p.kind)) return false;
  return true;
}

export {
  openAiCompatibleChat,
  anthropicChat,
  geminiChat,
};
