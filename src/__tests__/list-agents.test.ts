import { describe, it, expect } from 'vitest';
import { listAgents } from '@mcp/code-agent/tools/list-agents.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext } from '@mcp/company/types.js';

const COMPANY_ID = '00000001-0000-4000-8000-000000000001';
const ID_7 = '00000007-0000-4000-8000-000000000007';
const ID_9 = '00000009-0000-4000-8000-000000000009';

function ctxStandalone(): ToolContext {
  return { cwd: '/tmp', projectName: 'test' };
}

function makeCompanyCtx(opts: {
  isMaster: boolean;
  selfAgentRunId?: string | null;
  subs?: Array<{ agentRunId: string; role: string; status: string; statusMessage?: string; provider?: string; model?: string; isAlive?: boolean }>;
}): ToolContext {
  const subs = opts.subs ?? [];
  const orchestrator = {
    listSubordinates: () => subs.map((s) => ({
      agentRunId: s.agentRunId,
      role: s.role,
      status: s.status,
      statusMessage: s.statusMessage ?? '',
      projectIds: [],
      provider: s.provider ?? 'anthropic',
      model: s.model ?? 'sonnet',
      coderSessionId: s.agentRunId,
      isAlive: s.isAlive ?? false,
    })),
  };
  const cc: CompanyContext = {
    orchestrator: orchestrator as unknown as CompanyContext['orchestrator'],
    companySessionId: COMPANY_ID,
    agentRole: opts.isMaster ? 'master' : 'qa',
    agentRunId: opts.selfAgentRunId ?? null,
    allowedProjectIds: [],
    isMaster: opts.isMaster,
  };
  return { cwd: '/tmp', projectName: 'test', companyContext: cc };
}

describe('list_agents', () => {
  it('standalone session shows only self', async () => {
    const r = await listAgents.handler({}, ctxStandalone());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('/root');
    expect(r.content).toContain('SELF');
    // No subordinates path
    expect(r.content).not.toContain('/root/master/');
  });

  it('master session lists master + subordinates with paths', async () => {
    const ctx = makeCompanyCtx({
      isMaster: true,
      subs: [
        { agentRunId: ID_7, role: 'qa', status: 'running', isAlive: true, statusMessage: 'writing tests' },
        { agentRunId: ID_9, role: 'frontend', status: 'waiting' },
      ],
    });
    const r = await listAgents.handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('/root/master');
    expect(r.content).toContain('SELF');
    expect(r.content).toContain(`/root/master/qa-${ID_7}`);
    expect(r.content).toContain(`agent_run_id=${ID_7}`);
    expect(r.content).toContain('ALIVE');
    expect(r.content).toContain('writing tests');
    expect(r.content).toContain(`/root/master/frontend-${ID_9}`);
  });

  it('subordinate session marks itself among peers', async () => {
    const ctx = makeCompanyCtx({
      isMaster: false,
      selfAgentRunId: ID_9,
      subs: [
        { agentRunId: ID_7, role: 'qa', status: 'running' },
        { agentRunId: ID_9, role: 'frontend', status: 'running' },
      ],
    });
    const r = await listAgents.handler({}, ctx);
    expect(r.isError).toBeFalsy();
    // Master is NOT self
    const masterLine = r.content.split('\n').find((l) => l.includes('/root/master ')) ?? '';
    expect(masterLine).toContain('master');
    expect(masterLine).not.toContain('SELF');
    // Self is the frontend-9 line
    const selfLine = r.content.split('\n').find((l) => l.includes(`/root/master/frontend-${ID_9}`)) ?? '';
    expect(selfLine).toContain('SELF');
    // Peer qa-7 has no SELF tag
    const peerLine = r.content.split('\n').find((l) => l.includes(`/root/master/qa-${ID_7}`)) ?? '';
    expect(peerLine).not.toContain('SELF');
  });

  it('filter=self returns only self entry', async () => {
    const ctx = makeCompanyCtx({
      isMaster: true,
      subs: [{ agentRunId: ID_7, role: 'qa', status: 'running' }],
    });
    const r = await listAgents.handler({ filter: 'self' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('/root/master');
    expect(r.content).not.toContain(`qa-${ID_7}`);
  });

  it('filter=peers excludes self', async () => {
    const ctx = makeCompanyCtx({
      isMaster: true,
      subs: [{ agentRunId: ID_7, role: 'qa', status: 'running' }],
    });
    const r = await listAgents.handler({ filter: 'peers' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain('SELF');
    expect(r.content).toContain(`qa-${ID_7}`);
  });

  it('filter=running keeps only running entries', async () => {
    const ctx = makeCompanyCtx({
      isMaster: true,
      subs: [
        { agentRunId: ID_7, role: 'qa', status: 'running' },
        { agentRunId: ID_9, role: 'frontend', status: 'completed' },
      ],
    });
    const r = await listAgents.handler({ filter: 'running' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`qa-${ID_7}`);
    expect(r.content).not.toContain(`frontend-${ID_9}`);
    // Master is also "running" (synthesized status), so it should appear
    expect(r.content).toContain('/root/master ');
  });

  it('JSON output includes self/master flags and total/shown', async () => {
    const ctx = makeCompanyCtx({
      isMaster: false,
      selfAgentRunId: ID_7,
      subs: [{ agentRunId: ID_7, role: 'qa', status: 'running' }],
    });
    const r = await listAgents.handler({ format: 'json' }, ctx);
    expect(r.isError).toBeFalsy();
    const parsed = r.structuredData as {
      total: number;
      shown: number;
      agents: Array<{
        is_self: boolean;
        is_master: boolean;
        role: string;
        path: string;
      }>;
    };
    expect(parsed.total).toBe(2);
    expect(parsed.shown).toBe(2);
    const self = parsed.agents.find((a: { is_self: boolean }) => a.is_self);
    if (!self) throw new Error('self agent missing from JSON projection');
    expect(self.role).toBe('qa');
    expect(self.path).toBe(`/root/master/qa-${ID_7}`);
    const master = parsed.agents.find((a: { is_master: boolean }) => a.is_master);
    if (!master) throw new Error('master agent missing from JSON projection');
    expect(master.is_self).toBe(false);
  });

  it('handles orchestrator throw gracefully (returns just master)', async () => {
    const ctx: ToolContext = {
      cwd: '/tmp',
      projectName: 'test',
      companyContext: {
        orchestrator: {
          listSubordinates: () => { throw new Error('orchestrator crash'); },
        } as unknown as CompanyContext['orchestrator'],
        companySessionId: COMPANY_ID,
        agentRole: 'master',
        agentRunId: null,
        allowedProjectIds: [],
        isMaster: true,
      },
    };
    const r = await listAgents.handler({}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('/root/master');
    // No subs because the call threw
    expect(r.content.split('\n').filter((l) => l.startsWith('-'))).toHaveLength(1);
  });
});
