import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import {
  clearSession,
  getGroup,
  listReadableGroups,
  listResumable,
  retainCompletedTranscripts,
  retainGroup,
  type ResumableAgentState,
  type ResumableGroup,
} from '../subagent-resume-registry.js';
import { retainSpawnGroup } from '../spawn-agent-resume.js';
import { findRetainedAgent, renderAgentTranscript } from '../read-agent-transcript.js';

let nextSession = 910_000;

function transcript(): AgentMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'investigate the auth flow' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the entrypoint first.' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/auth.ts' } },
      ],
    },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function login() {}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done — login() lives in src/auth.ts.' }] },
  ] as AgentMessage[];
}

function agentState(index: number, reason: ResumableAgentState['reason']): ResumableAgentState {
  return {
    agentIndex: index,
    label: `agent-${index + 1}`,
    task: 'investigate the auth flow',
    profileId: 'explore',
    maxTurns: 0,
    limits: { maxToolCalls: 80, timeoutMs: 840_000, stallMs: 90_000 },
    transcript: transcript(),
    reason,
    toolCallCount: 1,
    usage: { input_tokens: 100, output_tokens: 50 },
    attempt: 1,
    capturedAt: Date.now(),
    approxBytes: 0,
    finalText: 'Done — login() lives in src/auth.ts.',
  };
}

function group(sessionId: number, reasons: ResumableAgentState['reason'][]): ResumableGroup {
  return {
    spawnId: `grp-${sessionId}`,
    sessionId,
    provider: 'zai',
    model: 'glm-4.7',
    createdAt: Date.now(),
    lastTouchedAt: Date.now(),
    agents: reasons.map((reason, i) => agentState(i, reason)),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('completed-transcript retention (P1)', () => {
  it('retains completed transcripts by DEFAULT so they are readable', () => {
    vi.stubEnv('CODER_RESUME_RETAIN_COMPLETED', '');
    expect(retainCompletedTranscripts()).toBe(true);
    const sid = ++nextSession;
    retainGroup(sid, group(sid, ['completed', 'error']));
    const stored = getGroup(sid, `grp-${sid}`);
    expect(stored?.agents[0].transcript?.length).toBeGreaterThan(0);
    expect(stored?.agents[1].transcript?.length).toBeGreaterThan(0);
    clearSession(sid);
  });

  it('drops completed transcripts when the kill switch is 0 (old economy)', () => {
    vi.stubEnv('CODER_RESUME_RETAIN_COMPLETED', '0');
    const sid = ++nextSession;
    retainGroup(sid, group(sid, ['completed', 'error']));
    const stored = getGroup(sid, `grp-${sid}`);
    expect(stored?.agents[0].transcript).toBeUndefined();
    expect(stored?.agents[1].transcript?.length).toBeGreaterThan(0);
    clearSession(sid);
  });

  it('never lists completed agents as RESUMABLE even with a transcript', () => {
    vi.stubEnv('CODER_RESUME_RETAIN_COMPLETED', '');
    const sid = ++nextSession;
    retainGroup(sid, group(sid, ['completed', 'tool_budget']));
    const resumable = listResumable(sid);
    expect(resumable).toHaveLength(1);
    expect(resumable[0].reason).toBe('tool_budget');
    const readable = listReadableGroups(sid);
    expect(readable[0].agents.filter((a) => a.hasTranscript)).toHaveLength(2);
    clearSession(sid);
  });

  it('retainSpawnGroup keeps ALL-COMPLETED groups now (observability)', () => {
    vi.stubEnv('CODER_RESUME_RETAIN_COMPLETED', '');
    const sid = ++nextSession;
    const resumableCount = retainSpawnGroup({
      sessionId: sid,
      spawnId: 'spawn-ok',
      provider: 'zai',
      model: 'glm-4.7',
      agents: [{
        index: 0,
        label: 'explore-1',
        task: 'look around',
        profileId: 'explore',
        maxTurns: 0,
        limits: { maxToolCalls: 80, timeoutMs: 840_000, stallMs: 90_000 },
        reason: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
        toolCallCount: 2,
        transcript: transcript(),
        finalText: 'all good',
      }],
    });
    expect(resumableCount).toBe(0);
    expect(getGroup(sid, 'spawn-ok')?.agents[0].transcript?.length).toBeGreaterThan(0);
    clearSession(sid);
  });
});

describe('read_agent_transcript rendering', () => {
  it('renders header, tool calls with inputs, results and final text', () => {
    vi.stubEnv('CODER_RESUME_RETAIN_COMPLETED', '');
    const sid = ++nextSession;
    retainGroup(sid, group(sid, ['completed']));
    const agent = findRetainedAgent(sid, `grp-${sid}`, 1);
    expect(agent).toBeDefined();
    const text = renderAgentTranscript(agent!);
    expect(text).toContain('"agent-1"');
    expect(text).toContain('profile=explore');
    expect(text).toContain('→ read_file');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('← read_file');
    expect(text).toContain('[final] Done — login() lives in src/auth.ts.');
    clearSession(sid);
  });

  it('resolves agents by label and elides the middle under a tight budget', () => {
    vi.stubEnv('CODER_RESUME_RETAIN_COMPLETED', '');
    const sid = ++nextSession;
    const g = group(sid, ['completed']);
    // Inflate the transcript so the digest budget must elide.
    for (let i = 0; i < 200; i++) {
      g.agents[0].transcript!.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `x${i}`, name: 'grep_code', input: { pattern: `p${i}` } }],
      } as AgentMessage);
    }
    retainGroup(sid, g);
    const agent = findRetainedAgent(sid, `grp-${sid}`, 'agent-1');
    const text = renderAgentTranscript(agent!, { maxChars: 2_500 });
    expect(text.length).toBeLessThanOrEqual(3_200);
    expect(text).toContain('earlier event(s) elided');
    clearSession(sid);
  });
});
