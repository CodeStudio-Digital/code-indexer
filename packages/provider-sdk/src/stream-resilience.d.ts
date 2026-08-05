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
import type { ChatProvider } from './adapter.js';
/**
 * True for Node's `ERR_STREAM_PREMATURE_CLOSE` (message "Premature close"),
 * including when a vendor SDK nests the original under `.cause`.
 */
export declare function isPrematureClose(err: unknown): boolean;
/**
 * Decorate a ChatProvider so a benign *trailing* premature close ends the
 * stream cleanly instead of throwing. See the file header for the rationale.
 * Only `chat` is wrapped; `name` / `model` / `setModel` delegate to `inner`.
 */
export declare function withStreamResilience(inner: ChatProvider): ChatProvider;
//# sourceMappingURL=stream-resilience.d.ts.map