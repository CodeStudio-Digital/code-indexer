/**
 * Native-fetch injection for the OpenAI-SDK-backed coder adapters.
 *
 * The OpenAI SDK v4 bundles node-fetch@2 by default, which bypasses undici and
 * therefore the global dispatcher installed by `installLlmDispatcher`
 * (`bodyTimeout: 0`). Each adapter must hand the SDK the platform's native
 * fetch so that dispatcher governs the body-streaming inactivity window. These
 * tests pin both the helper's behavior and the fact that every coder adapter
 * forwards it into `new OpenAI({ fetch })`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Capture every options object passed to `new OpenAI(...)`. The fake also
// exposes the two call surfaces the adapters touch (chat.completions + responses)
// so construction never throws.
const { ctorOpts } = vi.hoisted(() => ({ ctorOpts: [] as Array<Record<string, unknown>> }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: vi.fn() } };
    responses = { create: vi.fn() };
    constructor(opts: Record<string, unknown>) {
      ctorOpts.push(opts);
    }
  },
}));

const { nativeFetch } = await import('../native-fetch.js');
const { OpenAIChatProvider } = await import('../openai.js');
const { KimiCodeChatProvider } = await import('../kimi-code.js');
const { ChatGPTCodexProvider } = await import('../chatgpt.js');

describe('nativeFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the platform fetch when one exists', () => {
    expect(nativeFetch()).toBe(globalThis.fetch);
  });

  it('returns undefined when no global fetch exists (SDK falls back to node-fetch)', () => {
    vi.stubGlobal('fetch', undefined);
    expect(nativeFetch()).toBeUndefined();
  });
});

describe('coder adapters inject native fetch into the OpenAI SDK', () => {
  beforeEach(() => {
    ctorOpts.length = 0;
  });

  it('OpenAIChatProvider forwards fetch=globalThis.fetch', () => {
    new OpenAIChatProvider({ apiKey: 'k', model: 'glm-5.2', vendor: 'zai' });
    expect(ctorOpts.at(-1)?.fetch).toBe(globalThis.fetch);
  });

  it('KimiCodeChatProvider forwards fetch=globalThis.fetch', () => {
    new KimiCodeChatProvider({ apiKey: 'k', model: 'kimi-k2.6' });
    expect(ctorOpts.at(-1)?.fetch).toBe(globalThis.fetch);
  });

  it('ChatGPTCodexProvider forwards fetch=globalThis.fetch', () => {
    new ChatGPTCodexProvider({ apiKey: 'k', baseURL: 'https://chatgpt.com/x', model: 'gpt-5' });
    expect(ctorOpts.at(-1)?.fetch).toBe(globalThis.fetch);
  });
});
