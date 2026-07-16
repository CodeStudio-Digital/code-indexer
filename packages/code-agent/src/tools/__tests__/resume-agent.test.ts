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

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runParallelAgents: vi.fn() };
});

const { buildResumeAgentTool } = await import('@mcp/code-agent/tools/resume-agent.js');
const { runParallelAgents } = await import('@mcp/code-agent/tools/implement-subagent.js');
const { retainGroup, getGroup, clearSession } = await import('@mcp/code-agent/tools/subagent-resume-registry.js');

const usage: ChatUsage = { input_tokens: 5, output_tokens: 3 };
const deps = { provider: { name: 'stub', model: 'm' }, parentTools: [] } as never;

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

beforeEach(() => {
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
    await t.handler({ spawn_id: 'g1' }, ctx);
    expect(getGroup(SID, 'g1')!.agents[0].attempt).toBe(2);
  });

  it('skips aborted agents unless explicitly named', async () => {
    retain('aborted');
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'g1' }, ctx);
    expect(String(r.content)).toContain('no eligible agents');
    expect(runParallelAgents).not.toHaveBeenCalled();
    // Explicit selection resumes it.
    mockRun('completed');
    const r2 = await t.handler({ spawn_id: 'g1', agents: [1] }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(runParallelAgents).toHaveBeenCalledTimes(1);
  });

  it('refuses once the attempt cap is reached', async () => {
    retain('error', { attempt: 3, failureNote: 'boom' });
    const t = buildResumeAgentTool(deps);
    const r = await t.handler({ spawn_id: 'g1' }, ctx);
    expect(String(r.content)).toContain('attempt cap');
    expect(runParallelAgents).not.toHaveBeenCalled();
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
    expect(String(r.content)).toContain('attempt cap 2');
  });
});
