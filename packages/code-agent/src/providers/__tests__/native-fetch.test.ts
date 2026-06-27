/**
 * Native-fetch injection for the SDK-backed coder adapters.
 *
 * The OpenAI SDK v4 and the Anthropic SDK v0.x both bundle node-fetch@2 by
 * default, which bypasses undici and therefore the global dispatcher installed
 * by `installLlmDispatcher` (`bodyTimeout: 0`). Each adapter must hand the SDK
 * the platform's native fetch so that dispatcher governs the body-streaming
 * inactivity window. These tests pin that every coder adapter forwards it into
 * its `new OpenAI(...)` / `new Anthropic(...)` call. (The helper's own behavior
 * is covered in @mcp/shared utils/__tests__/native-fetch.test.ts.)
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

// Capture every options object passed to `new OpenAI(...)` and
// `new Anthropic(...)`. The fakes expose the call surfaces the adapters touch
// so construction never throws.
const { openaiOpts, anthropicOpts } = vi.hoisted(() => ({
  openaiOpts: [] as Array<Record<string, unknown>>,
  anthropicOpts: [] as Array<Record<string, unknown>>,
}));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: vi.fn() } };
    responses = { create: vi.fn() };
    constructor(opts: Record<string, unknown>) {
      openaiOpts.push(opts);
    }
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: vi.fn(), stream: vi.fn() };
    beta = { messages: { create: vi.fn(), stream: vi.fn() } };
    constructor(opts: Record<string, unknown>) {
      anthropicOpts.push(opts);
    }
  },
}));

const { nativeFetch } = await import('@mcp/shared/utils/native-fetch.js');
const { OpenAIChatProvider } = await import('../openai.js');
const { KimiCodeChatProvider } = await import('../kimi-code.js');
const { ChatGPTCodexProvider } = await import('../chatgpt.js');
const { AnthropicChatProvider } = await import('../anthropic.js');

describe('coder adapters inject native fetch into the LLM SDKs', () => {
  beforeEach(() => {
    openaiOpts.length = 0;
    anthropicOpts.length = 0;
  });

  it('OpenAIChatProvider forwards fetch=globalThis.fetch', () => {
    new OpenAIChatProvider({ apiKey: 'k', model: 'glm-5.2', vendor: 'zai' });
    expect(openaiOpts.at(-1)?.fetch).toBe(nativeFetch());
  });

  it('KimiCodeChatProvider forwards fetch=globalThis.fetch', () => {
    new KimiCodeChatProvider({ apiKey: 'k', model: 'kimi-k2.6' });
    expect(openaiOpts.at(-1)?.fetch).toBe(nativeFetch());
  });

  it('ChatGPTCodexProvider forwards fetch=globalThis.fetch', () => {
    new ChatGPTCodexProvider({ apiKey: 'k', baseURL: 'https://chatgpt.com/x', model: 'gpt-5' });
    expect(openaiOpts.at(-1)?.fetch).toBe(nativeFetch());
  });

  it('AnthropicChatProvider defaults fetch to globalThis.fetch', () => {
    new AnthropicChatProvider({ apiKey: 'k', model: 'claude-sonnet-4-6' });
    expect(anthropicOpts.at(-1)?.fetch).toBe(nativeFetch());
  });

  it('AnthropicChatProvider lets an explicit fetch override win', () => {
    const custom = (async () => new Response()) as unknown as typeof fetch;
    new AnthropicChatProvider({ apiKey: 'k', model: 'claude-sonnet-4-6', fetch: custom });
    expect(anthropicOpts.at(-1)?.fetch).toBe(custom);
  });
});
