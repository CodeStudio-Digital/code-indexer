/**
 * The tree of child-agent sessions under a root session: the root of any
 * child, and every descendant of a root (all levels, up to the depth cap).
 * Read from the shared in-memory session catalog; no bundle scan.
 */
import type { FsChildAgentSession, FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

export type ChildAgentTreeStore = Pick<FsSessionStore, 'getChildAgentSession' | 'listChildAgentSessions'>;

/**
 * Most child-agent sessions one tree may create in a rolling window. It stops
 * a creation loop (each child inside the concurrency limit, one after the
 * other) while leaving room for long delegated work: 24 matches the starts
 * budget Ultra and Company already give a root (maxStarts 24).
 */
export const MAX_TREE_CHILDREN_PER_WINDOW = 24;
export const TREE_CHILDREN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The root session above `sessionId`: itself when it is not a child agent. */
export async function childAgentRoot(sessions: ChildAgentTreeStore, sessionId: string): Promise<string> {
  let current = sessionId;
  // Depth is capped, so this walk is short; the bound guards a corrupt cycle.
  for (let step = 0; step < 16; step++) {
    const child = await sessions.getChildAgentSession(current);
    if (!child) return current;
    current = child.parent_session_id;
  }
  throw new Error(`Child-agent ancestry of ${sessionId} does not end`);
}

/** Every child-agent descendant of `rootId`, oldest first. */
export async function childAgentDescendants(sessions: ChildAgentTreeStore, rootId: string): Promise<FsChildAgentSession[]> {
  const found: FsChildAgentSession[] = [];
  const seen = new Set<string>([rootId.toLowerCase()]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of await sessions.listChildAgentSessions(id)) {
        const key = String(child.id).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(child);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return found.sort((a, b) => a.created_at.localeCompare(b.created_at) || String(a.id).localeCompare(String(b.id)));
}

/** Throws when the tree of `rootId` already created its window's worth of children. */
export async function assertTreeCanCreateChild(
  sessions: ChildAgentTreeStore,
  rootId: string,
  now: Date = new Date(),
): Promise<void> {
  const since = new Date(now.getTime() - TREE_CHILDREN_WINDOW_MS).toISOString();
  const recent = (await childAgentDescendants(sessions, rootId)).filter((child) => child.created_at >= since);
  if (recent.length >= MAX_TREE_CHILDREN_PER_WINDOW) {
    throw new Error(`Child-agent limit reached: this tree created ${recent.length} child agents in the last 24 hours (max ${MAX_TREE_CHILDREN_PER_WINDOW})`);
  }
}
