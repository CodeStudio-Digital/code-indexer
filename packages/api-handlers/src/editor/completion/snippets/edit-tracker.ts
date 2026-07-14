/**
 * Recent-edit tracking for completion context — a module singleton that
 * subscribes to document-store events (didChange already flows through
 * doc-sync, so this costs no new payload and no api-bus change) and keeps a
 * small ring of line spans the user recently touched, per project. The
 * recent-edits source excerpts the CURRENT buffer around those spans —
 * Continue.dev's recentlyEditedRanges, Cursor's strongest context signal.
 *
 * DocChange frames carry the edited `range` (1-based, pre-change lines) —
 * exact enough for hint context without any offset→line scanning.
 */
import { onDocEvent, type DocListener } from '../../../lsp/document-store.js';

export interface EditEntry {
  file: string;
  startLine: number;
  endLine: number;
  ts: number;
  version: number;
}

const MAX_EDITS_PER_PROJECT = 8;
/** Spans overlapping or within this many lines coalesce into one entry. */
const COALESCE_LINES = 2;

// Module-level (Electron dual-factory + engine both see the same state).
const edits = new Map<number, EditEntry[]>();
const tabTouch = new Map<number, Map<string, number>>();
const revisions = new Map<number, number>();
let subscribed = false;

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function touchTab(projectId: number, file: string): void {
  let m = tabTouch.get(projectId);
  if (!m) { m = new Map(); tabTouch.set(projectId, m); }
  m.delete(file);
  m.set(file, Date.now());
  if (m.size > 64) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

/** Exported for tests — the doc-event handler body. */
export const handleEvent: DocListener = (e) => {
  try {
    revisions.set(e.projectId, (revisions.get(e.projectId) ?? 0) + 1);
    if (e.kind === 'open') {
      touchTab(e.projectId, e.file);
      return;
    }
    if (e.kind === 'close') {
      const ring = edits.get(e.projectId);
      if (ring) edits.set(e.projectId, ring.filter((en) => en.file !== e.file));
      tabTouch.get(e.projectId)?.delete(e.file);
      return;
    }
    // change
    touchTab(e.projectId, e.file);
    if (!e.changes) return;
    let ring = edits.get(e.projectId);
    if (!ring) { ring = []; edits.set(e.projectId, ring); }
    for (const c of e.changes) {
      const startLine = c.range.start.line;
      const endLine = startLine + countLines(c.text);
      const hit = ring.find(
        (en) => en.file === e.file
          && startLine <= en.endLine + COALESCE_LINES
          && endLine >= en.startLine - COALESCE_LINES,
      );
      if (hit) {
        hit.startLine = Math.min(hit.startLine, startLine);
        hit.endLine = Math.max(hit.endLine, endLine);
        hit.ts = Date.now();
        hit.version = e.doc.version;
        // Refresh recency: move to the end of the ring.
        ring.splice(ring.indexOf(hit), 1);
        ring.push(hit);
      } else {
        ring.push({ file: e.file, startLine, endLine, ts: Date.now(), version: e.doc.version });
        if (ring.length > MAX_EDITS_PER_PROJECT) ring.shift();
      }
    }
  } catch { /* tracking must never break doc-sync */ }
};

/** Idempotent — call from the engine on first use. */
export function ensureTracking(): void {
  if (subscribed) return;
  subscribed = true;
  onDocEvent(handleEvent);
}

/**
 * Recent edit spans for a project, most recent first. Entries in
 * `excludeFile` whose span intersects `excludeLines` (the prompt window —
 * already visible to the model) are dropped; other spans in the same file
 * are kept (edits far above/below the window are real signal).
 */
export function recentEdits(
  projectId: number,
  excludeFile: string,
  excludeLines?: [number, number],
): EditEntry[] {
  const ring = edits.get(projectId) ?? [];
  return [...ring].reverse().filter((en) => {
    if (en.file !== excludeFile) return true;
    if (!excludeLines) return false;
    return en.endLine < excludeLines[0] || en.startLine > excludeLines[1];
  });
}

/** Tab-recency timestamps for a project (open-tabs source ordering). */
export function tabRecency(projectId: number): Map<string, number> {
  return tabTouch.get(projectId) ?? new Map();
}

/** Monotonic revision for tab/recent-edit context and completion cache keys. */
export function contextRevision(projectId: number): number {
  return revisions.get(projectId) ?? 0;
}

/** Drop a project's tracked state (project delete/unload — avoids slow leak). */
export function clearProjectEdits(projectId: number): void {
  edits.delete(projectId);
  tabTouch.delete(projectId);
  revisions.delete(projectId);
}

/** Test hook — module state reset. */
export function __resetEditTrackerForTests(): void {
  edits.clear();
  tabTouch.clear();
  revisions.clear();
}
