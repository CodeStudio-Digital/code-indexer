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

// `'blocker'` is a persisted board classification only. It deliberately
// carries no hidden runner/session control; agents that need human input use
// an explicit interactive question instead.
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
    agentRunId: string | null,
    kind: BoardKind,
    content: string,
    mentions?: string[],
  ): void;
  read(opts?: { sinceSeq?: number; limit?: number; mentionsRole?: string }): BoardEntry[];
  /** Watermark: last sequence the master is known to have seen. */
  readonly lastMasterSeenSeq: number;
  advanceMasterWatermark(entrySeq: number): void;
}

/** Minimal kanban surface for auto-comments/auto-moves. */
export interface IKanbanNotifier {
  findCardForAgent(agentRunId: string): string | null;
  addComment(cardId: string, role: string, agentRunId: string | null, content: string): void;
  moveCard(cardId: string, column: KanbanColumn): void;
  getCard(cardId: string): KanbanCardFull | null;
}

/** Centralised agent-run entity status writes + dashboard events. */
export interface IAgentStatusUpdater {
  setStatus(agentRunId: string, status: AgentRunStatus, message?: string): void;
  /**
   * Write the status AND publish an `agent_status` event (no board post).
   * `opts.coderSessionId` rides along so the dashboard can open the agent's
   * transcript the moment it spawns. Use this (not `setStatus`) wherever the
   * UI needs to learn about the status change live.
   */
  publishStatus(
    agentRunId: string,
    role: string,
    status: AgentRunStatus,
    opts?: { message?: string; coderSessionId?: string },
  ): void;
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
  readonly agentRunId: string | null;
}

/** Read-only subordinate counters (for idle controller). */
export interface ISubordinateQuery {
  readonly runningCount: number;
  isRunning(agentRunId: string): boolean;
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
  wire(handle: RunCoderHandle, role: string, agentRunId: string): void;
}

/** Snapshot of whether the session is aborted / bus ended. */
export interface ISessionState {
  readonly isAborted: boolean;
  readonly isBusEnded: boolean;
}
