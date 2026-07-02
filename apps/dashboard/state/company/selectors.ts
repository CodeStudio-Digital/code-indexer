/**
 * Reusable selector helpers for the company store. Co-located so the
 * three legacy hooks (`useCompanyStream`, `useCompanySiblings`,
 * `useKanbanState`) and any new Phase 1 components pull from the same
 * canonical accessors instead of reaching into slice internals.
 *
 * Returning fresh fallback objects from selectors would cause React to
 * subscribe to a new reference every render — these helpers always
 * return either the stored slot or a stable empty object exported below.
 */
import { INITIAL_KANBAN_STATE, INITIAL_SIBLING_STATE, INITIAL_STREAM_STATE } from './types.js';
import type { KanbanState, SiblingState, StreamState } from './types.js';
import { INITIAL_SANDBOX_STATE, type SandboxState } from './sandboxSlice.js';
import { INITIAL_DRIVE_STATE, type DriveState } from './driveSlice.js';
import { INITIAL_INBOX_STATE, type InboxState } from './inboxSlice.js';
import { INITIAL_AUTONOMY_STATE, type AutonomyState } from './autonomySlice.js';
import type { CompanyStore } from './index.js';

export const EMPTY_STREAM_STATE: StreamState = INITIAL_STREAM_STATE;
export const EMPTY_KANBAN_STATE: KanbanState = INITIAL_KANBAN_STATE;
export const EMPTY_SIBLING_STATE: SiblingState = INITIAL_SIBLING_STATE;
export const EMPTY_SANDBOX_STATE: SandboxState = INITIAL_SANDBOX_STATE;
export const EMPTY_DRIVE_STATE: DriveState = INITIAL_DRIVE_STATE;
export const EMPTY_INBOX_STATE: InboxState = INITIAL_INBOX_STATE;
export const EMPTY_AUTONOMY_STATE: AutonomyState = INITIAL_AUTONOMY_STATE;

/** Stream state for `sessionId`, or the stable empty state if absent. */
export function selectStream(
  state: CompanyStore,
  sessionId: number | null,
): StreamState {
  if (sessionId == null) return EMPTY_STREAM_STATE;
  return state.streams.get(sessionId) ?? EMPTY_STREAM_STATE;
}

/** Sibling state for `rootId`, or the stable empty state if absent. */
export function selectSiblings(
  state: CompanyStore,
  rootId: number | null,
): SiblingState {
  if (rootId == null) return EMPTY_SIBLING_STATE;
  return state.siblings.get(rootId) ?? EMPTY_SIBLING_STATE;
}

/** Kanban state for `sessionId`, or the stable empty state if absent. */
export function selectKanban(
  state: CompanyStore,
  sessionId: number | null,
): KanbanState {
  if (sessionId == null) return EMPTY_KANBAN_STATE;
  return state.kanban.get(sessionId) ?? EMPTY_KANBAN_STATE;
}

/** Sandbox state for `sessionId`, or the stable empty state if absent. */
export function selectSandbox(
  state: CompanyStore,
  sessionId: number | null,
): SandboxState {
  if (sessionId == null) return EMPTY_SANDBOX_STATE;
  return state.sandbox.get(sessionId) ?? EMPTY_SANDBOX_STATE;
}

/** Drive state for `sessionId`, or the stable empty state if absent. */
export function selectDrive(
  state: CompanyStore,
  sessionId: number | null,
): DriveState {
  if (sessionId == null) return EMPTY_DRIVE_STATE;
  return state.drive.get(sessionId) ?? EMPTY_DRIVE_STATE;
}

/** Inbox state for `sessionId`, or the stable empty state if absent. */
export function selectInbox(
  state: CompanyStore,
  sessionId: number | null,
): InboxState {
  if (sessionId == null) return EMPTY_INBOX_STATE;
  return state.inbox.get(sessionId) ?? EMPTY_INBOX_STATE;
}

/** Autonomy (C1 visibility) state for `sessionId`, or the stable empty state. */
export function selectAutonomy(
  state: CompanyStore,
  sessionId: number | null,
): AutonomyState {
  if (sessionId == null) return EMPTY_AUTONOMY_STATE;
  return state.autonomy.get(sessionId) ?? EMPTY_AUTONOMY_STATE;
}
