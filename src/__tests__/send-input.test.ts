import { describe, it, expect, vi } from 'vitest';
import { sendInput } from '../core/coder/tools/send-input.js';
import type { ToolContext } from '../core/coder/core/tool.js';
import type { CompanyContext } from '../core/coder/company/types.js';

interface FakeSubHandle {
  role: string;
  runner: {
    pushUserMessage: (m: string) => void;
    interruptWait: () => boolean;
  };
}

interface FakeOrchestratorOpts {
  subs: Array<{ agentRunId: number; role: string; running: boolean; handle?: FakeSubHandle }>;
  masterInterruptResult?: boolean;
}

function makeFakeOrchestrator(opts: FakeOrchestratorOpts) {
  const subById = new Map(opts.subs.map((s) => [s.agentRunId, s]));
  return {
    listSubordinates: () => opts.subs.map((s) => ({
      agentRunId: s.agentRunId, role: s.role,
      status: s.running ? 'running' : 'waiting',
      statusMessage: '', projectIds: [], provider: 'a', model: 'm',
      coderSessionId: 1, isAlive: true,
    })),
    isSubordinateRunning: (id: number) => !!subById.get(id)?.running,
    getSubordinate: (id: number) => {
      const s = subById.get(id);
      if (!s) return undefined;
      return s.handle ?? {
        role: s.role,
        runner: {
          pushUserMessage: vi.fn(),
          interruptWait: vi.fn(() => false),
        },
      };
    },
    notifyMasterAboutSubordinate: vi.fn(),
    interruptMasterWait: vi.fn(() => opts.masterInterruptResult ?? false),
  };
}

function makeCompanyCtx(opts: {
  isMaster: boolean;
  selfAgentRunId?: number;
  selfRole?: string;
  orch: ReturnType<typeof makeFakeOrchestrator>;
}): ToolContext {
  const cc: CompanyContext = {
    orchestrator: opts.orch as unknown as CompanyContext['orchestrator'],
    companySessionId: 1,
    agentRole: opts.selfRole ?? (opts.isMaster ? 'master' : 'qa'),
    agentRunId: opts.selfAgentRunId ?? null,
    allowedProjectIds: [],
    isMaster: opts.isMaster,
  };
  return { cwd: '/tmp', projectName: 'test', companyContext: cc };
}

describe('send_input — input validation', () => {
  it('errors on standalone session', async () => {
    const r = await sendInput.handler(
      { to: '/root/master', message: 'hi' },
      { cwd: '/tmp', projectName: 'test' },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no companyContext');
  });

  it('errors on empty message', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendInput.handler(
      { to: '/root/master', message: '   ' },
      makeCompanyCtx({ isMaster: false, selfAgentRunId: 1, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('cannot be empty');
  });

  it('errors on malformed path', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendInput.handler(
      { to: 'not-a-path', message: 'x' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not a valid agent path');
  });
});

describe('send_input — master caller', () => {
  it('rejects sending to /root/master', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendInput.handler(
      { to: '/root/master', message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('you are the master');
  });

  it('rejects unknown agent_run_id', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendInput.handler(
      { to: '/root/master/qa-99', message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no subordinate with agent_run_id=99');
  });

  it('rejects sending to a non-running sub', async () => {
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: 7, role: 'qa', running: false }],
    });
    const r = await sendInput.handler(
      { to: '/root/master/qa-7', message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not running');
  });

  it('pushes message AND calls interruptWait on running sub', async () => {
    const pushFn = vi.fn();
    const interruptFn = vi.fn(() => true); // wait WAS pending
    const handle: FakeSubHandle = {
      role: 'qa',
      runner: { pushUserMessage: pushFn, interruptWait: interruptFn },
    };
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: 7, role: 'qa', running: true, handle }],
    });
    const r = await sendInput.handler(
      { to: '/root/master/qa-7', message: 'context changed: stop and reread the brief' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('released a pending wait');
    expect(pushFn).toHaveBeenCalledWith('[From Master — interrupt]: context changed: stop and reread the brief');
    expect(interruptFn).toHaveBeenCalledTimes(1);
  });

  it('reports queued state when no wait was pending', async () => {
    const handle: FakeSubHandle = {
      role: 'qa',
      runner: { pushUserMessage: vi.fn(), interruptWait: vi.fn(() => false) },
    };
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: 7, role: 'qa', running: true, handle }],
    });
    const r = await sendInput.handler(
      { to: '/root/master/qa-7', message: 'fyi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('queued for next turn');
  });
});

describe('send_input — subordinate caller', () => {
  it('to=/root/master notifies AND interrupts master wait', async () => {
    const orch = makeFakeOrchestrator({ subs: [{ agentRunId: 7, role: 'qa', running: true }], masterInterruptResult: true });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendInput.handler({ to: '/root/master', message: 'tests are failing on main' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('released a pending wait');
    expect(orch.notifyMasterAboutSubordinate).toHaveBeenCalledTimes(1);
    const notifyArg = (orch.notifyMasterAboutSubordinate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(notifyArg).toContain('@qa');
    expect(notifyArg).toContain('interrupt');
    expect(notifyArg).toContain('tests are failing on main');
    expect(orch.interruptMasterWait).toHaveBeenCalledTimes(1);
    const interruptArg = (orch.interruptMasterWait as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(interruptArg).toEqual({ kind: 'question', agentRunId: 7, role: 'qa' });
  });

  it('reports queued when master had no pending wait', async () => {
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: 7, role: 'qa', running: true }],
      masterInterruptResult: false,
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendInput.handler({ to: '/root/master', message: 'fyi' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('queued for next turn');
  });

  it('refuses peer-to-peer interrupts', async () => {
    const orch = makeFakeOrchestrator({
      subs: [
        { agentRunId: 7, role: 'qa', running: true },
        { agentRunId: 9, role: 'frontend', running: true },
      ],
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendInput.handler(
      { to: '/root/master/frontend-9', message: 'hi' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('peer-to-peer interrupts are not allowed');
    expect(r.content).toContain('send_message');
    expect(r.content).toContain('send_to_agent');
  });
});
