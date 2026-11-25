/**
 * Waiting for child agents inside the app, without model rounds: the wait
 * reads only durable state (the child's queue entry in the app's files and the
 * run conclusion its worker recorded in its bundle), so a parent that restarts mid-wait and waits again gets the
 * same recorded result without re-running anything. It returns when the
 * child(ren) finished, a child asked its parent a question (D7), a child is
 * paused on an approval prompt, the wait cap passed, or the parent aborted.
 */
import type { FsChildAgentSession, FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import type { ChatUsage } from '../core/messages.js';
import { SUBAGENT_TOOL_RESULT_CAP } from '../core/runner.js';
import type { ChildAgentQueueStore } from './child-agent-queue-store.js';

/** Longest single wait for a child agent. */
export const CHILD_AGENT_WAIT_MAX_MS = 30 * 60_000;
/** The tool timeout E6 declares on create_chat / send_chat_message / wait_chats (cap + margin). */
export const CHILD_AGENT_WAIT_TOOL_TIMEOUT_MS = CHILD_AGENT_WAIT_MAX_MS + 60_000;

export type ChildAgentWaitStatus = 'idle' | 'queued' | 'running' | 'question' | 'awaiting_approval'
  | 'completed' | 'failed' | 'cut_off' | 'aborted';
const TERMINAL: ReadonlySet<ChildAgentWaitStatus> = new Set(['idle', 'completed', 'failed', 'cut_off', 'aborted']);
const INTERRUPTING: ReadonlySet<ChildAgentWaitStatus> = new Set(['question', 'awaiting_approval']);

export interface ChildAgentWaitItem {
  chatId: string;
  status: ChildAgentWaitStatus;
  reason?: string;
  runId?: string;
  /** Bounded to the subagent result cap when spilled; the full answer is then in `outputId`. */
  finalText?: string | null;
  outputId?: string | null;
  question?: { requestId: string; text: string };
  changedFiles?: string[];
  usage?: ChatUsage;
}

export interface ChildAgentWaitResult {
  outcome: 'ready' | 'timeout' | 'aborted';
  items: ChildAgentWaitItem[];
}

export interface ChildAgentWaitDeps {
  sessions: Pick<FsSessionStore, 'getChildAgentSession'>;
  /** The run queue, in the app's files. */
  queue: Pick<ChildAgentQueueStore, 'get'>;
  /**
   * Re-reads a child from disk. The child's own worker writes its conclusion
   * through another store instance, so the app must not trust its cached view.
   */
  refresh?(childId: string): Promise<unknown>;
  /** An unanswered question the child sent its parent (the chat mailbox). */
  pendingQuestion?(child: FsChildAgentSession): Promise<{ requestId: string; text: string } | null>;
  /** Whether the child's live run is paused on an approval prompt (the host pool). */
  awaitingApproval?(childId: string): boolean;
  /**
   * Spills a long answer the way spawn_agent did (the parent's tool output
   * store, readable with get_tool_output). Given only on the parent worker's
   * side; without it the full recorded answer is returned.
   */
  spill?(text: string): string | null;
}

/** Questions from the child to its parent still waiting for a response. */
export function mailboxQuestions(mailbox: ChatCollaborationStore): ChildAgentWaitDeps['pendingQuestion'] {
  return async (child) => {
    const from = rootChatId(child.id), to = rootChatId(child.parent_session_id);
    const question = (await mailbox.pending(to)).find((message) => message.from === from && message.to === to && message.kind === 'question');
    return question ? { requestId: question.id, text: question.body } : null;
  };
}

const RELEASED_AS: Record<string, ChildAgentWaitStatus> = { cancelled: 'aborted', stopped: 'aborted' };

async function evaluate(deps: ChildAgentWaitDeps, chatId: string, since: string): Promise<ChildAgentWaitItem> {
  await deps.refresh?.(chatId);
  const child = await deps.sessions.getChildAgentSession(chatId);
  if (!child) return { chatId, status: 'failed', reason: 'not_a_child_agent' };
  const queue = await deps.queue.get(chatId);
  // Stopped after this request: reported at once, without waiting for the run to wind down.
  const stopped = queue.stop_requested_at && queue.stop_requested_at >= since ? queue.stop_reason ?? 'stopped' : null;
  const done = child.conclusion;
  if (done && done.finished_at >= since) {
    const text = done.final_text;
    const long = !!text && !!deps.spill && text.length > SUBAGENT_TOOL_RESULT_CAP;
    return { chatId, status: done.state, reason: stopped && done.state === 'aborted' ? stopped : done.reason, runId: done.run_id,
      changedFiles: done.changed_files, usage: done.usage,
      finalText: long ? text!.slice(0, SUBAGENT_TOOL_RESULT_CAP) : text, outputId: long ? deps.spill!(text!) : null };
  }
  if (stopped) return { chatId, status: 'aborted', reason: stopped };
  if (queue.state === 'idle') return { chatId, status: 'idle' };
  // Released without a conclusion: cancelled in the queue, or never ran (start failure, lost worker, orphan).
  if (queue.state === 'released') {
    return { chatId, status: RELEASED_AS[queue.release_reason ?? ''] ?? 'failed', reason: queue.release_detail ?? queue.release_reason ?? 'released' };
  }
  const question = await deps.pendingQuestion?.(child);
  if (question) return { chatId, status: 'question', question };
  if (queue.state === 'admitted' && deps.awaitingApproval?.(chatId)) return { chatId, status: 'awaiting_approval' };
  return { chatId, status: queue.state === 'queued' ? 'queued' : 'running' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Waits for `chatIds` ('any': the first that finishes; 'all': every one). A
 * question or an approval prompt returns at once in both modes. `since` is the
 * request the wait is about (default: each child's current request), so an
 * older conclusion never answers a newer task.
 */
export async function waitForChildAgents(deps: ChildAgentWaitDeps, input: {
  chatIds: readonly string[];
  mode?: 'any' | 'all';
  since?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}): Promise<ChildAgentWaitResult> {
  const deadline = Date.now() + Math.min(input.timeoutMs ?? CHILD_AGENT_WAIT_MAX_MS, CHILD_AGENT_WAIT_MAX_MS);
  const since: Record<string, string> = {};
  for (const id of input.chatIds) {
    since[id] = input.since?.[id] ?? (await deps.queue.get(id)).requested_at ?? '';
  }
  for (;;) {
    const items = await Promise.all(input.chatIds.map((id) => evaluate(deps, id, since[id]!)));
    const interrupted = items.some((item) => INTERRUPTING.has(item.status));
    const finished = input.mode === 'all'
      ? items.every((item) => TERMINAL.has(item.status))
      : items.some((item) => TERMINAL.has(item.status));
    if (interrupted || finished || items.length === 0) return { outcome: 'ready', items };
    if (input.signal?.aborted) return { outcome: 'aborted', items };
    if (Date.now() >= deadline) return { outcome: 'timeout', items };
    await sleep(Math.min(input.pollMs ?? 1_000, Math.max(0, deadline - Date.now())), input.signal);
  }
}
