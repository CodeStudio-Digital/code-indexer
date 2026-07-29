import { describe, it, expect, vi } from 'vitest';
import { sendInput } from '@mcp/code-agent/tools/send-input.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext } from '@mcp/company/types.js';

const COMPANY_ID = '00000001-0000-4000-8000-000000000001';
const ID_1 = '00000001-0000-4000-8000-000000000001';
const ID_7 = '00000007-0000-4000-8000-000000000007';
const ID_9 = '00000009-0000-4000-8000-000000000009';
const ID_99 = '00000099-0000-4000-8000-000000000099';

interface FakeSubHandle {
  role: string;
  runner: {
    pushUserMessage: (m: string) => void;
    interruptWait: () => boolean;
  };
}

interface FakeOrchestratorOpts {
  subs: Array<{ agentRunId: string; role: string; running: boolean; handle?: FakeSubHandle }>;
  masterInterruptResult?: boolean;
}

function makeFakeOrchestrator(opts: FakeOrchestratorOpts) {
  const subById = new Map(opts.subs.map((s) => [s.agentRunId, s]));
  return {
    listSubordinates: () => opts.subs.map((s) => ({
      agentRunId: s.agentRunId, role: s.role,
      status: s.running ? 'running' : 'waiting',
      statusMessage: '', projectIds: [], provider: 'a', model: 'm',
      coderSessionId: s.agentRunId, isAlive: true,
    })),
    isSubordinateRunning: (id: string) => !!subById.get(id)?.running,
    getSubordinate: (id: string) => {
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
  selfAgentRunId?: string;
  selfRole?: string;
  orch: ReturnType<typeof makeFakeOrchestrator>;
}): ToolContext {
  const cc: CompanyContext = {
    orchestrator: opts.orch as unknown as CompanyContext['orchestrator'],
    companySessionId: COMPANY_ID,
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
      makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_1, orch }),
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
      { to: `/root/master/qa-${ID_99}`, message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`no subordinate with agent_run_id=${ID_99}`);
  });

  it('rejects sending to a non-running sub', async () => {
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: ID_7, role: 'qa', running: false }],
    });
    const r = await sendInput.handler(
      { to: `/root/master/qa-${ID_7}`, message: 'hi' },
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
      subs: [{ agentRunId: ID_7, role: 'qa', running: true, handle }],
    });
    const r = await sendInput.handler(
      { to: `/root/master/qa-${ID_7}`, message: 'context changed: stop and reread the brief' },
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
      subs: [{ agentRunId: ID_7, role: 'qa', running: true, handle }],
    });
    const r = await sendInput.handler(
      { to: `/root/master/qa-${ID_7}`, message: 'fyi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('queued for next turn');
  });
});

describe('send_input — subordinate caller', () => {
  it('to=/root/master notifies AND interrupts master wait', async () => {
    const orch = makeFakeOrchestrator({ subs: [{ agentRunId: ID_7, role: 'qa', running: true }], masterInterruptResult: true });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
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
    expect(interruptArg).toEqual({ kind: 'question', agentRunId: ID_7, role: 'qa' });
  });

  it('reports queued when master had no pending wait', async () => {
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: ID_7, role: 'qa', running: true }],
      masterInterruptResult: false,
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
    const r = await sendInput.handler({ to: '/root/master', message: 'fyi' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('queued for next turn');
  });

  it('refuses peer-to-peer interrupts', async () => {
    const orch = makeFakeOrchestrator({
      subs: [
        { agentRunId: ID_7, role: 'qa', running: true },
        { agentRunId: ID_9, role: 'frontend', running: true },
      ],
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
    const r = await sendInput.handler(
      { to: `/root/master/frontend-${ID_9}`, message: 'hi' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('peer-to-peer interrupts are not allowed');
    expect(r.content).toContain('send_message');
    expect(r.content).toContain('send_to_agent');
  });
});
