import { type AgentRunStatus, type SubordinateHandle } from '@mcp/company/types.js';
import type { ConcurrencyPolicy } from '@mcp/company/ConcurrencyPolicy.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { IAgentStatusUpdater, IBoardPoster, IKanbanNotifier, IMasterNotifier, IMetaBusWirer } from '@mcp/company/services/ports.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import { type SubordinateCompletionDeps } from '@mcp/company/services/subordinate/completion-handler.js';
export interface SpawnSubordinateDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  kanban: IKanbanNotifier;
  master: IMasterNotifier;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  attention: MasterAttention;
  orchestratorRef: unknown;
  concurrencyPolicy: ConcurrencyPolicy;
  subordinates: Map<string, SubordinateHandle>;
  runningIds: Set<string>;
  /** Synchronous spawn-reservation counter (closes the cap TOCTOU). See
   *  SubordinateLifecycle.pendingSpawns. */
  pendingSpawns: { count: number };
  notifyIdleChanged: () => void;
  /** Wire HumanInTheLoop + meta-bus listeners on the runner. */
  wireDeps: {
    humanInLoop: HumanInTheLoop;
    wirer: IMetaBusWirer;
  };
  /** Deps bag forwarded to `attachSubordinateCompletionHandler`. */
  completionDeps: SubordinateCompletionDeps;
  /** Helper to compose the `running` list in concurrency-error messages. */
  listRunning: () => Array<{ agentRunId: string; role: string }>;
  /**
   * C2 — per-session autonomy config; source of the global-budget cap
   * (`maxSubordinates`, default 8). Optional: callers/tests without it
   * fall back to `resolveAutonomy(null, process.env)` — never crash.
   */
  autonomy?: Pick<AutonomyProvider, 'get'>;
}

export interface SpawnResult {
  agentRunId: string;
  coderSessionId: string;
  status: AgentRunStatus;
}
