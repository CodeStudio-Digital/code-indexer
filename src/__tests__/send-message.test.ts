import { describe, it, expect, vi } from 'vitest';
import { sendMessage } from '../core/coder/tools/send-message.js';
import type { ToolContext } from '../core/coder/core/tool.js';
import type { CompanyContext } from '../core/coder/company/types.js';

interface FakeSubHandle {
  role: string;
  runner: { pushUserMessage: (m: string) => void };
}

interface FakeOrchestratorOpts {
  subs: Array<{ agentRunId: number; role: string; running: boolean; handle?: FakeSubHandle }>;
}

function makeFakeOrchestrator(opts: FakeOrchestratorOpts) {
  const subById = new Map(opts.subs.map((s) => [s.agentRunId, s]));
  return {
    listSubordinates: () => opts.subs.map((s) => ({
      agentRunId: s.agentRunId,
      role: s.role,
      status: s.running ? 'running' : 'waiting',
      statusMessage: '',
      projectIds: [],
      provider: 'a',
      model: 'm',
      coderSessionId: 1,
      isAlive: true,
    })),
    isSubordinateRunning: (id: number) => !!subById.get(id)?.running,
    getSubordinate: (id: number) => {
      const s = subById.get(id);
      if (!s) return undefined;
      return s.handle ?? { role: s.role, runner: { pushUserMessage: vi.fn() } };
    },
    notifyMasterAboutSubordinate: vi.fn(),
    inboxSend: vi.fn((args: { toAgentRunId?: number; body: string; kind: string }) => ({
      message: { id: 999, body: args.body, kind: args.kind },
      deliveredImmediately: subById.get(args.toAgentRunId ?? -1)?.running ?? false,
    })),
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

describe('send_message — input validation', () => {
  it('errors on standalone session', async () => {
    const r = await sendMessage.handler(
      { to: '/root/master', message: 'hi' },
      { cwd: '/tmp', projectName: 'test' },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no companyContext');
  });

  it('errors on empty message', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendMessage.handler(
      { to: '/root/master/qa-1', message: '   ' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('cannot be empty');
  });

  it('errors on malformed path', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendMessage.handler(
      { to: '/root/qa-1', message: 'x' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not a valid agent path');
  });
});

describe('send_message — master caller', () => {
  it('rejects sending to /root/master from master', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendMessage.handler(
      { to: '/root/master', message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('you are the master');
  });

  it('rejects unknown agent_run_id', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendMessage.handler(
      { to: '/root/master/qa-99', message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('no subordinate with agent_run_id=99');
  });

  it('rejects sending to a non-running sub (suggests forward_to_agent)', async () => {
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: 7, role: 'qa', running: false, handle: { role: 'qa', runner: { pushUserMessage: vi.fn() } } }],
    });
    const r = await sendMessage.handler(
      { to: '/root/master/qa-7', message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not running');
    expect(r.content).toContain('forward_to_agent');
  });

  it('pushes user message into running sub runner', async () => {
    const pushFn = vi.fn();
    const handle: FakeSubHandle = { role: 'qa', runner: { pushUserMessage: pushFn } };
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: 7, role: 'qa', running: true, handle }],
    });
    const r = await sendMessage.handler(
      { to: '/root/master/qa-7', message: 'check the kanban' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Message delivered to /root/master/qa-7');
    expect(pushFn).toHaveBeenCalledTimes(1);
    expect(pushFn).toHaveBeenCalledWith('[From Master]: check the kanban');
  });
});

describe('send_message — subordinate caller', () => {
  it('to=/root/master forwards to master notification queue', async () => {
    const orch = makeFakeOrchestrator({ subs: [{ agentRunId: 7, role: 'qa', running: true }] });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendMessage.handler({ to: '/root/master', message: 'I am stuck' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('master notification queue');
    expect(orch.notifyMasterAboutSubordinate).toHaveBeenCalledTimes(1);
    const arg = (orch.notifyMasterAboutSubordinate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(arg).toContain('@qa');
    expect(arg).toContain('run=7');
    expect(arg).toContain('I am stuck');
  });

  it('refuses to send to self', async () => {
    const orch = makeFakeOrchestrator({ subs: [{ agentRunId: 7, role: 'qa', running: true }] });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendMessage.handler({ to: '/root/master/qa-7', message: 'hi' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('to yourself');
  });

  it('peer→peer routes through inbox notify', async () => {
    const orch = makeFakeOrchestrator({
      subs: [
        { agentRunId: 7, role: 'qa', running: true },
        { agentRunId: 9, role: 'frontend', running: true },
      ],
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendMessage.handler(
      { to: '/root/master/frontend-9', message: 'tests are green' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Message 999');
    expect(r.content).toContain('frontend-9');
    expect(orch.inboxSend).toHaveBeenCalledTimes(1);
    const args = (orch.inboxSend as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      fromAgentRunId: number;
      toAgentRunId: number;
      kind: string;
      body: string;
      wait: boolean;
    };
    expect(args.fromAgentRunId).toBe(7);
    expect(args.toAgentRunId).toBe(9);
    expect(args.kind).toBe('notify');
    expect(args.wait).toBe(false);
    expect(args.body).toBe('tests are green');
  });

  it('returns delivery state from inbox result', async () => {
    const orch = makeFakeOrchestrator({
      subs: [
        { agentRunId: 7, role: 'qa', running: true },
        { agentRunId: 9, role: 'frontend', running: false }, // pending delivery
      ],
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: 7, selfRole: 'qa', orch });
    const r = await sendMessage.handler(
      { to: '/root/master/frontend-9', message: 'fyi' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('pending');
  });
});
