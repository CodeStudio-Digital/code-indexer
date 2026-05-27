/**
 * Ports — narrow interfaces (ISP) that services depend on, rather than
 * on the concrete CompanyOrchestrator. Each service only sees the
 * capabilities it actually uses, which makes them:
 *   - Easier to test (swap fakes for specific ports)
 *   - Safer to refactor (cycles broken at interface level)
 *   - Obvious in intent (you can read the ports list to see the surface)
 */

import type { RunCoderHandle } from '@mcp/code-agent/index.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import type { AgentRunStatus, KanbanCardFull, KanbanColumn, BoardEntry } from '@mcp/company/types.js';

// `'blocker'` = the agent reports an impediment it can't resolve on
// its own (missing tools, missing config, ambiguous external state).
// When `post_to_board` is called with this kind, the runner aborts
// after the post — the master ends, the user reads the blocker on
// the board and decides how to intervene. The next user message
// resurrects the master with full history preserved. Distinct from
// `'question'` because the agent isn't asking for a single answer —
// it's stopping the whole run for human attention.
export type BoardKind = 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker';

/** Publish events to the per-session meta-bus. */
export interface IMetaBusPublisher {
  readonly bus: CoderRunBus;
  publish(event: string, data: unknown): void;
  markEnded(event: 'done' | 'error', data: unknown): void;
}

/** Post to the persisted board and publish a board_entry event. */
export interface IBoardPoster {
  post(
    authorRole: string,
    agentRunId: number | null,
    kind: BoardKind,
    content: string,
    mentions?: string[],
  ): void;
  read(opts?: { sinceId?: number; limit?: number; mentionsRole?: string }): BoardEntry[];
  /** Watermark: last id the master is known to have seen. */
  readonly lastMasterSeenId: number;
  advanceMasterWatermark(entryId: number): void;
}

/** Minimal kanban surface for auto-comments/auto-moves. */
export interface IKanbanNotifier {
  findCardForAgent(agentRunId: number): number | null;
  addComment(cardId: number, role: string, agentRunId: number | null, content: string): void;
  moveCard(cardId: number, column: KanbanColumn): void;
  getCard(cardId: number): KanbanCardFull | null;
}

/** Centralised `company_agent_runs.status` writes + dashboard events. */
export interface IAgentStatusUpdater {
  setStatus(agentRunId: number, status: AgentRunStatus, message?: string): void;
}

/** Master-side notifications — called from subordinate code paths. */
export interface IMasterNotifier {
  /** Alive master → pushUserMessage. Dead master → resurrect with message. */
  notify(message: string): void;
  readonly isAlive: boolean;
  /** Error string if master ended with error, else null. */
  readonly endedWithError: string | null;
  setShouldContinue(value: boolean): void;
  readonly handle: RunCoderHandle | null;
  readonly agentRunId: number | null;
}

/** Read-only subordinate counters (for idle controller). */
export interface ISubordinateQuery {
  readonly runningCount: number;
  isRunning(agentRunId: number): boolean;
}

/** Idle/pause lifecycle hooks. */
export interface IIdleController {
  /** Call when master's runner loop has ended. */
  onMasterEnded(): void;
  /** Call when master has just been resurrected (cancels any pending idle timer). */
  onMasterResurrected(): void;
  /** Call when a user message arrives (cancels idle timer). */
  onUserMessageReceived(): void;
  /** Call when a subordinate's running status changes. */
  onSubordinatesChanged(): void;
  /** For abort paths. */
  clear(): void;
}

/** Wire runner events (text/tool/done/...) to the meta-bus. */
export interface IMetaBusWirer {
  wire(handle: RunCoderHandle, role: string, agentRunId: number): void;
}

/** Snapshot of whether the session is aborted / bus ended. */
export interface ISessionState {
  readonly isAborted: boolean;
  readonly isBusEnded: boolean;
}
