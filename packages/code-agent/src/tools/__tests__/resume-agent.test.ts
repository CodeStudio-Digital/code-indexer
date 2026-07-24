/**
 * resume_agent — relaunch mechanics. Mocks runParallelAgents to assert the
 * resumed child is seeded with [transcript + continuation nudge], the same
 * groupId is re-emitted, selection excludes aborted/quality by default,
 * attempt caps are enforced, and the per-spawn lock serializes callers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runParallelAgents: vi.fn() };
});

const { buildResumeAgentTool } = await import('@mcp/code-agent/tools/resume-agent.js');
const { runParallelAgents } = await import('@mcp/code-agent/tools/implement-subagent.js');
const {
  retainGroup,
  getGroup,
  clearSession,
  resumeLeaseKeepaliveActiveForTests,
} = await import('@mcp/code-agent/tools/subagent-resume-registry.js');

const usage: ChatUsage = { input_tokens: 5, output_tokens: 3 };
const deps = {
  provider: { name: 'stub', model: 'm' },
  parentTools: [],
} as unknown as SubagentDeps;

let emit: ReturnType<typeof vi.fn>;
let ctx: ToolContext;
let SID = 500;

function transcript(): AgentMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'orig task' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'partial' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body' }] },
  ];
}

function retain(reason: StopReason, opts: { attempt?: number; failureNote?: string; index?: number } = {}) {
  const now = 0;
  retainGroup(SID, {
    spawnId: 'g1', sessionId: SID, provider: 'stub', model: 'm', createdAt: now, lastTouchedAt: now,
    agents: [{
      agentIndex: opts.index ?? 0, label: 'auth', task: 'orig task', profileId: 'implement',
      maxTurns: 50, limits: { maxToolCalls: 80 }, transcript: transcript(),
      reason, failureNote: opts.failureNote, toolCallCount: 4, usage,
      attempt: opts.attempt ?? 1, capturedAt: now, approxBytes: 0,
    }],
  });
}

function mockRun(reason: StopReason = 'completed', finalText = 'done now') {
  (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    results: [{
      reason, finalText, usage, sandboxViolations: [], collected: { memos: [], snapshots: [], boardPosts: [] },
      transcript: transcript(), label: 'auth', toolCallCount: 2,
    }],
    totalUsage: usage,
  });
}

function leaseStore(failRenewal: number) {
  let renewals = 0;
  return {
    loadOrchestrationCheckpoint: vi.fn(() => {
      const group = getGroup(SID, 'g1');
      return group ? { payloadJson: JSON.stringify(group) } : null;
    }),
    listOrchestrationCheckpoints: vi.fn(() => []),
    saveOrchestrationCheckpoint: vi.fn(() => true),
    removeOrchestrationCheckpoint: vi.fn(),
    tryAcquireOrchestrationCheckpoint: vi.fn(() => 'lease:test'),
    releaseOrchestrationCheckpoint: vi.fn(),
    renewOrchestrationCheckpoint: vi.fn(() => {
      renewals += 1;
      return renewals !== failRenewal;
    }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  SID += 10;
  emit = vi.fn();
  ctx = { cwd: '/tmp', runner: { sessionId: SID, agentLoopV2: false, emit } } as unknown as ToolContext;
  (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mockReset?.();
  clearSession(SID);
});

describe('resume_agent', () => {
  it('errors on an unknown spawn id', async () => {
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'nope' }, ctx);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('not found');
  });

  it('seeds the resumed child with the transcript + a continuation nudge', async () => {
    retain('tool_budget');
    mockRun('completed');
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'g1', guidance: 'use pnpm test' }, ctx);
    expect(r.isError).toBeFalsy();
    const specs = (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const seed = specs[0].initialMessages as AgentMessage[];
    // transcript preserved, nudge appended last as a user message.
    expect(seed.length).toBeGreaterThan(3);
    const last = seed[seed.length - 1];
    expect(last.role).toBe('user');
    const text = (last.content[0] as { text: string }).text;
    expect(text).toContain('[RESUME — attempt 2]');
    expect(text).toContain('use pnpm test');
    expect(text).toContain('full tool-call budget');
  });

  it('describes explicit time and turn cutoffs as operational interruptions', async () => {
    const t = buildResumeAgentTool(deps);

    retain('time_budget');
    mockRun('completed');
    await t.handler({ spawn_id: 'g1' }, ctx);
    let specs = (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    let seed = specs[0].initialMessages as AgentMessage[];
    expect((seed.at(-1)!.content[0] as { text: string }).text).toContain('time/stall watchdog');

    clearSession(SID);
    (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mockClear();
    retain('max_turns');
    mockRun('completed');
    await t.handler({ spawn_id: 'g1' }, ctx);
    specs = (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    seed = specs[0].initialMessages as AgentMessage[];
    expect((seed.at(-1)!.content[0] as { text: string }).text).toContain('explicit turn ceiling');
  });

  it('re-emits the SAME groupId and bumps attempt', async () => {
    retain('error', { failureNote: 'boom' });
    mockRun('completed');
    const t = buildResumeAgentTool(deps);
    await t.handler({ spawn_id: 'g1' }, ctx);
    const startCall = emit.mock.calls.find((c) => c[0] === 'agents_group_start');
    expect(startCall?.[1].groupId).toBe('g1');
    expect(startCall?.[1].resumed).toBe(true);
    expect(startCall?.[1].agents[0].attempt).toBe(2);
  });

  it('updates the registry attempt after a resume', async () => {
    retain('error', { failureNote: 'boom' });
    mockRun('error', 'still broken');
    const t = buildResumeAgentTool(deps);
    const result = await t.handler({ spawn_id: 'g1' }, ctx);
    expect(result.isError).toBe(true);
    expect(getGroup(SID, 'g1')!.agents[0].attempt).toBe(2);
  });

  it('returns a structured partial error when a resumed agent hits another operational cutoff', async () => {
    retain('tool_budget');
    mockRun('tool_budget', 'useful partial work');
    const t = buildResumeAgentTool(deps);

    const result = await t.handler({ spawn_id: 'g1' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({
      code: 'RESUME_AGENT_PARTIAL',
      kind: 'tool_error',
      retryable: true,
    });
    expect(result.structuredData).toMatchObject({
      kind: 'resume_agent_result',
      status: 'partial',
      spawnId: 'g1',
      relaunchedCount: 1,
      completedCount: 0,
      partialCount: 1,
      failedCount: 0,
      stillFailed: 1,
    });
    expect(result.subUsage).toEqual(usage);
    expect(String(result.content)).toContain('[resume group=g1: 1 agent(s) relaunched]');
  });

  it('records a hard re-failure as an error and a later identical resume as success', async () => {
    retain('error', { failureNote: 'boom' });
    const t = buildResumeAgentTool(deps);
    const input = { spawn_id: 'g1' };
    const ledger = new ToolCallLedger();

    mockRun('error', 'still broken');
    const failed = await t.handler(input, ctx);
    const failedEntry = ledger.record({
      name: 'resume_agent',
      args: input,
      content: failed.content,
      isError: failed.isError === true,
      executionClass: 'execute',
    });

    expect(failed.isError).toBe(true);
    expect(failed.error?.code).toBe('RESUME_AGENT_FAILED');
    expect(failed.structuredData).toMatchObject({
      status: 'failed',
      completedCount: 0,
      partialCount: 0,
      failedCount: 1,
      stillFailed: 1,
    });
    expect(failedEntry.outcome).toBe('tool_error');

    mockRun('completed', 'recovered');
    const recovered = await t.handler(input, ctx);
    const recoveredEntry = ledger.record({
      name: 'resume_agent',
      args: input,
      content: recovered.content,
      isError: recovered.isError === true,
      executionClass: 'execute',
    });

    expect(recovered.isError).toBeFalsy();
    expect(recovered.structuredData).toMatchObject({
      status: 'completed',
      completedCount: 1,
      partialCount: 0,
      failedCount: 0,
      stillFailed: 0,
    });
    expect(recoveredEntry.outcome).toBe('success');
    expect(recoveredEntry.logicalOperationId).toBe(failedEntry.logicalOperationId);
  });

  it('skips aborted agents unless explicitly named', async () => {
    retain('aborted');
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'g1' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.error).toMatchObject({
      code: 'RESUME_AGENT_INCOMPLETE',
      retryable: true,
    });
    expect(r.structuredData).toMatchObject({
      status: 'failed',
      relaunchedCount: 0,
      stillFailed: 1,
      remainingCount: 1,
    });
    expect(String(r.content)).toContain('no eligible agents');
    expect(runParallelAgents).not.toHaveBeenCalled();
    // Explicit selection resumes it.
    mockRun('completed');
    const r2 = await t.handler({ spawn_id: 'g1', agents: [1] }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(runParallelAgents).toHaveBeenCalledTimes(1);
  });

  it('stays partial when an eligible child completes but an ineligible sibling remains failed', async () => {
    const now = 0;
    retainGroup(SID, {
      spawnId: 'g1',
      sessionId: SID,
      provider: 'stub',
      model: 'm',
      createdAt: now,
      lastTouchedAt: now,
      agents: [
        {
          agentIndex: 0,
          label: 'retryable',
          task: 'retryable task',
          profileId: 'implement',
          maxTurns: 50,
          limits: { maxToolCalls: 80 },
          transcript: transcript(),
          reason: 'error',
          failureNote: 'boom',
          toolCallCount: 4,
          usage,
          attempt: 1,
          capturedAt: now,
          approxBytes: 0,
        },
        {
          agentIndex: 1,
          label: 'aborted',
          task: 'aborted task',
          profileId: 'implement',
          maxTurns: 50,
          limits: { maxToolCalls: 80 },
          transcript: transcript(),
          reason: 'aborted',
          toolCallCount: 1,
          usage,
          attempt: 1,
          capturedAt: now,
          approxBytes: 0,
        },
      ],
    });
    mockRun('completed', 'retryable child recovered');
    const t = buildResumeAgentTool(deps);

    const result = await t.handler({ spawn_id: 'g1' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({
      code: 'RESUME_AGENT_INCOMPLETE',
      retryable: true,
    });
    expect(result.structuredData).toMatchObject({
      status: 'partial',
      relaunchedCount: 1,
      completedCount: 1,
      stillFailed: 1,
      remainingCount: 1,
      skippedCount: 1,
    });
    expect(result.subUsage).toEqual(usage);
    expect(String(result.content)).toContain('retryable child recovered');
    expect(String(result.content)).toContain('also skipped');
  });

  it('refuses once the attempt cap is reached', async () => {
    retain('error', { attempt: 3, failureNote: 'boom' });
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'g1' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.error).toMatchObject({
      code: 'RESUME_AGENT_EXHAUSTED',
      retryable: false,
    });
    expect(r.structuredData).toMatchObject({
      status: 'failed',
      relaunchedCount: 0,
      stillFailed: 1,
      remainingCount: 1,
    });
    expect(String(r.content)).toContain('attempt cap');
    expect(runParallelAgents).not.toHaveBeenCalled();
  });

  it('never resolves a failed logical operation with a false success after reaching the attempt cap', async () => {
    retain('error', { attempt: 2, failureNote: 'boom' });
    mockRun('error', 'still broken at final attempt');
    const t = buildResumeAgentTool(deps);
    const input = { spawn_id: 'g1' };
    const ledger = new ToolCallLedger();

    const finalAttempt = await t.handler(input, ctx);
    const failedEntry = ledger.record({
      name: 'resume_agent',
      args: input,
      content: String(finalAttempt.content),
      isError: finalAttempt.isError === true,
      executionClass: 'execute',
    });
    const exhausted = await t.handler(input, ctx);
    const exhaustedEntry = ledger.record({
      name: 'resume_agent',
      args: input,
      content: String(exhausted.content),
      isError: exhausted.isError === true,
      executionClass: 'execute',
    });

    expect(finalAttempt.isError).toBe(true);
    expect(finalAttempt.error).toMatchObject({ code: 'RESUME_AGENT_FAILED', retryable: false });
    expect(exhausted.isError).toBe(true);
    expect(exhausted.error).toMatchObject({ code: 'RESUME_AGENT_EXHAUSTED', retryable: false });
    expect(failedEntry.outcome).toBe('tool_error');
    expect(exhaustedEntry.outcome).toBe('tool_error');
    expect(exhaustedEntry.logicalOperationId).toBe(failedEntry.logicalOperationId);
    expect(runParallelAgents).toHaveBeenCalledOnce();
  });

  it('preserves the prior transcript when a re-failure returns none (M1)', async () => {
    retain('error', { failureNote: 'boom' });
    // Relaunch fails again but via the outer-catch path → no transcript.
    (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{
        reason: 'error', finalText: 'still broken', usage, sandboxViolations: [],
        collected: { memos: [], snapshots: [], boardPosts: [] }, transcript: undefined, label: 'auth', toolCallCount: 0,
      }],
      totalUsage: usage,
    });
    const t = buildResumeAgentTool(deps);
    await t.handler({ spawn_id: 'g1' }, ctx);
    const st = getGroup(SID, 'g1')!.agents[0];
    expect(st.attempt).toBe(2);
    expect(st.transcript).toBeDefined(); // NOT cannibalized → still resumable
  });

  it('numbers a resumed agent by its ORIGINAL roster index (L4)', async () => {
    // Agent at original index 1 failed; resume it alone.
    retain('error', { failureNote: 'boom', index: 1 });
    mockRun('completed');
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'g1', agents: [2] }, ctx); // 1-based → index 1
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain('### Agent 2:'); // original index+1, not "### Agent 1"
  });

  it('caps quality failures at 2 attempts', async () => {
    retain('error', { attempt: 2, failureNote: 'subagent_quality_watchdog: 3 turns no tool' });
    const t = buildResumeAgentTool(deps);
    // quality is explicit-only AND capped at 2 → attempt 2 refused.
    const r = await t.handler({ spawn_id: 'g1', agents: [1] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.error).toMatchObject({
      code: 'RESUME_AGENT_EXHAUSTED',
      retryable: false,
    });
    expect(String(r.content)).toContain('attempt cap 2');
  });

  it('emits no resume start/spawn when the lease is fenced immediately before that boundary', async () => {
    retain('error', { failureNote: 'boom' });
    mockRun('completed');
    const store = leaseStore(2);
    const t = buildResumeAgentTool({ ...deps, sessionStore: store as never });

    await expect(t.handler({ spawn_id: 'g1' }, ctx)).rejects.toThrow(/fenced|expired/);
    expect(runParallelAgents).not.toHaveBeenCalled();
    expect(emit.mock.calls.map((call) => call[0])).not.toContain('agents_group_start');
  });

  it('withholds the resume terminal event and tool ACK when the final lease assertion is fenced', async () => {
    retain('error', { failureNote: 'boom' });
    mockRun('completed');
    const store = leaseStore(6);
    const t = buildResumeAgentTool({ ...deps, sessionStore: store as never });

    await expect(t.handler({ spawn_id: 'g1' }, ctx)).rejects.toThrow(/fenced|expired/);
    expect(runParallelAgents).toHaveBeenCalledOnce();
    expect(emit.mock.calls.map((call) => call[0])).toContain('agents_group_start');
    expect(emit.mock.calls.map((call) => call[0])).not.toContain('agents_group_end');
    expect(resumeLeaseKeepaliveActiveForTests(SID, 'g1')).toBe(false);
  });

  it('reloads the winner roster after acquire instead of resuming a stale snapshot', async () => {
    retain('error', { failureNote: 'stale failure' });
    const stale = getGroup(SID, 'g1')!;
    const winner = JSON.parse(JSON.stringify(stale));
    winner.agents[0].reason = 'completed';
    winner.agents[0].failureNote = undefined;
    winner.agents[0].transcript = undefined;
    winner.agents[0].attempt = 2;
    let payloadJson = JSON.stringify(stale);
    const store = {
      loadOrchestrationCheckpoint: vi.fn(() => ({ payloadJson })),
      listOrchestrationCheckpoints: vi.fn(() => []),
      saveOrchestrationCheckpoint: vi.fn(() => true),
      removeOrchestrationCheckpoint: vi.fn(),
      tryAcquireOrchestrationCheckpoint: vi.fn(() => {
        // A different executor commits and releases after our cache read but
        // immediately before this executor wins the CAS.
        payloadJson = JSON.stringify(winner);
        return 'lease:after-winner';
      }),
      releaseOrchestrationCheckpoint: vi.fn(),
      renewOrchestrationCheckpoint: vi.fn(() => true),
    };
    const tool = buildResumeAgentTool({ ...deps, sessionStore: store as never });

    const result = await tool.handler({ spawn_id: 'g1' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(String(result.content)).toContain('nothing to resume');
    expect(runParallelAgents).not.toHaveBeenCalled();
    expect(getGroup(SID, 'g1')?.agents[0].reason).toBe('completed');
  });

  it('keeps the pre-migration in-memory resume path, but refuses it in enforce mode', async () => {
    const compat = {
      loadOrchestrationCheckpoint: vi.fn(() => null),
      listOrchestrationCheckpoints: vi.fn(() => []),
      saveOrchestrationCheckpoint: vi.fn(() => false),
      removeOrchestrationCheckpoint: vi.fn(),
      tryAcquireOrchestrationCheckpoint: vi.fn(() => 'compat:test'),
      releaseOrchestrationCheckpoint: vi.fn(),
      renewOrchestrationCheckpoint: vi.fn(() => true),
    };
    retain('error', { failureNote: 'compat' });
    mockRun('completed');
    const tool = buildResumeAgentTool({ ...deps, sessionStore: compat as never });
    const defaultResult = await tool.handler({ spawn_id: 'g1' }, ctx);
    expect(defaultResult.isError).toBeFalsy();
    expect(runParallelAgents).toHaveBeenCalledOnce();

    clearSession(SID);
    (runParallelAgents as unknown as ReturnType<typeof vi.fn>).mockClear();
    retain('error', { failureNote: 'enforce' });
    vi.stubEnv('CODER_AGENT_RUN_STORE_ENFORCE', '1');
    await expect(tool.handler({ spawn_id: 'g1' }, ctx)).rejects.toThrow(/migration 259/);
    expect(runParallelAgents).not.toHaveBeenCalled();
  });
});
