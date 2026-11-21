/**
 * What a parent session's worker calls to delegate to a child-agent session:
 * create it (and start it through the tree admission) and wait for it inside
 * the app. Implemented by the app host (apps/http-api child-agent-host.ts);
 * E6 adds the worker transport and the tools that call it.
 *
 * Tools waiting through this port declare CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS as
 * their own timeout, so they never inherit the 5-minute default.
 */
import type { FsChildAgentSession } from '@mcp/session-storage/fs-store/index.js';
import type { ChildAgentRequest } from '../runtime/child-agent-sessions.js';
import type { ChildAgentWaitResult } from '../runtime/child-agent-wait.js';

export { CHILD_AGENT_WAIT_MAX_MS, CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS } from '../runtime/child-agent-wait.js';

export interface ChildAgentCreateRequest extends ChildAgentRequest {
  /** The task its first run starts with. */
  task: string;
  /** Default true: queue the run right away. */
  start?: boolean;
  /**
   * Default true: the caller waits for the result. False: the run is
   * background and its end reaches the parent as a mailbox notice.
   */
  wait?: boolean;
}

export interface ChildAgentWaitRequest {
  chatIds: readonly string[];
  mode?: 'any' | 'all';
  /** Per child, the request the wait is about (default: its current one). */
  since?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface ChildAgentPort {
  /** Creates the child, or finds it by key; a stopped child found this way is started again explicitly. */
  create(parentId: string, request: ChildAgentCreateRequest): Promise<{ child: FsChildAgentSession; created: boolean; target?: ChildChatTarget }>;
  wait(request: ChildAgentWaitRequest): Promise<ChildAgentWaitResult>;
  /**
   * Stops `chatIds` and all their descendants for `callerId`, which must be an
   * ancestor of each in the same tree (ChildAgentStopRefused otherwise).
   * Idempotent; returns every chat the stop covered.
   */
  stop(callerId: string, chatIds: readonly string[]): Promise<{ stopped: string[] }>;
}

export interface ChildChatTarget { provider: string; model: string; effort: string | null }
