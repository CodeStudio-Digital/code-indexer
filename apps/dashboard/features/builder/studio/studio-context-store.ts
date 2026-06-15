/**
 * Tiny module-level bridge between a builder project's preview pane (which
 * produces element selections + error problems) and the chat pane (which
 * consumes them into outgoing messages). Keeps the two panes decoupled —
 * the preview writes here, the composer reads here.
 */
import { useEffect } from 'react';
import type { PreviewToParentMessage } from '@mcp/services/sandbox/builder/protocol.js';

export type SelectedElement = Extract<PreviewToParentMessage, { type: 'mcp:select' }>;
export type ProblemMessage = Extract<
  PreviewToParentMessage,
  { type: 'mcp:runtime-error' | 'mcp:network' | 'mcp:console' }
>;

// ── Selection state (per session) ───────────────────────────────────
// A LIST of selected elements: Ctrl/Cmd-click accumulates, a plain click
// replaces. The visual-edit panel — single-element by nature — reads the
// PRIMARY (the most-recently picked, i.e. the last); the chips + message
// citation read the whole list.
const selectedBySession = new Map<number, SelectedElement[]>();
const listeners = new Map<number, Set<() => void>>();

function notify(sid: number) {
  listeners.get(sid)?.forEach((cb) => cb());
}

/** Stable identity for dedup/removal — source loc, else CSS selector, else tag+text. */
export function selectionKey(s: SelectedElement): string {
  return s.loc || s.selector || `${s.tag}|${s.text}`;
}

/** Every selected element, in pick order (chips + citation). */
export function getSelections(sid: number): SelectedElement[] {
  return selectedBySession.get(sid) ?? [];
}

/** The primary (most-recently picked) element — visual editing targets this. */
export function getSelected(sid: number): SelectedElement | null {
  const list = getSelections(sid);
  return list.length ? list[list.length - 1] : null;
}

/** Plain click / programmatic set: replace the whole set with one element (or clear with null). */
export function setSelected(sid: number, sel: SelectedElement | null): void {
  selectedBySession.set(sid, sel ? [sel] : []);
  notify(sid);
}

/** Ctrl/Cmd-click: toggle an element's membership in the set (dedup by key). */
export function toggleSelected(sid: number, sel: SelectedElement): void {
  const list = getSelections(sid);
  const k = selectionKey(sel);
  const idx = list.findIndex((s) => selectionKey(s) === k);
  selectedBySession.set(sid, idx >= 0 ? list.filter((_, i) => i !== idx) : [...list, sel]);
  notify(sid);
}

/** Remove one element from the set (chip ✕). */
export function removeSelected(sid: number, key: string): void {
  selectedBySession.set(sid, getSelections(sid).filter((s) => selectionKey(s) !== key));
  notify(sid);
}

/**
 * Patch the element identified by `key` (visual-edit loc chase) WITHOUT
 * collapsing the rest of the set — the server moves a `loc` after a rewrite,
 * and every other citation must stay intact.
 */
export function updateSelected(sid: number, key: string, patch: Partial<SelectedElement>): void {
  const next = getSelections(sid).map((s) =>
    selectionKey(s) === key ? ({ ...s, ...patch } as SelectedElement) : s,
  );
  selectedBySession.set(sid, next);
  notify(sid);
}

export function subscribeSelected(sid: number, cb: () => void): () => void {
  let set = listeners.get(sid);
  if (!set) listeners.set(sid, (set = new Set()));
  set.add(cb);
  return () => set!.delete(cb);
}

/** Format ALL active selections as a message prefix and CLEAR them. Empty when none. */
export function consumeSelectionPrefix(sid: number): string {
  const sels = getSelections(sid);
  if (!sels.length) return '';
  setSelected(sid, null);
  return sels.map(formatSelectedElement).join('');
}

export function formatSelectedElement(sel: SelectedElement): string {
  const classes = sel.classes.join(' ');
  // The universal (CDP) path supplies a source from framework dev metadata;
  // the inline builder path supplies `loc` from the data-mcp-loc stamp.
  const source =
    sel.sourceFile != null
      ? `${sel.sourceFile}${sel.sourceLine != null ? `:${sel.sourceLine}` : ''}`
      : '';
  // Order chosen so that when the optional (universal-only) attrs are absent,
  // the emitted string is byte-identical to the original builder output:
  //   loc → component → tag → classes
  const attrs = [
    sel.loc ? `loc="${sel.loc}"` : '',
    source ? `source="${source}"` : '',
    sel.framework ? `framework="${sel.framework}"` : '',
    sel.componentName ? `component="${sel.componentName}"` : '',
    `tag="${sel.tag}"`,
    sel.selector ? `selector="${sel.selector}"` : '',
    sel.testId ? `testid="${sel.testId}"` : '',
    classes ? `classes="${classes}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<selected-element ${attrs}>\n${sel.text}\n</selected-element>\n`;
}

/** Format a captured problem as a message block for the builder agent. */
export function formatProblem(p: ProblemMessage): string {
  if (p.type === 'mcp:network') {
    return `<network-error url="${p.url}" method="${p.method}" status="${p.status}">${p.statusText}</network-error>`;
  }
  if (p.type === 'mcp:runtime-error') {
    const src = p.source ? ` source="${p.source}"` : '';
    return `<runtime-error message="${escapeAttr(p.message)}"${src}>${p.stack ?? ''}</runtime-error>`;
  }
  return `<console level="${p.level}">${escapeAttr(p.message)}</console>`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "'").slice(0, 500);
}

// ── Agent-busy signal (chat pane → preview pane) ────────────────────
// The chat pane knows the master's live status; the auto-fix loop reads it
// here so it never fires while the agent is mid-turn or awaiting input.
const busyBySession = new Map<number, boolean>();
export function setAgentBusy(sid: number, busy: boolean): void {
  busyBySession.set(sid, busy);
}
export function isAgentBusy(sid: number): boolean {
  return busyBySession.get(sid) ?? false;
}

/**
 * Publish a chat pane's live busy state under the studio key (single-session
 * chat passes `streaming` from useAgentStream; the company pane has its own
 * masterStatus-based publisher). Cleanup resets to idle so a stale `true`
 * never outlives the pane that produced it.
 */
export function usePublishAgentBusy(sid: number | null | undefined, busy: boolean): void {
  useEffect(() => {
    if (sid == null) return;
    setAgentBusy(sid, busy);
    return () => setAgentBusy(sid, false);
  }, [sid, busy]);
}

// ── Send bridge (preview pane → chat pane) ──────────────────────────
// The chat pane (CompanySessionView) owns the company stream. The preview
// pane asks it to send a message (e.g. "Fix this error") via a scoped
// window event so neither pane needs a ref to the other.
export function requestStudioSend(sid: number, text: string): void {
  window.dispatchEvent(new CustomEvent(`studio:send:${sid}`, { detail: { text } }));
}
export function onStudioSend(sid: number, cb: (text: string) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { text?: string } | undefined;
    if (detail?.text) cb(detail.text);
  };
  window.addEventListener(`studio:send:${sid}`, handler);
  return () => window.removeEventListener(`studio:send:${sid}`, handler);
}
