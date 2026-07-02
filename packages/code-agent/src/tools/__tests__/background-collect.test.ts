/**
 * spawn_agent background + collect_agents — end-to-end over the real job
 * manager singleton. Asserts the fire-and-forget tool_result is immediate,
 * agents_group_start carries background:true, the job settles on its own,
 * collect returns the aggregated report, usage is accounted exactly once,
 * and abortSession kills a running job.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runParallelAgents: vi.fn() };
});

const { runBackgroundEphemeral } = await import('@mcp/code-agent/tools/spawn-agent-background.js');
const { buildCollectAgentsTool } = await import('@mcp/code-agent/tools/collect-agents.js');
const { runParallelAgents } = await import('@mcp/code-agent/tools/implement-subagent.js');
const { getSubagentJobManager } = await import('@mcp/code-agent/tools/subagent-jobs.js');
const { MICRO_AGENT_PROFILES } = await import('@mcp/code-agent/tools/micro-agent-profiles.js');

const usage: ChatUsage = { input_tokens: 20, output_tokens: 10 };
const runParallel = runParallelAgents as unknown as ReturnType<typeof vi.fn>;

function agent(label: string) {
  return { task: `do ${label}`, type: 'explore' as const, profile: MICRO_AGENT_PROFILES.explore, label, maxTurns: 50 };
}

let emit: ReturnType<typeof vi.fn>;
let bump: ReturnType<typeof vi.fn>;
let ctx: ToolContext;
let deps: never;
let SID = 900;

beforeEach(() => {
  SID += 1;
  emit = vi.fn();
  bump = vi.fn();
  ctx = { cwd: '/tmp', runner: { sessionId: SID, agentLoopV2: false, emit } } as unknown as ToolContext;
  deps = {
    provider: { name: 'stub', model: 'm' },
    parentTools: [],
    sessionStore: { bumpSessionUsage: bump, recordInvestigation: vi.fn(() => ({ id: 1 })), recordSessionInput: vi.fn() },
  } as never;
  runParallel.mockReset();
});

function mockResult(reason: 'completed' | 'error' = 'completed') {
  runParallel.mockResolvedValue({
    results: [{
      reason, finalText: 'FOUND: the thing', usage, sandboxViolations: [],
      collected: { memos: [], snapshots: [], boardPosts: [] }, transcript: [], label: 'scout', toolCallCount: 3,
    }],
    totalUsage: usage,
  });
}

function jobIdFrom(text: string): string {
  const m = text.match(/job=(\S+)/);
  if (!m) throw new Error('no job id in: ' + text);
  return m[1];
}

describe('spawn_agent background + collect_agents', () => {
  it('returns immediately with a job id and emits a background group', async () => {
    mockResult();
    const r = await runBackgroundEphemeral(deps, [agent('scout')], ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('background');
    expect(String(r.content)).toMatch(/job=job-/);
    const start = emit.mock.calls.find((c) => c[0] === 'agents_group_start');
    expect(start?.[1].background).toBe(true);
    expect(start?.[1].jobId).toBeTruthy();
  });

  it('settles on its own; collect returns the aggregated report and accounts usage once', async () => {
    mockResult();
    const spawn = await runBackgroundEphemeral(deps, [agent('scout')], ctx);
    const jobId = jobIdFrom(String(spawn.content));

    // Let the fire-and-forget job settle.
    await getSubagentJobManager().get(SID, jobId)!.settled;

    const collect = buildCollectAgentsTool(deps);
    const r = await collect.handler({ job_id: jobId, wait: true }, ctx);
    expect(String(r.content)).toContain('FOUND: the thing');
    expect(String(r.content)).toContain('### Agent 1: scout');
    // Usage accounted exactly once, at settle.
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith(SID, usage);
  });

  it('collect wait:false returns a snapshot while running, without blocking', async () => {
    // Never resolves → job stays running.
    runParallel.mockReturnValue(new Promise(() => {}));
    const spawn = await runBackgroundEphemeral(deps, [agent('scout')], ctx);
    const jobId = jobIdFrom(String(spawn.content));
    const collect = buildCollectAgentsTool(deps);
    const r = await collect.handler({ job_id: jobId, wait: false }, ctx);
    expect(String(r.content)).toContain(jobId);
    expect(String(r.content)).toContain('call collect_agents again');
  });

  it('collect on an unknown job id errors clearly', async () => {
    const collect = buildCollectAgentsTool(deps);
    const r = await collect.handler({ job_id: 'job-deadbeef' }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('not found');
  });

  it('abortSession stops a running background job', async () => {
    runParallel.mockReturnValue(new Promise(() => {}));
    const spawn = await runBackgroundEphemeral(deps, [agent('scout')], ctx);
    const jobId = jobIdFrom(String(spawn.content));
    const mgr = getSubagentJobManager();
    expect(mgr.hasActiveJobs(SID)).toBe(true);
    mgr.abortSession(SID, 'user stop');
    expect(mgr.get(SID, jobId)!.abort.signal.aborted).toBe(true);
  });
});
