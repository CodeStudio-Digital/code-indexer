/**
 * Session-keyed store for the currently-open diagram in the chat panel.
 * Module-level Map + listener set (same shape as studio-context-store): the
 * SSE handler writes the XML the agent just produced, and DiagramPanel
 * subscribes to render it in the embedded editor.
 *
 * This holds only the LIVE in-memory XML for instant render — the `.drawio`
 * file is the durable source of truth (written by the agent tool or the
 * panel's autosave write-back).
 */

export interface DiagramState {
  /** Project-relative path, e.g. `diagrams/auth-flow.drawio`. */
  path: string;
  /** The mxGraph XML last produced for this diagram. */
  xml: string;
}

const stateBySession = new Map<number, DiagramState>();
const listeners = new Map<number, Set<() => void>>();

function notify(sessionId: number): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb();
    } catch {
      /* a bad listener must not break the others */
    }
  }
}

export function getDiagram(sessionId: number): DiagramState | null {
  return stateBySession.get(sessionId) ?? null;
}

/** Set/replace the open diagram for a session and notify subscribers. */
export function setDiagramXml(sessionId: number, path: string, xml: string): void {
  const cur = stateBySession.get(sessionId);
  if (cur && cur.path === path && cur.xml === xml) return; // no-op on identical content
  stateBySession.set(sessionId, { path, xml });
  notify(sessionId);
}

export function subscribeDiagram(sessionId: number, cb: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}
