/**
 * A `fetch` implementation to inject into the Stainless-generated LLM SDKs'
 * client `fetch` option — the OpenAI SDK v4 (`new OpenAI({ fetch })`) and the
 * Anthropic SDK v0.x (`new Anthropic({ fetch })`).
 *
 * Both SDKs bundle **node-fetch@2** as their Node HTTP layer instead of the
 * platform's native fetch. On Node 24 (Electron 42) that costs us twice:
 *
 *   1. node-fetch bypasses undici, so the global dispatcher installed by
 *      `installLlmDispatcher` (`new Agent({ bodyTimeout: 0 })`) never applies.
 *      The fix that disables undici's body-inactivity timeout during a long
 *      silent reasoning phase is therefore DEAD for every provider that goes
 *      through these SDKs — the coder adapters (openai/zai/openrouter/deepseek/
 *      copilot/fugu, kimi-code, chatgpt-codex, anthropic), the indexer
 *      providers, HyDE, and the one-shot helpers (commit-message + JSON/script
 *      generation).
 *   2. node-fetch@2 throws `ERR_STREAM_PREMATURE_CLOSE` on the benign late
 *      socket teardown that Node 24 hardened (silent on Node 20 / Electron 33).
 *      That surfaces as a spurious stream error / abort even when the full
 *      response already arrived.
 *
 * Handing the SDK the platform fetch routes every request through undici, so
 * the global dispatcher governs the body-streaming inactivity window and
 * node-fetch's premature-close path is gone. `withStreamResilience`
 * (`@mcp/provider-sdk`) stays as belt-and-suspenders for any transport-level
 * post-`done` close.
 *
 * Both SDKs invoke the injected fetch as `fn.call(undefined, url, init)` with a
 * plain-object `headers`, a string/Buffer `body`, a web `AbortSignal`, and a
 * non-standard `agent` key that undici ignores — all native-fetch compatible.
 * Both fall back to their bundled node-fetch when the option is `undefined`
 * (`this.fetch = overriddenFetch ?? <default>`), so returning `undefined` on a
 * runtime without a global fetch is safe.
 */

/**
 * Structural supertype of the platform fetch and both SDKs' `Core.Fetch`
 * (OpenAI v4, Anthropic v0.x). Kept deliberately broad so `@mcp/shared` needs
 * no dependency on either SDK; it is assignable to each SDK's `fetch` option
 * without a cast at the call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CrossFetch = (...args: any[]) => Promise<any>;

/** The platform (undici) fetch, or `undefined` on runtimes without one. */
export function nativeFetch(): CrossFetch | undefined {
  return typeof globalThis.fetch === 'function'
    ? (globalThis.fetch as unknown as CrossFetch)
    : undefined;
}
