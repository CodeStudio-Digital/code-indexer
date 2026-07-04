/**
 * Pinned Tabs — data model.
 *
 * A pin is a *captured navigation target*: every pin carries a self-sufficient
 * `href` so the global Pinned Tabs Bar can send you back to it from anywhere in
 * the app (even outside the pinned project). Because in-app navigation is
 * URL-driven, all three kinds reduce to a route:
 *   - project → `/projects/:id`
 *   - session → `/projects/:id?session=:sid` | `/global?session=:sid` | company URL
 *   - rail    → `/projects/:id?tab=:tabId`  (ProjectView honours `?tab=` on mount)
 *
 * `icon` is a lucide icon NAME (string), never a component, so pins serialize
 * cleanly to localStorage; `iconFor()` resolves the name back with a fallback.
 * `id` is deterministic (see the *PinId helpers) so togglePin + active-match
 * work by equality.
 */

export type PinKind = 'project' | 'session' | 'rail';
export type SessionScope = 'project' | 'global' | 'company';

/** Which workspace-layout drawer a rail pin should reopen after navigating.
 *  Reserved for the JetBrains tool-window signal (e.g. `activeRight==='chat'`)
 *  that lives outside the URL. Not populated in v1 — `?tab=` self-restores. */
export interface RailRestore {
  side: 'left' | 'right' | 'bottom';
  toolId: string;
}

interface PinBase {
  /** Stable identity — dedupe key + active-match key. */
  id: string;
  kind: PinKind;
  /** Display text, resolved at pin time. */
  label: string;
  /** Lucide icon NAME (JSON-safe), resolved via `iconFor()`. */
  icon: string;
  /** Router destination; `navigate(href)` reproduces the view. */
  href: string;
}

export interface ProjectPin extends PinBase {
  kind: 'project';
  projectId: number;
}

export interface SessionPin extends PinBase {
  kind: 'session';
  scope: SessionScope;
  /** Session id (for company scope this is the root session id). */
  sessionId: number;
  /** Present for scope === 'project'. */
  projectId?: number;
}

export interface RailPin extends PinBase {
  kind: 'rail';
  projectId: number;
  tabId: string;
  restore?: RailRestore;
}

export type Pin = ProjectPin | SessionPin | RailPin;

// ── Deterministic id helpers ────────────────────────────────────────────────
export function projectPinId(projectId: number): string {
  return `project:${projectId}`;
}
export function sessionPinId(scope: SessionScope, sessionId: number): string {
  return `session:${scope}:${sessionId}`;
}
export function railPinId(projectId: number, tabId: string): string {
  return `rail:${projectId}:${tabId}`;
}
