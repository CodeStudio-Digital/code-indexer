/**
 * list_agents — cross-tier inventory of agents reachable from the current
 * runner. Inspired by codex's tree-structured `list_agents`.
 *
 * Tiers we surface:
 *  - The caller itself (always — line tagged `[self]`).
 *  - Company-tier peers: when the caller is part of a CoderCompany session,
 *    we include the master and every subordinate run. Roles are read from
 *    the orchestrator so abort/status/spawn happen via the existing master
 *    tools — `list_agents` is a strict read-only inventory.
 *  - Ephemeral subagents (`spawn_subagent` / `spawn_agents`): NOT shown.
 *    They run inline inside the parent's tool call boundary, so the parent
 *    can never observe them between turns. There is no point listing them.
 *
 * Path format: `/root[/<role>-<agentRunId>]`. Mirrors codex's notation but
 * scoped to one company session at a time.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext } from '@mcp/company/types.js';
import { ok } from '@mcp/code-agent/core/tool.js';
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

interface AgentLine {
  path: string;
  role: string;
  agent_run_id: string | null;
  status: string;
  is_self: boolean;
  is_master: boolean;
  status_message?: string;
  provider?: string;
  model?: string;
  is_alive?: boolean;
}

const LIST_AGENTS_DESC =
  'List every agent reachable from this runner: the caller itself plus, when in a company session, the master and all subordinates. ' +
  'Read-only inventory — for actions, use the master tools (spawn_subordinate_agent, forward_to_agent, abort_subordinate_agent, ...).\n' +
  "USE: at the start of a master turn to see who is alive and what status they hold.\n" +
  "USE: from a subordinate that wants to know which peers are running before deciding to wait or proceed.\n" +
  "DON'T: poll this in a loop. Subordinate state changes via attention events, not periodic polling.";

function buildLines(ctx: ToolContext): AgentLine[] {
  const cc: CompanyContext | undefined = ctx.companyContext;
  // Standalone (non-company) session: just self.
  if (!cc) {
    return [{
      path: '/root',
      role: 'agent',
      agent_run_id: null,
      status: 'running',
      is_self: true,
      is_master: false,
    }];
  }

  const lines: AgentLine[] = [];
  // Master entry — always synthesized from the orchestrator handle so the
  // line is consistent regardless of whether the caller IS the master or a
  // subordinate looking up.
  lines.push({
    path: '/root/master',
    role: 'master',
    agent_run_id: null, // master runs in the company session itself, no agentRun row
    status: 'running',
    is_self: cc.isMaster,
    is_master: true,
  });

  let subs: ReturnType<typeof cc.orchestrator.listSubordinates> = [];
  try { subs = cc.orchestrator.listSubordinates(); } catch { subs = []; }
  for (const s of subs) {
    lines.push({
      path: `/root/master/${s.role}-${s.agentRunId}`,
      role: s.role,
      agent_run_id: s.agentRunId,
      status: s.status,
      is_self: !cc.isMaster && s.agentRunId === cc.agentRunId,
      is_master: false,
      status_message: s.statusMessage || undefined,
      provider: s.provider,
      model: s.model,
      is_alive: s.isAlive,
    });
  }
  return lines;
}

export const listAgents: CoderTool = {
  name: 'list_agents',
  description: maybeTerse(LIST_AGENTS_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: true,
  repeatPolicy: 'volatile',
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['all', 'running', 'waiting', 'completed', 'self', 'peers'],
        description: 'Filter the result. "self" returns only the caller; "peers" excludes the caller; status filters match the subordinate status.',
      },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const all = buildLines(ctx);
    const filter = (args.filter as string | undefined) ?? 'all';
    const asJson = args.format === 'json';
    let lines = all;
    switch (filter) {
      case 'self':    lines = all.filter((l) => l.is_self); break;
      case 'peers':   lines = all.filter((l) => !l.is_self); break;
      case 'running':
      case 'waiting':
      case 'completed':
        lines = all.filter((l) => l.status === filter);
        break;
      // 'all' falls through
    }
    if (asJson) {
      return okStructured({ total: all.length, shown: lines.length, agents: lines });
    }
    if (lines.length === 0) return ok('(no agents match filter)');
    const rendered = lines.map((l) => {
      const tags: string[] = [];
      if (l.is_self) tags.push('SELF');
      if (l.is_master) tags.push('master');
      if (l.is_alive) tags.push('ALIVE');
      const tail =
        (l.provider ? ` provider=${l.provider}` : '') +
        (l.model ? ` model=${l.model}` : '') +
        (l.status_message ? ` last="${l.status_message}"` : '');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      return `- ${l.path} status=${l.status}${l.agent_run_id != null ? ` agent_run_id=${l.agent_run_id}` : ''}${tagStr}${tail}`;
    });
    return ok(rendered.join('\n'));
  },
};

export const listAgentsTools: CoderTool[] = [listAgents];
