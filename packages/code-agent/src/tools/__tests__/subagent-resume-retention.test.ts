import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeCheckpointValue } from '../orchestration-checkpoint-redaction.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { FsSessionStore } from '../../sessions/fs-store/fs-session-store.js';
import type { SessionId } from '@mcp/session-storage';
import {
  clearSession,
  configureResumeRegistryForTests,
  getGroup,
  listReadableGroups,
  listResumable,
  peekSessionGroupCountForTests,
  retainCompletedTranscripts,
  retainGroup,
  reloadGroupUnderLease,
  tryAcquireResume,
  releaseResume,
  stopResumeSweepForTests,
  type ResumableAgentState,
  type ResumableGroup,
} from '../subagent-resume-registry.js';
import { retainSpawnGroup } from '../spawn-agent-resume.js';
import {
  buildReadAgentTranscriptTool,
  findRetainedAgent,
  renderAgentTranscript,
} from '../read-agent-transcript.js';

let temporaryRoot: string;
let projectRoot: string;
let dataDir: string;
let sid: SessionId;
let store: FsSessionStore;

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

function group(sessionId: SessionId, reasons: ResumableAgentState['reason'][]): ResumableGroup {
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

beforeEach(async () => {
  configureResumeRegistryForTests(null);
  temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bundle-spill-'));
  projectRoot = join(temporaryRoot, 'project');
  dataDir = join(temporaryRoot, 'data');
  mkdirSync(projectRoot);
  mkdirSync(dataDir);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 910 ? projectRoot : null,
      listProjectRoots: () => [
        { project_id: 910, root_path: projectRoot },
      ],
    },
  });
  sid = (
    await store.createSession({
      project_id: 910,
      title: 'subagent transcript',
      provider: 'fake',
      model: 'fake',
    })
  ).id;
});

afterEach(async () => {
  await clearSession(sid);
  await store.close();
  configureResumeRegistryForTests(null);
  stopResumeSweepForTests();
  vi.useRealTimers();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('completed-transcript retention (P1)', () => {
  it('spills completed transcripts into the bundle by default and keeps them readable', async () => {
    expect(retainCompletedTranscripts()).toBe(true);
    await retainGroup(
      sid,
      group(sid, ['completed', 'error']),
      store,
    );
    const stored = await getGroup(sid, `grp-${sid}`, store);
    // Completed → spilled to disk: no in-RAM transcript, pointer kept, 0 bytes.
    expect(stored?.agents[0].transcript).toBeUndefined();
    expect(stored?.agents[0].spillPath).toBeTruthy();
    expect(stored?.agents[0].approxBytes).toBe(0);
    expect(existsSync(stored!.agents[0].spillPath!)).toBe(true);
    // Resumable (error) → stays in RAM so resume_agent can relaunch it.
    expect(stored?.agents[1].transcript?.length).toBeGreaterThan(0);
    expect(stored?.agents[1].spillPath).toBeUndefined();
    // Spilled transcripts still count as readable via their pointer.
    expect((await listReadableGroups(sid, store))[0].agents[0].hasTranscript).toBe(true);
  });

  it('drops completed transcripts when the kill switch is 0 (old economy)', async () => {
    configureResumeRegistryForTests({ retainCompletedTranscripts: false });
    await retainGroup(
      sid,
      group(sid, ['completed', 'error']),
      store,
    );
    const stored = await getGroup(sid, `grp-${sid}`, store);
    expect(stored?.agents[0].transcript).toBeUndefined();
    expect(stored?.agents[1].transcript?.length).toBeGreaterThan(0);
  });

  it('never lists completed agents as RESUMABLE even with a transcript', async () => {
    await retainGroup(
      sid,
      group(sid, ['completed', 'tool_budget']),
      store,
    );
    const resumable = listResumable(sid);
    expect(resumable).toHaveLength(1);
    expect(resumable[0].reason).toBe('tool_budget');
    const readable = await listReadableGroups(sid, store);
    expect(readable[0].agents.filter((a) => a.hasTranscript)).toHaveLength(2);
  });

  it('retainSpawnGroup keeps ALL-COMPLETED groups now (observability)', async () => {
    const resumableCount = await retainSpawnGroup({
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
      store,
    });
    expect(resumableCount).toBe(0);
    const stored = await getGroup(sid, 'spawn-ok', store);
    // The all-completed roster is retained, but its transcript lives on disk.
    expect(stored?.agents[0].transcript).toBeUndefined();
    expect(stored?.agents[0].spillPath).toBeTruthy();
    expect((await listReadableGroups(sid, store))[0].agents[0].hasTranscript).toBe(true);
  });
});

describe('read_agent_transcript rendering', () => {
  it('renders header, tool calls with inputs, results and final text', async () => {
    configureResumeRegistryForTests({ spillTerminalTranscripts: false });
    await retainGroup(sid, group(sid, ['completed']), store);
    const agent = await findRetainedAgent(
      sid,
      `grp-${sid}`,
      1,
      store,
    );
    expect(agent).toBeDefined();
    const text = renderAgentTranscript(agent!);
    expect(text).toContain('"agent-1"');
    expect(text).toContain('profile=explore');
    expect(text).toContain('→ read_file');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('← read_file');
    expect(text).toContain('[final] Done — login() lives in src/auth.ts.');
  });

  it('resolves agents by label and elides the middle under a tight budget', async () => {
    configureResumeRegistryForTests({ spillTerminalTranscripts: false });
    const g = group(sid, ['completed']);
    // Inflate the transcript so the digest budget must elide.
    for (let i = 0; i < 200; i++) {
      g.agents[0].transcript!.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `x${i}`, name: 'grep_code', input: { pattern: `p${i}` } }],
      } as AgentMessage);
    }
    await retainGroup(sid, g, store);
    const agent = await findRetainedAgent(
      sid,
      `grp-${sid}`,
      'agent-1',
      store,
    );
    const text = renderAgentTranscript(agent!, { maxChars: 2_500 });
    expect(text.length).toBeLessThanOrEqual(3_200);
    expect(text).toContain('earlier event(s) elided');
  });

  it('accepts zero as an unambiguous alias for the first agent', async () => {
    configureResumeRegistryForTests({ spillTerminalTranscripts: false });
    await retainGroup(
      sid,
      group(sid, ['completed', 'completed']),
      store,
    );

    const result = await buildReadAgentTranscriptTool(store).handler(
      { spawn_id: `grp-${sid}`, agent: 0, max_chars: 24_000 },
      { cwd: '/tmp', runner: { sessionId: sid } } as unknown as ToolContext,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('[transcript agent=#1 "agent-1"');

    expect(
      (await findRetainedAgent(sid, `grp-${sid}`, 0, store))?.label,
    ).toBe('agent-1');
    expect(
      (await findRetainedAgent(sid, `grp-${sid}`, '0', store))?.label,
    ).toBe('agent-1');
    expect(
      (await findRetainedAgent(sid, `grp-${sid}`, 1, store))?.label,
    ).toBe('agent-1');
    expect(
      (await findRetainedAgent(sid, `grp-${sid}`, 2, store))?.label,
    ).toBe('agent-2');
  });
});

describe('terminal-transcript spill to disk (part b)', () => {
  it('read_agent_transcript renders the full body back from the spill file', async () => {
    await retainGroup(sid, group(sid, ['completed']), store);
    const stored = await getGroup(sid, `grp-${sid}`, store);
    expect(stored?.agents[0].transcript).toBeUndefined(); // dropped from RAM
    expect(stored?.agents[0].spillPath).toBeTruthy();      // only the pointer stays

    const result = await buildReadAgentTranscriptTool(store).handler(
      { spawn_id: `grp-${sid}`, agent: 1 },
      { cwd: '/tmp', runner: { sessionId: sid } } as unknown as ToolContext,
    );
    expect(result.isError).not.toBe(true);
    // Tool-call bodies came back from disk — not just the in-RAM metadata header.
    expect(result.content).toContain('→ read_file');
    expect(result.content).toContain('src/auth.ts');
    expect(result.content).toContain('← read_file');
  });

  it('keeps FAILED/ABORTED transcripts in RAM so resume_agent stays intact', async () => {
    await retainGroup(
      sid,
      group(sid, ['error', 'aborted']),
      store,
    );
    const stored = await getGroup(sid, `grp-${sid}`, store);
    for (const a of stored!.agents) {
      expect(a.transcript?.length).toBeGreaterThan(0); // resumable → resident
      expect(a.spillPath).toBeUndefined();             // nothing spilled
    }
    expect(listResumable(sid)).toHaveLength(2);
  });

  it('keeps completed transcripts in RAM in the explicit no-spill projection', async () => {
    configureResumeRegistryForTests({ spillTerminalTranscripts: false });
    await retainGroup(sid, group(sid, ['completed']), store);
    const stored = await getGroup(sid, `grp-${sid}`, store);
    expect(stored?.agents[0].transcript?.length).toBeGreaterThan(0);
    expect(stored?.agents[0].spillPath).toBeUndefined();
  });

  it('degrades to the final report when the spill file vanished', async () => {
    await retainGroup(sid, group(sid, ['completed']), store);
    const spillPath = (
      await getGroup(sid, `grp-${sid}`, store)
    )!.agents[0].spillPath!;
    rmSync(spillPath, { force: true }); // external cleanup between spill and read
    const result = await buildReadAgentTranscriptTool(store).handler(
      { spawn_id: `grp-${sid}`, agent: 1 },
      { cwd: '/tmp', runner: { sessionId: sid } } as unknown as ToolContext,
    );
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain('[final] Done — login() lives in src/auth.ts.');
  });

  it('retains the bundle transcript when the in-memory group is cleared', async () => {
    await retainGroup(sid, group(sid, ['completed']), store);
    const spillPath = (
      await getGroup(sid, `grp-${sid}`, store)
    )!.agents[0].spillPath!;
    expect(existsSync(spillPath)).toBe(true);
    await clearSession(sid);
    expect(existsSync(spillPath)).toBe(true);
  });

  it('re-hydrates a completed transcript entity after registry recreation', async () => {
    await retainGroup(sid, group(sid, ['completed']), store);
    await clearSession(sid);

    const restored = await findRetainedAgent(
      sid,
      `grp-${sid}`,
      1,
      store,
    );
    expect(restored?.spillPath).toBeTruthy();
    expect(existsSync(restored!.spillPath!)).toBe(true);
    expect(renderAgentTranscript(restored!)).toContain('→ read_file');
  });
});

describe('periodic worker-realm sweep (part a)', () => {

  it('reclaims an idle session on the timer without any registry access', async () => {
    configureResumeRegistryForTests({ ttlMs: 1000, sweepIntervalMs: 10_000 });
    vi.useFakeTimers();
    await retainGroup(sid, group(sid, ['error']), store);
    expect(peekSessionGroupCountForTests(sid)).toBe(1); // retain-time sweep kept it
    // Advance past the TTL. Only the timer runs here — no getGroup/sweep call.
    vi.advanceTimersByTime(15_000);
    expect(peekSessionGroupCountForTests(sid)).toBe(0);
  });

  it('the timer retains bundle artifacts after evicting in-memory pointers', async () => {
    configureResumeRegistryForTests({ ttlMs: 1000, sweepIntervalMs: 10_000 });
    vi.useFakeTimers();
    await retainGroup(sid, group(sid, ['completed']), store);
    const spillPath = (
      await getGroup(sid, `grp-${sid}`, store)
    )!.agents[0].spillPath!;
    expect(existsSync(spillPath)).toBe(true);
    vi.advanceTimersByTime(15_000);
    expect(peekSessionGroupCountForTests(sid)).toBe(0);
    expect(existsSync(spillPath)).toBe(true);
  });
});
