/**
 * subagent-resume-registry — session-scoped retention for resume_agent.
 * Locks in: transcript kept only for failures, sanitization at retain,
 * front-eliding byte cap (tail protected), LRU group cap, TTL expiry, the
 * per-spawn resume lock, and clearSession.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import { newSessionId, type SessionId } from '@mcp/session-storage';
import {
  retainGroup,
  getGroup,
  replaceAgentState,
  listResumable,
  clearSession,
  tryAcquireResume,
  releaseResume,
  stopResumeSweepForTests,
  configureResumeRegistryForTests,
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

function group(sessionId: SessionId, spawnId: string, agents: ResumableAgentState[]): ResumableGroup {
  return { spawnId, sessionId, provider: 'openai', model: 'gpt', createdAt: 0, lastTouchedAt: 0, agents };
}

let SID: SessionId;
// This suite isolates the registry's in-RAM mechanics (sanitize, byte-cap, LRU,
// TTL). The disk-spill layer (default ON) is exercised in
// subagent-resume-retention.test.ts, so keep it OFF here to assert in-memory
// transcripts directly.
beforeEach(() => {
  SID = newSessionId();
  configureResumeRegistryForTests({ spillTerminalTranscripts: false });
});
afterEach(async () => {
  await clearSession(SID);
  configureResumeRegistryForTests(null);
  stopResumeSweepForTests();
  vi.useRealTimers();
});

describe('subagent-resume-registry', () => {
  it('keeps transcripts for failed AND completed agents by default (P1 observability)', async () => {
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'completed')]));
    const g = (await getGroup(SID, 'g1'))!;
    expect(g.agents[0].transcript).toBeDefined();
    expect(g.agents[1].transcript).toBeDefined();
  });

  it('supports the explicit failed-only retention projection', async () => {
    configureResumeRegistryForTests({
      spillTerminalTranscripts: false,
      retainCompletedTranscripts: false,
    });
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'completed')]));
    const g = (await getGroup(SID, 'g1'))!;
    expect(g.agents[0].transcript).toBeDefined();
    expect(g.agents[1].transcript).toBeUndefined();
  });

  it('records a failureNote from the finalText/detail for failed agents', async () => {
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'tool_budget', { failureNote: 'hit cap' })]));
    expect((await getGroup(SID, 'g1'))!.agents[0].failureNote).toBe('hit cap');
  });

  it('sanitizes a dangling tool_use in the captured transcript', async () => {
    const dangling: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'run_command', input: {} }] },
    ];
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error', { transcript: dangling })]));
    const t = (await getGroup(SID, 'g1'))!.agents[0].transcript!;
    const last = t[t.length - 1];
    expect(last.role).toBe('tool');
    expect((last.content[0] as { is_error?: boolean }).is_error).toBe(true);
  });

  it('front-elides large tool_results but protects the tail under the byte cap', async () => {
    const big = 'x'.repeat(5000);
    const long: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
    // 30 tool turns each with a big result. Cap chosen so the FRONT pass alone
    // gets under it → the protected tail (last 20 msgs) stays intact.
    for (let i = 0; i < 30; i++) {
      long.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] });
      long.push({ role: 'tool', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] });
    }
    // ~150KB total; front-editable ≈ 20 results × 5KB ≈ 100KB → under 60KB.
    configureResumeRegistryForTests({ spillTerminalTranscripts: false, maxAgentBytes: 60_000 });
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error', { transcript: long })]));
    const t = (await getGroup(SID, 'g1'))!.agents[0].transcript!;
    const findResult = (m: AgentMessage) => m.content.find((b) => b.type === 'tool_result') as { content: string } | undefined;
    // The very last tool_result (tail) is untouched.
    const lastTool = [...t].reverse().find((m) => m.role === 'tool')!;
    expect(findResult(lastTool)!.content).toBe(big);
    // Some early tool_result was elided.
    const early = t.slice(0, 6).map(findResult).filter(Boolean) as Array<{ content: string }>;
    expect(early.some((r) => r.content.includes('elided'))).toBe(true);
  });

  it('enforces the byte cap even for a short (<=20 msg) transcript with a giant result (M2)', async () => {
    const giant = 'y'.repeat(200_000);
    const short: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: giant }] },
    ];
    configureResumeRegistryForTests({ spillTerminalTranscripts: false, maxAgentBytes: 10_000 });
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error', { transcript: short })]));
    const t = (await getGroup(SID, 'g1'))!.agents[0].transcript!;
    const res = t.find((m) => m.role === 'tool')!.content.find((b) => b.type === 'tool_result') as { content: string };
    // The giant result was elided despite the transcript being only 3 messages.
    expect(res.content).toContain('elided');
    // Pairing preserved (tool_use_id kept) and message count unchanged.
    expect(t).toHaveLength(3);
  });

  it('evicts the LRU group beyond the 8-group cap', async () => {
    for (let i = 0; i < 10; i++) {
      await retainGroup(SID, group(SID, `g${i}`, [agent(0, 'error')]));
    }
    expect(await getGroup(SID, 'g0')).toBeUndefined();
    expect(await getGroup(SID, 'g9')).toBeDefined();
  });

  it('expires groups past the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error')]));
    expect(await getGroup(SID, 'g1')).toBeDefined();
    vi.setSystemTime(46 * 60_000);
    expect(await getGroup(SID, 'g1')).toBeUndefined();
  });

  it('listResumable only lists agents with a transcript', async () => {
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'completed')]));
    const list = listResumable(SID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ spawnId: 'g1', agentIndex: 0 });
  });

  it('replaceAgentState swaps a single agent in place', async () => {
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error'), agent(1, 'error')]));
    await replaceAgentState(SID, 'g1', agent(0, 'completed', { attempt: 2 }));
    const g = (await getGroup(SID, 'g1'))!;
    expect(g.agents[0].attempt).toBe(2);
    // Completed resumes keep their transcript now (readable, never resumable).
    expect(g.agents[0].transcript).toBeDefined();
    expect(g.agents[1].reason).toBe('error');
  });

  it('the per-spawn resume lock is exclusive until released', async () => {
    expect(await tryAcquireResume(SID, 'g1')).toBe(true);
    expect(await tryAcquireResume(SID, 'g1')).toBe(false);
    await releaseResume(SID, 'g1');
    expect(await tryAcquireResume(SID, 'g1')).toBe(true);
    await releaseResume(SID, 'g1');
  });

  it('clearSession removes all groups', async () => {
    await retainGroup(SID, group(SID, 'g1', [agent(0, 'error')]));
    await clearSession(SID);
    expect(await getGroup(SID, 'g1')).toBeUndefined();
  });
});
