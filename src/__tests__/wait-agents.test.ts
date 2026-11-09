import { describe, it, expect, vi } from 'vitest';
import { waitAgents } from '@mcp/code-agent/tools/wait-agents.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext } from '@mcp/company/types.js';

const COMPANY_ID = '00000001-0000-4000-8000-000000000001';
const ID_1 = '00000001-0000-4000-8000-000000000001';
const ID_7 = '00000007-0000-4000-8000-000000000007';
const ID_9 = '00000009-0000-4000-8000-000000000009';

type AttentionEvent =
  | { kind: 'question' | 'plan' | 'tasks' | 'finished' | 'inbox_answered'; agentRunId: string; role: string };
type AttentionListener = (ev: AttentionEvent) => void;

interface FakeOrchestratorOpts {
  initialSubs: Array<{ agentRunId: string; role: string; status: string; statusMessage?: string }>;
  /** Scripted events: each entry fires after `delayMs` once a listener attaches. */
  scriptedEvents?: Array<AttentionEvent & { delayMs: number; statusAfter?: string }>;
}

function makeFakeOrchestrator(opts: FakeOrchestratorOpts) {
  const subs = opts.initialSubs.map((s) => ({
    ...s,
    statusMessage: s.statusMessage ?? '',
    projectIds: [],
    provider: 'a',
    model: 'm',
    coderSessionId: s.agentRunId,
    isAlive: true,
  }));
  const listeners = new Set<AttentionListener>();
  // Fire scripted events on the next tick after a listener attaches. They
  // each optionally update the corresponding sub's status before firing.
  let scriptStarted = false;
  const startScript = () => {
    if (scriptStarted) return;
    scriptStarted = true;
    for (const ev of opts.scriptedEvents ?? []) {
      setTimeout(() => {
        if (ev.statusAfter) {
          const sub = subs.find((s) => s.agentRunId === ev.agentRunId);
          if (sub) sub.status = ev.statusAfter;
        }
        for (const l of listeners) l(ev);
      }, ev.delayMs);
    }
  };
  return {
    hasRunningSubordinates: () => subs.some((s) => ![
      'completed',
      'finished',
      'failed',
      'aborted',
      'timed_out',
      'error',
    ].includes(s.status)),
    listSubordinates: () => subs.map((s) => ({ ...s })),
    masterHasPendingMessages: () => false,
    onSubordinateAttention: (listener: AttentionListener) => {
      listeners.add(listener);
      startScript();
      return () => { listeners.delete(listener); };
    },
  };
}

function makeCompanyCtx(opts: { isMaster: boolean; selfAgentRunId?: string | null; orch: ReturnType<typeof makeFakeOrchestrator> }): ToolContext {
  const cc: CompanyContext = {
    orchestrator: opts.orch as unknown as CompanyContext['orchestrator'],
    companySessionId: COMPANY_ID,
    agentRole: opts.isMaster ? 'master' : 'qa',
    agentRunId: opts.selfAgentRunId ?? null,
    allowedProjectIds: [],
    isMaster: opts.isMaster,
  };
  return { cwd: '/tmp', projectName: 'test', companyContext: cc };
}

describe('wait_agents', () => {
  it('errors on standalone session (no companyContext)', async () => {
    const r = await waitAgents.handler({ paths: [`/root/master/qa-${ID_1}`] }, { cwd: '/tmp', projectName: 'test' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no companyContext');
  });

  it('errors when neither paths nor agent_run_ids provided', async () => {
    const orch = makeFakeOrchestrator({ initialSubs: [{ agentRunId: ID_1, role: 'qa', status: 'running' }] });
    const r = await waitAgents.handler({}, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('at least one');
  });

  it('rejects /root and /root/master paths', async () => {
    const orch = makeFakeOrchestrator({ initialSubs: [] });
    const r = await waitAgents.handler({ paths: ['/root/master'] }, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('refuse to wait on master/root');
  });

  it('rejects malformed paths', async () => {
    const orch = makeFakeOrchestrator({ initialSubs: [] });
    const r = await waitAgents.handler({ paths: [`/root/qa-${ID_1}`] }, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not a recognized subordinate path');
  });

  it('rejects unknown agent_run_ids', async () => {
    const orch = makeFakeOrchestrator({ initialSubs: [{ agentRunId: ID_7, role: 'qa', status: 'running' }] });
    const r = await waitAgents.handler({ agent_run_ids: [ID_9] }, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`agent_run_id=${ID_9} not found`);
  });

  it('returns immediately when targets are already terminal', async () => {
    const orch = makeFakeOrchestrator({ initialSubs: [{ agentRunId: ID_7, role: 'qa', status: 'completed' }] });
    const r = await waitAgents.handler({ paths: [`/root/master/qa-${ID_7}`] }, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('already in terminal status');
    expect(r.content).toContain('completed');
  });

  it('returns when scripted finished event fires', async () => {
    const orch = makeFakeOrchestrator({
      initialSubs: [{ agentRunId: ID_7, role: 'qa', status: 'running' }],
      scriptedEvents: [{ kind: 'finished', agentRunId: ID_7, role: 'qa', delayMs: 30, statusAfter: 'completed' }],
    });
    const r = await waitAgents.handler({ paths: [`/root/master/qa-${ID_7}`] }, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('All targeted agents finished');
    expect(r.content).toContain(`qa-${ID_7}`);
  });

  it('master returns early when a target posts a question', async () => {
    const orch = makeFakeOrchestrator({
      initialSubs: [
        { agentRunId: ID_7, role: 'qa', status: 'running' },
        { agentRunId: ID_9, role: 'frontend', status: 'running' },
      ],
      scriptedEvents: [{ kind: 'question', agentRunId: ID_9, role: 'frontend', delayMs: 30 }],
    });
    const r = await waitAgents.handler(
      { paths: [`/root/master/qa-${ID_7}`, `/root/master/frontend-${ID_9}`] },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('answer_subordinate_question');
    expect(r.content).toContain('frontend');
    expect(r.content).toContain(`agent_run_id=${ID_9}`);
  });

  it('subordinate keeps waiting through peer questions; only terminal status releases it', async () => {
    const orch = makeFakeOrchestrator({
      initialSubs: [
        { agentRunId: ID_7, role: 'qa', status: 'running' }, // self
        { agentRunId: ID_9, role: 'frontend', status: 'running' }, // target
      ],
      scriptedEvents: [
        // Peer posts a question — subordinate should NOT release.
        { kind: 'question', agentRunId: ID_9, role: 'frontend', delayMs: 20 },
        // Then peer finishes — subordinate releases here.
        { kind: 'finished', agentRunId: ID_9, role: 'frontend', delayMs: 60, statusAfter: 'completed' },
      ],
    });
    const r = await waitAgents.handler(
      { agent_run_ids: [ID_9] },
      makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('All targeted agents finished');
    expect(r.content).toContain(`frontend-${ID_9}`);
    expect(r.content).toContain('completed');
  });

  it('ignores attention events from non-targeted agents', async () => {
    const orch = makeFakeOrchestrator({
      initialSubs: [
        { agentRunId: ID_7, role: 'qa', status: 'running' }, // target
        { agentRunId: ID_9, role: 'frontend', status: 'running' }, // unrelated
      ],
      scriptedEvents: [
        // Unrelated peer noise
        { kind: 'question', agentRunId: ID_9, role: 'frontend', delayMs: 15 },
        { kind: 'plan', agentRunId: ID_9, role: 'frontend', delayMs: 30 },
        // Target finishes
        { kind: 'finished', agentRunId: ID_7, role: 'qa', delayMs: 50, statusAfter: 'completed' },
      ],
    });
    const r = await waitAgents.handler({ paths: [`/root/master/qa-${ID_7}`] }, makeCompanyCtx({ isMaster: true, orch }));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('All targeted agents finished');
  });

  it('times out and reports still-running targets', async () => {
    vi.useFakeTimers();
    const orch = makeFakeOrchestrator({
      initialSubs: [{ agentRunId: ID_7, role: 'qa', status: 'running' }],
      // No scripted events: nothing fires, so we'll hit the timeout.
    });
    const promise = waitAgents.handler(
      { paths: [`/root/master/qa-${ID_7}`], timeout_minutes: 0.001 }, // ~60ms
      makeCompanyCtx({ isMaster: true, orch }),
    );
    await vi.advanceTimersByTimeAsync(200);
    const r = await promise;
    vi.useRealTimers();
    // A wait deadline is a successful pending observation, not a failed agent.
    expect(r.isError).toBeFalsy();
    expect(r.structuredData).toMatchObject({
      schemaVersion: 1, reason: 'timeout',
      items: [{ agentRunId: ID_7, path: `/root/master/qa-${ID_7}` }],
    });
    expect(r.content).toContain('timed out');
    expect(r.content).toContain(`/root/master/qa-${ID_7}`);
  });
});
