/**
 * Canonical SSE event taxonomy for company-mode. Every event published on
 * the meta-bus is one of the discriminated members of `CompanyEvent`.
 *
 * Add new event types here BEFORE wiring them in
 * `MetaBusPublisher`/`useCompanyStream`/slices — the discriminated union
 * forces both sides to handle them.
 *
 * Wire format: `SSEEnvelope<CompanyEvent['data']>` where `type` matches
 * `CompanyEvent['type']`. Clients dispatch by `env.type` then cast `data`
 * via narrowing.
 */
import type { BoardEntry } from './models/board.js';
import type { KanbanCardFull, KanbanColumn } from './models/kanban.js';
import type { MasterPrompt } from './models/master-prompt.js';
import type { AgentRunStatus } from './models/agent-run.js';
import type { AgentInboxMessage } from './models/inbox.js';

// ─── Agent stream (multiplexed inner events per agent) ─────────

export interface AgentStreamPayload {
  agent: string;
  agentRunId: string;
  event: AgentInnerEvent;
  data: unknown;
}

export type AgentInnerEvent =
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_result'
  | 'message_complete'
  | 'fallback_activated'
  | 'usage'
  | 'done';

// ─── Board ─────────────────────────────────────────────────────

export interface BoardEntryEvent {
  /**
   * Note: the wire payload omits `archive_id` (active rows only) and uses
   * a permissive `kind: string` instead of the strict union — the SSE
   * publisher historically forwarded the raw row. Slices coerce when they
   * persist into client state.
   */
  id: string;
  seq: number;
  author_role: string;
  agent_run_id: string | null;
  kind: BoardEntry['kind'] | string;
  content: string;
  attachments?: BoardEntry['attachments'];
  mentions: string[];
  created_at: string;
}

// ─── Agent status ──────────────────────────────────────────────

export interface AgentStatusPayload {
  agentRunId: string;
  role: string;
  status: AgentRunStatus;
  message: string;
  /**
   * Coder session backing this agent run. Emitted at subordinate spawn so
   * the dashboard can open the agent's transcript modal immediately, before
   * the REST snapshot is refreshed. Optional — other emitters omit it.
   */
  coderSessionId?: string;
}

// ─── Master prompts (ask_user / submit_plan) ──────────────────

export interface MasterPromptPayload {
  prompt: MasterPrompt;
}

// ─── Subordinate prompts ───────────────────────────────────────

export interface SubordinatePromptPayload {
  agentRunId: string;
}

// ─── Kanban ────────────────────────────────────────────────────

export type KanbanCardCreatedData = { card: KanbanCardFull };
export type KanbanCardUpdatedData = { cardId: string; patch: Partial<KanbanCardFull> };
export type KanbanCardMovedData = { cardId: string; column: KanbanColumn; position: number };
export type KanbanCardDeletedData = { cardId: string };
export type KanbanCardCommentAddedData = { cardId: string; comment: KanbanCardFull['comments'][number] };
export type KanbanCardChecklistAddedData = { cardId: string; item: KanbanCardFull['checklist'][number] };
export type KanbanCardChecklistUpdatedData = { cardId: string; item: KanbanCardFull['checklist'][number] };
export type KanbanCardChecklistRemovedData = { cardId: string; itemId: string };
export type KanbanCardDependencyAddedData = {
  cardId: string;
  dependency: KanbanCardFull['dependencies'][number];
};
export type KanbanCardDependencyRemovedData = {
  cardId: string;
  dependencyId: string;
  dependsOnId: string;
};
export type KanbanCardAssignedData = {
  cardId: string;
  assignment: KanbanCardFull['agents'][number];
};
export type KanbanCardUnassignedData = {
  cardId: string;
  assignmentId: string;
  agentRunId: string;
};

// ─── Session lifecycle ─────────────────────────────────────────

export interface SessionIdlePayload {
  reason?: string;
  errorDetail?: string;
  /**
   * Timestamp (ISO) of when the master's runner exited. Set by
   * `runner-wiring.ts` `.finally` and propagated through `IdleController`
   * so the dashboard can render a "Master finished at HH:MM" banner.
   * Distinguishes "still busy, just idle for a bit" from "actually ended".
   */
  endedAt?: string;
  /**
   * True when the runner exit looked unexpected (errored, or terminated
   * with no recent user message). The dashboard shows a persistent
   * orange banner with `errorDetail` instead of the soft "finished" toast.
   */
  unexpected?: boolean;
}

export interface ErrorPayload {
  error?: string;
}

/**
 * P15b — published by `IdleWatchdog` when the orchestrator has gone N
 * minutes without any bus activity AND the master is still alive AND
 * no subordinates are running. Indicates a likely deadlock (master
 * blocked on a tool wait, all subs blocked too).
 *
 * Fired ONCE per stall window. Reset when any activity comes through
 * the publisher; re-fires after the next stall threshold is reached.
 */
export interface SessionStalledPayload {
  /** Milliseconds since the last bus activity. */
  stalledSinceMs: number;
  /** Free-form reason — currently always 'no_progress'. */
  reason: 'no_progress';
}

// ─── Sandbox ───────────────────────────────────────────────────

export interface SandboxFileChangedPayload {
  sessionId: string;
  serviceId?: string;
  path: string;
  changeType: 'created' | 'modified' | 'deleted';
}

export interface SandboxStatusPayload {
  sessionId: string;
  serviceId?: string;
  status: 'provisioning' | 'ready' | 'paused' | 'error' | 'destroyed';
  previewUrl?: string;
  hostPort?: number;
  errorDetail?: string;
}

// ─── Drive (new in Phase 2 — replaces 5s polling) ─────────────

export interface DriveFileEventPayload {
  scopeKey: string;
  path: string;
  ownerRole?: string;
  ownerAgentRunId?: string;
  size?: number;
}

// ─── Inbox (new in Phase 2 — replaces 5s polling) ─────────────

export interface InboxEventPayload {
  message: AgentInboxMessage;
}

// ─── Git (new in Phase 7 — invalidates GitTab slice) ──────────

export interface GitStatusChangedPayload {
  sessionId: string;
  projectId: number;
  changeType: 'commit' | 'stage' | 'reset' | 'discard' | 'init';
}

// ─── Discriminated union ───────────────────────────────────────

export type CompanyEvent =
  | { type: 'agent_event'; data: AgentStreamPayload }
  | { type: 'board_entry'; data: BoardEntryEvent }
  | { type: 'agent_status'; data: AgentStatusPayload }
  | { type: 'master_plan_posted';        data: MasterPromptPayload }
  | { type: 'master_question_posted';    data: MasterPromptPayload }
  | { type: 'master_plan_resolved';      data: MasterPromptPayload }
  | { type: 'master_question_resolved';  data: MasterPromptPayload }
  | { type: 'master_prompt_cancelled';   data: MasterPromptPayload }
  | { type: 'subordinate_plan_posted';     data: SubordinatePromptPayload }
  | { type: 'subordinate_question_posted'; data: SubordinatePromptPayload }
  | { type: 'subordinate_tasks_posted';    data: SubordinatePromptPayload }
  | { type: 'kanban_card_created';             data: KanbanCardCreatedData }
  | { type: 'kanban_card_updated';             data: KanbanCardUpdatedData }
  | { type: 'kanban_card_moved';               data: KanbanCardMovedData }
  | { type: 'kanban_card_deleted';             data: KanbanCardDeletedData }
  | { type: 'kanban_card_comment_added';       data: KanbanCardCommentAddedData }
  | { type: 'kanban_card_checklist_added';     data: KanbanCardChecklistAddedData }
  | { type: 'kanban_card_checklist_updated';   data: KanbanCardChecklistUpdatedData }
  | { type: 'kanban_card_checklist_removed';   data: KanbanCardChecklistRemovedData }
  | { type: 'kanban_card_dependency_added';    data: KanbanCardDependencyAddedData }
  | { type: 'kanban_card_dependency_removed';  data: KanbanCardDependencyRemovedData }
  | { type: 'kanban_card_assigned';            data: KanbanCardAssignedData }
  | { type: 'kanban_card_unassigned';          data: KanbanCardUnassignedData }
  | { type: 'session_idle'; data: SessionIdlePayload }
  | { type: 'error';        data: ErrorPayload }
  | { type: 'sandbox.file_changed'; data: SandboxFileChangedPayload }
  | { type: 'sandbox.status';       data: SandboxStatusPayload }
  | { type: 'drive.file_added';   data: DriveFileEventPayload }
  | { type: 'drive.file_deleted'; data: DriveFileEventPayload }
  | { type: 'drive.file_moved';   data: DriveFileEventPayload & { previousPath: string } }
  | { type: 'agent_inbox.message_created';   data: InboxEventPayload }
  | { type: 'agent_inbox.message_delivered'; data: InboxEventPayload }
  | { type: 'agent_inbox.message_answered';  data: InboxEventPayload }
  | { type: 'agent_inbox.message_cancelled'; data: InboxEventPayload }
  | { type: 'git.status_changed'; data: GitStatusChangedPayload }
  | { type: 'done'; data: Record<string, never> };

export type CompanyEventType = CompanyEvent['type'];

export type CompanyEventOfType<T extends CompanyEventType> = Extract<CompanyEvent, { type: T }>;
