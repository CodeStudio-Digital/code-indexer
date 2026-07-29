import { describe, it, expect, vi } from 'vitest';
import { sendMessage } from '@mcp/code-agent/tools/send-message.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext } from '@mcp/company/types.js';

const COMPANY_ID = '00000001-0000-4000-8000-000000000001';
const ID_1 = '00000001-0000-4000-8000-000000000001';
const ID_7 = '00000007-0000-4000-8000-000000000007';
const ID_9 = '00000009-0000-4000-8000-000000000009';
const ID_99 = '00000099-0000-4000-8000-000000000099';
const MESSAGE_ID = '00000999-0000-4000-8000-000000000999';

interface FakeSubHandle {
  role: string;
  runner: { pushUserMessage: (m: string) => void };
}

interface FakeOrchestratorOpts {
  subs: Array<{ agentRunId: string; role: string; running: boolean; handle?: FakeSubHandle }>;
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
      coderSessionId: s.agentRunId,
      isAlive: true,
    })),
    isSubordinateRunning: (id: string) => !!subById.get(id)?.running,
    getSubordinate: (id: string) => {
      const s = subById.get(id);
      if (!s) return undefined;
      return s.handle ?? { role: s.role, runner: { pushUserMessage: vi.fn() } };
    },
    notifyMasterAboutSubordinate: vi.fn(),
    inboxSend: vi.fn((args: { toAgentRunId?: string; body: string; kind: string }) => ({
      message: { id: MESSAGE_ID, body: args.body, kind: args.kind },
      deliveredImmediately: subById.get(args.toAgentRunId ?? '')?.running ?? false,
    })),
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
      { to: `/root/master/qa-${ID_1}`, message: '   ' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('cannot be empty');
  });

  it('errors on malformed path', async () => {
    const orch = makeFakeOrchestrator({ subs: [] });
    const r = await sendMessage.handler(
      { to: `/root/qa-${ID_1}`, message: 'x' },
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
      { to: `/root/master/qa-${ID_99}`, message: 'hi' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain(`no subordinate with agent_run_id=${ID_99}`);
  });

  it('rejects sending to a non-running sub (suggests forward_to_agent)', async () => {
    const orch = makeFakeOrchestrator({
      subs: [{ agentRunId: ID_7, role: 'qa', running: false, handle: { role: 'qa', runner: { pushUserMessage: vi.fn() } } }],
    });
    const r = await sendMessage.handler(
      { to: `/root/master/qa-${ID_7}`, message: 'hi' },
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
      subs: [{ agentRunId: ID_7, role: 'qa', running: true, handle }],
    });
    const r = await sendMessage.handler(
      { to: `/root/master/qa-${ID_7}`, message: 'check the kanban' },
      makeCompanyCtx({ isMaster: true, orch }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`Message delivered to /root/master/qa-${ID_7}`);
    expect(pushFn).toHaveBeenCalledTimes(1);
    expect(pushFn).toHaveBeenCalledWith('[From Master]: check the kanban');
  });
});

describe('send_message — subordinate caller', () => {
  it('to=/root/master forwards to master notification queue', async () => {
    const orch = makeFakeOrchestrator({ subs: [{ agentRunId: ID_7, role: 'qa', running: true }] });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
    const r = await sendMessage.handler({ to: '/root/master', message: 'I am stuck' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('master notification queue');
    expect(orch.notifyMasterAboutSubordinate).toHaveBeenCalledTimes(1);
    const arg = (orch.notifyMasterAboutSubordinate as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(arg).toContain('@qa');
    expect(arg).toContain(`run=${ID_7}`);
    expect(arg).toContain('I am stuck');
  });

  it('refuses to send to self', async () => {
    const orch = makeFakeOrchestrator({ subs: [{ agentRunId: ID_7, role: 'qa', running: true }] });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
    const r = await sendMessage.handler({ to: `/root/master/qa-${ID_7}`, message: 'hi' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('to yourself');
  });

  it('peer→peer routes through inbox notify', async () => {
    const orch = makeFakeOrchestrator({
      subs: [
        { agentRunId: ID_7, role: 'qa', running: true },
        { agentRunId: ID_9, role: 'frontend', running: true },
      ],
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
    const r = await sendMessage.handler(
      { to: `/root/master/frontend-${ID_9}`, message: 'tests are green' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`Message ${MESSAGE_ID}`);
    expect(r.content).toContain(`frontend-${ID_9}`);
    expect(orch.inboxSend).toHaveBeenCalledTimes(1);
    const args = (orch.inboxSend as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      fromAgentRunId: string;
      toAgentRunId: string;
      kind: string;
      body: string;
      wait: boolean;
    };
    expect(args.fromAgentRunId).toBe(ID_7);
    expect(args.toAgentRunId).toBe(ID_9);
    expect(args.kind).toBe('notify');
    expect(args.wait).toBe(false);
    expect(args.body).toBe('tests are green');
  });

  it('returns delivery state from inbox result', async () => {
    const orch = makeFakeOrchestrator({
      subs: [
        { agentRunId: ID_7, role: 'qa', running: true },
        { agentRunId: ID_9, role: 'frontend', running: false }, // pending delivery
      ],
    });
    const ctx = makeCompanyCtx({ isMaster: false, selfAgentRunId: ID_7, selfRole: 'qa', orch });
    const r = await sendMessage.handler(
      { to: `/root/master/frontend-${ID_9}`, message: 'fyi' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('pending');
  });
});
