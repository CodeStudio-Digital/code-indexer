/**
 * Stream resilience for the ChatProvider contract.
 *
 * Node 24's undici (shipped in Electron 42) surfaces
 * `ERR_STREAM_PREMATURE_CLOSE` ("Premature close") for HTTP response streams
 * that terminate without a clean end — where Node 20 stayed silent. For LLM
 * streaming this most often fires AFTER the model's response has already fully
 * arrived (the socket teardown is just flagged late by the stricter loader).
 *
 * `withStreamResilience` wraps a provider so that a premature close occurring
 * AFTER the logical `{ type: 'done' }` delta ends the stream cleanly (the
 * response is complete). A premature close BEFORE `done` is a genuine
 * truncation and is re-thrown unchanged, so the runner's existing retry path
 * handles it normally.
 */
import type { ChatProvider, ChatRequest } from './adapter.js';
import type { ChatDelta } from './wire.js';

/**
 * True for Node's `ERR_STREAM_PREMATURE_CLOSE` (message "Premature close"),
 * including when a vendor SDK nests the original under `.cause`.
 */
export function isPrematureClose(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === 'object' && depth < 5; depth++) {
    const o = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (o.code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
    if (typeof o.message === 'string' && o.message.includes('Premature close')) return true;
    e = o.cause;
  }
  return false;
}

/**
 * Decorate a ChatProvider so a benign *trailing* premature close ends the
 * stream cleanly instead of throwing. See the file header for the rationale.
 * Only `chat` is wrapped; `name` / `model` / `setModel` delegate to `inner`.
 */
export function withStreamResilience(inner: ChatProvider): ChatProvider {
  return {
    get name() {
      return inner.name;
    },
    get model() {
      return inner.model;
    },
    set model(m: string) {
      inner.model = m;
    },
    setModel(model: string) {
      inner.setModel(model);
    },
    async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
      let sawDone = false;
      try {
        for await (const delta of inner.chat(req)) {
          if (delta.type === 'done') sawDone = true;
          yield delta;
        }
      } catch (err) {
        // Response already completed (`done` seen) and the only failure is the
        // late socket teardown → end gracefully. Otherwise it's a real
        // truncation (or an unrelated error) → let the runner handle it.
        if (sawDone && isPrematureClose(err)) return;
        throw err;
      }
    },
  };
}
