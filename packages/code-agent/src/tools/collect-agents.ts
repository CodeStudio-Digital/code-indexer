/**
 * collect_agents — event-driven wait/fetch for background spawn_agent jobs.
 *
 * Already finished → returns the full aggregated result (byte-identical to the
 * blocking spawn_agent output) and marks the job collected. Still running →
 * `wait:true` (default) blocks on the job's settle promise (no polling; a
 * `timeout_s` deadline is the only timer), emitting a heartbeat so the
 * StuckBanner stays quiet; on timeout / `wait:false` it returns a per-agent
 * status snapshot and tells the model to continue useful work or finish the
 * turn so the runner can park event-driven. It never encourages provider-side
 * polling loops.
 */
import { ok, err, type CoderTool, type ToolResult, type ToolContext } from '@mcp/code-agent/core/tool.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import {
  getSubagentJobManager,
  type SubagentJob,
  type BackgroundAgentSlot,
} from '@mcp/code-agent/tools/subagent-jobs.js';

const HEARTBEAT_MS = 15_000;

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function slotLine(a: BackgroundAgentSlot): string {
  const parts = [`${a.label} — ${a.status}`, `tools=${a.toolCallCount}`];
  if (a.phase) parts.push(a.phase);
  if (a.idleMs != null) parts.push(`idle ${fmtMs(a.idleMs)}`);
  if (a.deadlineMs != null && a.elapsedMs != null) parts.push(`left ${fmtMs(Math.max(0, a.deadlineMs - a.elapsedMs))}`);
  return `- ${parts.join(', ')}`;
}

function renderSnapshot(jobs: SubagentJob[], waitExpired: boolean): string {
  if (jobs.length === 0) return 'collect_agents: no outstanding background jobs.';
  const blocks = jobs.map((j) => {
    const head = `job ${j.jobId} (${j.status}, ${j.agents.length} agents):`;
    return [head, ...j.agents.map(slotLine)].join('\n');
  });
  const guidance = waitExpired
    ? 'The wait reached its safety deadline. Do not poll collect_agents again in this run. Continue other useful work or finish the turn; the runner will park without another provider call and wake when a job completes.'
    : 'Snapshot only. Do not poll repeatedly. Continue other useful work or finish the turn; the runner will park event-driven and wake when a job completes.';
  return `${blocks.join('\n\n')}\n\n${guidance}`;
}

function terminalResult(job: SubagentJob): ToolResult {
  const completedCount = job.agents.filter((agent) => agent.status === 'completed').length;
  const partialCount = job.agents.filter((agent) => agent.status === 'partial').length;
  // A terminal job must not retain pending/running slots. Count them as failed
  // defensively so a dropped progress event can never produce a false success.
  const failedCount = job.agents.length - completedCount - partialCount;
  const stillFailed = partialCount + failedCount;
  const status = stillFailed === 0
    ? 'completed'
    : completedCount > 0 || partialCount > 0
      ? 'partial'
      : 'failed';
  const structuredData = {
    kind: 'collect_agents_result',
    status,
    jobId: job.jobId,
    spawnId: job.groupId,
    agentCount: job.agents.length,
    completedCount,
    partialCount,
    failedCount,
    stillFailed,
    resumableCount: job.resumableCount,
    results: job.agents.flatMap(agent => agent.result ? [agent.result] : []),
  };
  const content = job.resultText ?? '(background job produced no result)';
  if (status === 'completed') {
    return { ...ok(content), structuredData };
  }

  const retryable = job.resumableCount > 0;
  return {
    content,
    isError: true,
    error: {
      code: status === 'partial' ? 'COLLECT_AGENTS_PARTIAL' : 'COLLECT_AGENTS_FAILED',
      kind: 'tool_error',
      retryable,
      suggestedAction: retryable
        ? `Call resume_agent with spawn_id '${job.groupId}' to continue only the unfinished agents.`
        : 'No resumable checkpoint is available; narrow or decompose the task before spawning replacement work.',
    },
    structuredData,
  };
}

const COLLECT_DESC =
  'Wait for / fetch the results of a background spawn_agent job. Pass the job id from the spawn result. ' +
  'Omit job_id to wait for ANY outstanding job. Blocks until done by default; set wait:false for an instant status snapshot. ' +
  'Returns the same aggregated report a blocking spawn_agent would.';

export function buildCollectAgentsTool(_deps: SubagentDeps): CoderTool {
  return {
    name: 'collect_agents',
    description: COLLECT_DESC,
    source: 'native',
    mutates: false,
    riskLevel: 'read',
    // Collects only background jobs started by these.
    continues: ['spawn_agent', 'resume_agent'],
    parallelSafe: false,
    // Exempt from the dup-call cap AND the dispatch timeout — it enforces its
    // own deadline via `timeout_s`.
    repeatPolicy: 'pollable',
    timeoutMs: Infinity,
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Background job id from spawn_agent. Omit to wait for any outstanding job.' },
        wait: { type: 'boolean', description: 'Default true: block until the target finishes. false: return a status snapshot now.' },
        timeout_s: { type: 'number', description: 'Max seconds to wait (default 1800, max 1800).' },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {

      const sessionId = ctx.runner?.sessionId;
      if (sessionId == null) return err('collect_agents: no active session.');
      const manager = getSubagentJobManager();
      const jobId = typeof args.job_id === 'string' && args.job_id.trim() ? args.job_id.trim() : null;
      const wait = args.wait !== false;
      const timeoutS = Math.min(1800, Math.max(1, typeof args.timeout_s === 'number' ? args.timeout_s : 1800));

      if (jobId && !manager.get(sessionId, jobId)) {
        return err(
          `collect_agents: job '${jobId}' not found — it may have been collected and expired, ` +
          `or the session worker restarted. Inspect the retained child checkpoint and reconcile its effects before resuming; do not re-spawn an unknown execution.`,
        );
      }

      const heartbeat = wait
        ? setInterval(() => {
            const active = manager.list(sessionId).filter((j) => j.status === 'running');
            const note = `waiting on ${jobId ?? 'any job'} (${active.length} running)`;
            ctx.reportHeartbeat?.(note);
          }, HEARTBEAT_MS)
        : null;

      try {
        const res = await manager.waitAny(sessionId, jobId ? [jobId] : null, ctx.signal, wait ? timeoutS * 1000 : 0);
        switch (res.kind) {
          case 'done':
            manager.markDelivery(res.job, 'collected');
            return terminalResult(res.job);
          case 'timeout': {
            const jobs = jobId ? manager.list(sessionId).filter((j) => j.jobId === jobId) : manager.list(sessionId).filter((j) => j.status === 'running');
            return { ...ok(renderSnapshot(jobs, wait)), structuredData: { schemaVersion: 1, reason: 'timeout', items: jobs.map(job => ({ id: job.jobId, state: job.status })), cursor: null } };
          }
          case 'aborted':
            return { ...ok('[collect_agents: wait aborted]'), structuredData: { schemaVersion: 1, reason: 'aborted', items: [], cursor: null } };
          case 'empty':
            return ok('collect_agents: no outstanding background jobs.');
          case 'not_found':
            return err(`collect_agents: job '${jobId}' not found.`);
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
  };
}
