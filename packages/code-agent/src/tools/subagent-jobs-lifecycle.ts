/**
 * subagent-jobs-lifecycle — liveness glue for background jobs:
 *   - renderCompletionNotice: the compact <system-reminder> announcing a
 *     settled job (full findings stay behind collect_agents).
 *   - parkForBackgroundWork: the wake-on-complete gate. A clean run does not
 *     end while background jobs run — it parks here until a job settles (→
 *     push the notice, resume), the user sends a message, the run aborts, or a
 *     safety cap elapses.
 *
 * Kept out of the core so the runner bridge wires it without core importing
 * tools/.
 */
import type { SubagentJob, SubagentJobManager, BackgroundAgentSlot } from '@mcp/code-agent/tools/subagent-jobs.js';

const SUMMARY_CAP = 200;

function statusCounts(agents: BackgroundAgentSlot[]): { done: number; failed: number } {
  let done = 0, failed = 0;
  for (const a of agents) {
    if (a.status === 'completed') done++;
    else if (a.status === 'error' || a.status === 'timed_out' || a.status === 'aborted') failed++;
  }
  return { done, failed };
}

export function renderCompletionNotice(job: SubagentJob): string {
  const { done, failed } = statusCounts(job.agents);
  const lines: string[] = [
    '<system-reminder>',
    `background agents finished — job ${job.jobId} (${job.agents.length} agents): ${done} completed, ${failed} failed.`,
  ];
  for (const a of job.agents) {
    const digest = a.summary ? ` — "${a.summary.replace(/\s+/g, ' ').slice(0, SUMMARY_CAP)}"` : '';
    lines.push(`- ${a.label} (${a.profileId}): ${a.status}, ${a.toolCallCount} tools${digest}`);
  }
  lines.push(
    `Summaries above are truncated. Call collect_agents({job_id:"${job.jobId}"}) for the full findings (instant, no waiting).` +
    (failed > 0 ? ` To retry failures: resume_agent({spawn_id:"${job.groupId}"}).` : '') +
    ` Do not re-spawn these tasks.`,
    '</system-reminder>',
  );
  return lines.join('\n');
}

export type ParkOutcome = 'work' | 'message' | 'aborted' | 'timeout';

export interface ParkDeps {
  manager: SubagentJobManager;
  sessionId: number;
  /** Run signal — aborting it ends the park as 'aborted'. */
  signal: AbortSignal;
  /** Safety cap: park never blocks longer than this. */
  capMs: number;
  waitForMessage: (signal: AbortSignal) => Promise<void>;
  hasPendingMessage: () => boolean;
  /** Queue the completion notice as the next turn's user message. */
  pushNotice: (text: string) => void;
  /** Durably persist the notice so a later run's history carries it. */
  persistNotice?: (text: string) => void;
}

/**
 * Park until a background job settles, the user speaks, the run aborts, or the
 * safety cap elapses. On a settled job, pushes (and optionally persists) the
 * completion notice before returning 'work' so the resumed Executing turn
 * delivers it.
 */
export async function parkForBackgroundWork(deps: ParkDeps): Promise<ParkOutcome> {
  if (deps.hasPendingMessage()) return 'message';
  if (deps.signal.aborted) return 'aborted';

  // `local` fans a run abort into BOTH waiters AND lets `finally` cancel the
  // loser: whichever side wins the race, `local.abort()` releases the other's
  // timer/listener (else the losing `waitAny` would keep a 30-min timer + a
  // run-signal listener alive per park cycle — a leak on message-wins).
  const local = new AbortController();
  const onRunAbort = () => local.abort();
  if (deps.signal.aborted) local.abort();
  else deps.signal.addEventListener('abort', onRunAbort, { once: true });
  try {
    const msgP: Promise<'message'> = deps.waitForMessage(local.signal).then(() => 'message' as const);
    const jobP: Promise<'aborted' | 'timeout' | { job: SubagentJob }> = deps.manager
      .waitAny(deps.sessionId, null, local.signal, deps.capMs, { pendingOnly: true })
      .then((r) => (r.kind === 'done' ? { job: r.job } : r.kind === 'aborted' ? 'aborted' as const : 'timeout' as const));

    const winner = await Promise.race([msgP, jobP]);
    // A user abort that raced a settle/message still ends the run.
    if (deps.signal.aborted) return 'aborted';
    if (winner === 'message') return 'message';
    if (winner === 'aborted' || winner === 'timeout') return winner;

    // A job settled — deliver its notice exactly once.
    const job = winner.job;
    if (job.delivery === 'none') {
      const text = renderCompletionNotice(job);
      deps.manager.markDelivery(job, 'notified');
      try { deps.persistNotice?.(text); } catch { /* best-effort */ }
      deps.pushNotice(text);
    }
    return 'work';
  } finally {
    local.abort();
    deps.signal.removeEventListener('abort', onRunAbort);
  }
}
