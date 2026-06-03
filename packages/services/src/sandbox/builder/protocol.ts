/**
 * Builder-mode preview ↔ dashboard message protocol.
 *
 * The preview runs inside a cross-origin iframe (loopback dev server), so
 * all communication is `window.postMessage`. The dashboard MUST validate
 * `event.origin` against the sandbox host before trusting any inbound
 * message — these types describe the SHAPE, not the trust boundary.
 *
 * Two directions:
 *   - parent → preview: arm/disarm the element-selection inspector.
 *   - preview → parent: hover/select events + the live console/error/
 *     network feed that powers the "Problems" panel and auto-fix loop.
 *
 * Shared between the injected inspector runtime (compiled into the preview
 * app) and the dashboard hooks, so both sides stay in lockstep.
 */

/** `"<relpath>:<line>:<col>"`, relative to the project workdir. */
export type SourceLoc = string;

/** Plain rect (DOMRect isn't structured-cloneable across postMessage). */
export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Messages the dashboard (parent) posts INTO the preview iframe. */
export type ParentToPreviewMessage =
  | { type: 'mcp:arm' }
  | { type: 'mcp:disarm' };

/** Messages the preview iframe posts OUT to the dashboard (parent). */
export type PreviewToParentMessage =
  | { type: 'mcp:ready' }
  | { type: 'mcp:hover'; loc: SourceLoc; rect: RectLike }
  | {
      type: 'mcp:select';
      loc: SourceLoc;
      componentName: string | null;
      tag: string;
      classes: string[];
      text: string;
      rect: RectLike;
    }
  | { type: 'mcp:clear' }
  | { type: 'mcp:console'; level: 'error' | 'warn'; message: string; stack?: string; ts: number }
  | { type: 'mcp:runtime-error'; message: string; stack?: string; source?: SourceLoc; ts: number }
  | {
      type: 'mcp:network';
      url: string;
      method: string;
      status: number;
      statusText: string;
      ts: number;
    };

export const MCP_MESSAGE_PREFIX = 'mcp:';

const PREVIEW_TYPES = new Set<PreviewToParentMessage['type']>([
  'mcp:ready',
  'mcp:hover',
  'mcp:select',
  'mcp:clear',
  'mcp:console',
  'mcp:runtime-error',
  'mcp:network',
]);

/** Narrow an untrusted `MessageEvent.data` to a known preview message. */
export function isPreviewMessage(data: unknown): data is PreviewToParentMessage {
  if (!data || typeof data !== 'object') return false;
  const t = (data as { type?: unknown }).type;
  return typeof t === 'string' && PREVIEW_TYPES.has(t as PreviewToParentMessage['type']);
}
