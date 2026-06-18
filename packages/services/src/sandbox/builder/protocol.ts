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

/**
 * The body of an element selection (the `mcp:select` payload, minus `type`).
 * Factored out so a region/marquee pick (`mcp:region-select`) can carry MANY
 * of these at once with the exact same per-element shape.
 */
export interface SelectedElementPayload {
  loc: SourceLoc;
  componentName: string | null;
  tag: string;
  classes: string[];
  text: string;
  rect: RectLike;
  // ── Optional enrichments (universal CDP inspect; absent on the inline
  //    `data-mcp-loc` builder path so its output stays byte-identical) ──
  /** Framework detected at runtime: 'react' | 'vue' | 'angular' | 'unknown'. */
  framework?: string;
  /** Robust CSS selector path (nth-of-type) for elements without a `loc`. */
  selector?: string;
  /** Best-effort source file from framework dev metadata (no build stamp). */
  sourceFile?: string;
  /** 1-based source line, when the framework exposes it (React `__source`). */
  sourceLine?: number;
  /** `data-testid` / `id`, if present — extra anchors for the model. */
  testId?: string;
  /**
   * Ctrl/Cmd-click: accumulate into the selection set (multi-citation)
   * instead of replacing it. Absent/false → plain click → single select.
   */
  additive?: boolean;
}

/** Messages the dashboard (parent) posts INTO the preview iframe. */
export type ParentToPreviewMessage =
  | { type: 'mcp:arm' }
  /** Arm REGION mode: drag a marquee to pick every stamped element inside it. */
  | { type: 'mcp:arm-region' }
  | { type: 'mcp:disarm' }
  // ── Visual editing (two-way): optimistic DOM ops the panel applies
  //    instantly while the server rewrites the source behind them ──
  /** Replace the class list of every element stamped with `loc`. */
  | { type: 'mcp:set-classes'; loc: SourceLoc; classes: string[] }
  /** Make the first element stamped with `loc` contenteditable; commit on blur/Enter (→ `mcp:text-committed`), cancel on Escape. */
  | { type: 'mcp:begin-text-edit'; loc: SourceLoc }
  /** Live theme preview: set CSS custom properties on documentElement. */
  | { type: 'mcp:set-css-vars'; vars: Record<string, string> }
  /** Ask how many rendered elements share `loc` (→ `mcp:loc-count`). */
  | { type: 'mcp:query-loc'; loc: SourceLoc };

/** Messages the preview iframe posts OUT to the dashboard (parent). */
export type PreviewToParentMessage =
  | { type: 'mcp:ready' }
  | { type: 'mcp:hover'; loc: SourceLoc; rect: RectLike }
  | ({ type: 'mcp:select' } & SelectedElementPayload)
  /**
   * Marquee/region pick: every stamped element inside the drawn box, plus the
   * box itself in VIEWPORT coords so the host can clip a screenshot to exactly
   * that region. Region picks are additive (a batch citation).
   *
   * `rect` is in CSS pixels (DIP). Both screenshot paths take DIP/CSS-px today
   * (`webContents.capturePage(rect)` and CDP `Page.captureScreenshot({clip})`),
   * so `dpr` is carried but currently UNUSED — kept as a hint pending a high-DPI
   * (devicePixelRatio ≠ 1) verification; do not scale by it without testing.
   */
  | { type: 'mcp:region-select'; selections: SelectedElementPayload[]; rect: RectLike; dpr: number }
  | { type: 'mcp:clear' }
  /** Inline text edit committed in the preview (blur/Enter). */
  | { type: 'mcp:text-committed'; loc: SourceLoc; text: string; ts: number }
  /** Reply to `mcp:query-loc` — how many rendered nodes share the stamp. */
  | { type: 'mcp:loc-count'; loc: SourceLoc; count: number }
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
  'mcp:region-select',
  'mcp:clear',
  'mcp:text-committed',
  'mcp:loc-count',
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
