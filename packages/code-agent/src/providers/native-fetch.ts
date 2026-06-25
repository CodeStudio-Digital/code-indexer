import type { ClientOptions } from 'openai';

/**
 * Native (undici) fetch to inject into `new OpenAI({ fetch })`.
 *
 * The OpenAI SDK v4 (4.104.0) bundles **node-fetch@2** as its Node HTTP layer
 * instead of the platform's native fetch. On Node 24 (Electron 42) that costs
 * us twice:
 *
 *   1. node-fetch bypasses undici, so the global dispatcher installed by
 *      `installLlmDispatcher` (`new Agent({ bodyTimeout: 0 })`) never applies
 *      to LLM requests. The fix that disables undici's body-inactivity timeout
 *      during a long silent reasoning phase is therefore *dead* for every
 *      OpenAI-compatible provider (zai, openai, openrouter, deepseek, copilot,
 *      fugu, kimi-code, chatgpt-codex).
 *   2. node-fetch@2 throws `ERR_STREAM_PREMATURE_CLOSE` on the benign late
 *      socket teardown that Node 24 hardened (silent on Node 20 / Electron 33).
 *
 * Passing the platform fetch routes every request through undici, so the global
 * dispatcher governs the body-streaming inactivity window and node-fetch's
 * premature-close path is gone entirely. `withStreamResilience`
 * (`@mcp/provider-sdk`, applied centrally in the services factory) remains as
 * belt-and-suspenders for any transport-level post-`done` close.
 *
 * The SDK invokes the injected fetch as `fn.call(undefined, url, init)` with a
 * plain-object `headers`, a string/Buffer `body`, a web `AbortSignal`, and a
 * non-standard `agent` key that undici ignores — all native-fetch compatible.
 *
 * Returns `undefined` when no global fetch exists (ancient runtimes) so the SDK
 * silently falls back to its bundled node-fetch. The cast bridges the SDK's
 * node-fetch-shimmed `Fetch` type with the platform's lib.dom `fetch` type;
 * they are structurally compatible at runtime.
 */
export function nativeFetch(): ClientOptions['fetch'] {
  return typeof globalThis.fetch === 'function'
    ? (globalThis.fetch as unknown as ClientOptions['fetch'])
    : undefined;
}
