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

/**
 * How many sessions keep their diagram XML resident. Matches the bound the
 * other per-session stores use (`agent-stream/prune-sessions`, worker-log).
 *
 * Without a cap this map grew for the life of the renderer: one mxGraph
 * document is easily tens to hundreds of KB, so a work session that opened a
 * dozen chats with diagrams retained every one of them. Eviction is safe by
 * this store's own contract — the XML here is only the LIVE copy for instant
 * render, and the `.drawio` file on disk is the durable source of truth, so a
 * reopened session simply reads the file again.
 */
const MAX_RESIDENT_SESSIONS = 8;

const stateBySession = new Map<string, DiagramState>();
const listeners = new Map<string, Set<() => void>>();

/**
 * Drop the least-recently-written entries past the cap. A session with live
 * subscribers is never evicted — its panel is on screen and would blank out.
 * `Map` iterates in insertion order and `setDiagramXml` re-inserts on write,
 * so the head of the iteration is the least-recently-written.
 */
function evictIdle(): void {
  if (stateBySession.size <= MAX_RESIDENT_SESSIONS) return;
  for (const sessionId of [...stateBySession.keys()]) {
    if (stateBySession.size <= MAX_RESIDENT_SESSIONS) return;
    if (listeners.has(sessionId)) continue;
    stateBySession.delete(sessionId);
  }
}

function notify(sessionId: string): void {
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

export function getDiagram(sessionId: string): DiagramState | null {
  return stateBySession.get(sessionId) ?? null;
}

/** Set/replace the open diagram for a session and notify subscribers. */
export function setDiagramXml(sessionId: string, path: string, xml: string): void {
  const cur = stateBySession.get(sessionId);
  if (cur && cur.path === path && cur.xml === xml) return; // no-op on identical content
  // Delete before set so the entry moves to the END of the insertion order —
  // that is what makes iteration order a true least-recently-written ordering
  // for `evictIdle`.
  stateBySession.delete(sessionId);
  stateBySession.set(sessionId, { path, xml });
  evictIdle();
  notify(sessionId);
}

export function subscribeDiagram(sessionId: string, cb: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}
