/**
 * subagent-resume-registry — session-scoped retention for resume_agent.
 * Locks in: transcript kept only for failures, sanitization at retain,
 * front-eliding byte cap (tail protected), LRU group cap, TTL expiry, the
 * per-spawn resume lock, and clearSession.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import {
  retainGroup,
  getGroup,
  replaceAgentState,
  listResumable,
  clearSession,
  tryAcquireResume,
  releaseResume,
  type ResumableGroup,
  type ResumableAgentState,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';

const usage: ChatUsage = { input_tokens: 10, output_tokens: 5 };

function transcript(): AgentMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'task' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
    },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
  ];
}

function agent(index: number, reason: StopReason, overrides: Partial<ResumableAgentState> = {}): ResumableAgentState {
  return {
    agentIndex: index,
    label: `a${index}`,
    task: 'do it',
    profileId: 'implement',
    maxTurns: 50,
    limits: { maxToolCalls: 80 },
    transcript: transcript(),
    reason,
    toolCallCount: 1,
    usage,
    attempt: 1,
    capturedAt: 0,
    approxBytes: 0,
    ...overrides,
  };
}

function group(sessionId: number, spawnId: string, agents: ResumableAgentState[]): ResumableGroup {
  return { spawnId, sessionId, provider: 'openai', model: 'gpt', createdAt: 0, lastTouchedAt: 0, agents };
}

let SID = 0;
beforeEach(() => { SID += 100; });
afterEach(() => { for (let s = SID - 100; s <= SID + 20; s++) clearSession(s); vi.useRealTimers(); });

describe('subagent-resume-registry', () => {
  it('keeps transcripts for failed agents and drops them for completed ones', () => {
    retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'completed')]));
    const g = getGroup(SID, 'g1')!;
    expect(g.agents[0].transcript).toBeDefined();
    expect(g.agents[1].transcript).toBeUndefined();
  });

  it('records a failureNote from the finalText/detail for failed agents', () => {
    retainGroup(SID, group(SID, 'g1', [agent(0, 'tool_budget', { failureNote: 'hit cap' })]));
    expect(getGroup(SID, 'g1')!.agents[0].failureNote).toBe('hit cap');
  });

  it('sanitizes a dangling tool_use in the captured transcript', () => {
    const dangling: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'run_command', input: {} }] },
    ];
    retainGroup(SID, group(SID, 'g1', [agent(0, 'error', { transcript: dangling })]));
    const t = getGroup(SID, 'g1')!.agents[0].transcript!;
    const last = t[t.length - 1];
    expect(last.role).toBe('tool');
    expect((last.content[0] as { is_error?: boolean }).is_error).toBe(true);
  });

  it('front-elides large tool_results but protects the tail under the byte cap', () => {
    const big = 'x'.repeat(5000);
    const long: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    // 30 tool turns each with a big result. Cap chosen so the FRONT pass alone
    // gets under it → the protected tail (last 20 msgs) stays intact.
    for (let i = 0; i < 30; i++) {
      long.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] });
      long.push({ role: 'tool', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] });
    }
    // ~150KB total; front-editable ≈ 20 results × 5KB ≈ 100KB → under 60KB.
    const prev = process.env.CODER_RESUME_MAX_AGENT_BYTES;
    process.env.CODER_RESUME_MAX_AGENT_BYTES = '60000';
    try {
      retainGroup(SID, group(SID, 'g1', [agent(0, 'error', { transcript: long })]));
    } finally {
      if (prev == null) delete process.env.CODER_RESUME_MAX_AGENT_BYTES;
      else process.env.CODER_RESUME_MAX_AGENT_BYTES = prev;
    }
    const t = getGroup(SID, 'g1')!.agents[0].transcript!;
    const findResult = (m: AgentMessage) => m.content.find((b) => b.type === 'tool_result') as { content: string } | undefined;
    // The very last tool_result (tail) is untouched.
    const lastTool = [...t].reverse().find((m) => m.role === 'tool')!;
    expect(findResult(lastTool)!.content).toBe(big);
    // Some early tool_result was elided.
    const early = t.slice(0, 6).map(findResult).filter(Boolean) as Array<{ content: string }>;
    expect(early.some((r) => r.content.includes('elided'))).toBe(true);
  });

  it('enforces the byte cap even for a short (<=20 msg) transcript with a giant result (M2)', () => {
    const giant = 'y'.repeat(200_000);
    const short: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: giant }] },
    ];
    const prev = process.env.CODER_RESUME_MAX_AGENT_BYTES;
    process.env.CODER_RESUME_MAX_AGENT_BYTES = '10000';
    try {
      retainGroup(SID, group(SID, 'g1', [agent(0, 'error', { transcript: short })]));
    } finally {
      if (prev == null) delete process.env.CODER_RESUME_MAX_AGENT_BYTES; else process.env.CODER_RESUME_MAX_AGENT_BYTES = prev;
    }
    const t = getGroup(SID, 'g1')!.agents[0].transcript!;
    const res = t.find((m) => m.role === 'tool')!.content.find((b) => b.type === 'tool_result') as { content: string };
    // The giant result was elided despite the transcript being only 3 messages.
    expect(res.content).toContain('elided');
    // Pairing preserved (tool_use_id kept) and message count unchanged.
    expect(t).toHaveLength(3);
  });

  it('evicts the LRU group beyond the 8-group cap', () => {
    for (let i = 0; i < 10; i++) retainGroup(SID, group(SID, `g${i}`, [agent(0, 'error')]));
    expect(getGroup(SID, 'g0')).toBeUndefined();
    expect(getGroup(SID, 'g9')).toBeDefined();
  });

  it('expires groups past the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    retainGroup(SID, group(SID, 'g1', [agent(0, 'error')]));
    expect(getGroup(SID, 'g1')).toBeDefined();
    vi.setSystemTime(46 * 60_000);
    expect(getGroup(SID, 'g1')).toBeUndefined();
  });

  it('listResumable only lists agents with a transcript', () => {
    retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'completed')]));
    const list = listResumable(SID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ spawnId: 'g1', agentIndex: 0 });
  });

  it('replaceAgentState swaps a single agent in place', () => {
    retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'error')]));
    replaceAgentState(SID, 'g1', agent(0, 'completed', { attempt: 2 }));
    const g = getGroup(SID, 'g1')!;
    expect(g.agents[0].attempt).toBe(2);
    expect(g.agents[0].transcript).toBeUndefined(); // completed → dropped
    expect(g.agents[1].reason).toBe('error');
  });

  it('the per-spawn resume lock is exclusive until released', () => {
    expect(tryAcquireResume(SID, 'g1')).toBe(true);
    expect(tryAcquireResume(SID, 'g1')).toBe(false);
    releaseResume(SID, 'g1');
    expect(tryAcquireResume(SID, 'g1')).toBe(true);
    releaseResume(SID, 'g1');
  });

  it('clearSession removes all groups', () => {
    retainGroup(SID, group(SID, 'g1', [agent(0, 'error')]));
    clearSession(SID);
    expect(getGroup(SID, 'g1')).toBeUndefined();
  });
});
