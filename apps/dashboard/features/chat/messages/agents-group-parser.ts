import type { AgentsGroup } from '../../../hooks/useAgentStream.js';

type PersistedToolResult = { content: string; isError?: boolean };

const TRANSPORT_TRUNCATION_RE = /\n*\s*… \[truncated for transport — \d+ more chars in DB\]\s*$/;
const AGENT_PREVIEW_TRUNCATION_RE = /\n*\s*… \[agent report truncated for transport\]\s*$/;

function stripTransportMarkers(text: string): string {
  return text
    .replace(TRANSPORT_TRUNCATION_RE, '')
    .replace(AGENT_PREVIEW_TRUNCATION_RE, '')
    .trim();
}

function collectAgentSections(content: string): string[] {
  const matches = [...content.matchAll(/^###\s+Agent\s+\d+:\s+.*$/gm)];
  if (matches.length === 0) return [];

  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const nextStart = matches[i + 1]?.index ?? content.length;
    sections.push(content.slice(start, nextStart).replace(/\n\s*---\s*$/, '').trim());
  }
  return sections;
}

/**
 * Reconstruct an AgentsGroup from the persisted tool_use input + tool_result
 * so the rich AgentsGroupBlock renders instead of raw JSON on session reload.
 */
export function parsePersistedAgentsGroup(
  input: Record<string, unknown> | undefined,
  result: PersistedToolResult | undefined,
): AgentsGroup | null {
  const agents = (input as { agents?: unknown[] })?.agents;
  if (!Array.isArray(agents) || agents.length === 0) return null;

  // Per-agent results parsed from the combined result text. Two shapes:
  //  - parallel (N>1): "### Agent N: <label>\n[type=… reason=… tools=… input=… output=…]\n<summary>"
  //  - single  (N=1):  "[subagent provider=… model=… type=… reason=… input=… output=… cache_hit=…]\n\n<report>"
  const agentResults = new Map<number, {
    provider?: string;
    model?: string;
    type?: string;
    reason: string;
    tools: number;
    input: number;
    output: number;
    summary: string;
    attempt?: number;
  }>();
  const groupProviderMatch = result?.content?.match(
    /\[parallel agents:[^\]]*provider=([^\s,\]]+)\s+model=([^\s,\]]+)/,
  );
  const groupUsageMatch = result?.content?.match(
    /\[parallel agents:[^\]]*input=(\d+)\s+output=(\d+)/,
  );
  let groupProvider = groupProviderMatch?.[1];
  let groupModel = groupProviderMatch?.[2];
  if (result?.content) {
    for (const section of collectAgentSections(result.content)) {
      const headerMatch = section.match(/^###\s+Agent\s+(\d+):\s+(.+)$/m);
      if (!headerMatch) continue;
      const idx = parseInt(headerMatch[1], 10) - 1;
      // Per-agent meta is `[type=… reason=… tools=… input=… output=…]`.
      // `profile=...` existed briefly in this slot; keep parsing old rows.
      // provider/model live on the group header, not per-agent.
      const metaMatch = section.match(
        /\[type=(\S+)(?:\s+profile=\S+)?\s+reason=(\w+)\s+tools=(\d+)\s+input=(\d+)\s+output=(\d+)(?:\s+attempt=(\d+))?\]/,
      );
      const summaryStart = section.indexOf('\n', section.indexOf(']') + 1);
      const summary = summaryStart >= 0 ? stripTransportMarkers(section.slice(summaryStart)) : '';
      agentResults.set(idx, {
        type: metaMatch?.[1],
        reason: metaMatch?.[2] ?? 'unknown',
        tools: parseInt(metaMatch?.[3] ?? '0', 10),
        input: parseInt(metaMatch?.[4] ?? '0', 10),
        output: parseInt(metaMatch?.[5] ?? '0', 10),
        summary,
        attempt: metaMatch?.[6] ? parseInt(metaMatch[6], 10) : undefined,
      });
    }

    // Single-agent format — no `### Agent` sections; one `[subagent …]` header.
    if (agentResults.size === 0) {
      const m = result.content.match(
        /\[subagent provider=(\S+) model=(\S+) type=(\S+) reason=(\w+) input=(\d+) output=(\d+)/,
      );
      if (m) {
        groupProvider = groupProvider ?? m[1];
        groupModel = groupModel ?? m[2];
        const bodyStart = result.content.indexOf('\n', result.content.indexOf(']'));
        const summary = bodyStart >= 0 ? stripTransportMarkers(result.content.slice(bodyStart)) : '';
        agentResults.set(0, {
          provider: m[1],
          model: m[2],
          type: m[3],
          reason: m[4],
          tools: 0,
          input: parseInt(m[5], 10),
          output: parseInt(m[6], 10),
          summary,
        });
      }
    }
  }

  const isCompleted = !!result;
  const parsedInputTotal = Array.from(agentResults.values()).reduce((s, r) => s + r.input, 0);
  const parsedOutputTotal = Array.from(agentResults.values()).reduce((s, r) => s + r.output, 0);
  const headerInputTotal = parseInt(groupUsageMatch?.[1] ?? '0', 10);
  const headerOutputTotal = parseInt(groupUsageMatch?.[2] ?? '0', 10);

  const background = (input as { background?: unknown })?.background === true;

  return {
    groupId: `persisted-${Date.now()}`,
    status: isCompleted ? 'completed' : 'running',
    provider: groupProvider,
    model: groupModel,
    background: background || undefined,
    totalUsage: isCompleted
      ? {
          input_tokens: headerInputTotal || parsedInputTotal,
          output_tokens: headerOutputTotal || parsedOutputTotal,
        }
      : undefined,
    agents: agents.map((a, i) => {
      const raw = a as {
        label?: string;
        task?: string;
        type?: string;
        profile?: string;
        tool_profile?: string;
        research_depth?: string;
        target_tool_calls?: number;
        target_minutes?: number;
      };
      const parsed = agentResults.get(i);
      return {
        index: i,
        label: String(raw.label ?? `Agent ${i + 1}`),
        status: parsed
          ? parsed.reason === 'error'
            ? ('error' as const)
            : ('completed' as const)
          : isCompleted
            ? ('completed' as const)
            : ('pending' as const),
        toolCallCount: parsed?.tools ?? 0,
        provider: parsed?.provider ?? groupProvider,
        model: parsed?.model ?? groupModel,
        usage: parsed ? { input_tokens: parsed.input, output_tokens: parsed.output } : undefined,
        summary: parsed?.summary || undefined,
        error: parsed?.reason === 'error' ? parsed.summary : undefined,
        task: typeof raw.task === 'string' ? raw.task : undefined,
        attempt: parsed?.attempt,
        reason: parsed?.reason,
        researchDepth: ['quick', 'standard', 'deep', 'exhaustive'].includes(raw.research_depth ?? '')
          ? raw.research_depth as 'quick' | 'standard' | 'deep' | 'exhaustive'
          : undefined,
        softToolTarget: typeof raw.target_tool_calls === 'number' ? raw.target_tool_calls : undefined,
        softTimeTargetMs: typeof raw.target_minutes === 'number' ? raw.target_minutes * 60_000 : undefined,
        agentType:
          parsed?.type ??
          (typeof raw.type === 'string'
            ? raw.type
            : typeof raw.profile === 'string'
              ? raw.profile
              : typeof raw.tool_profile === 'string'
                ? raw.tool_profile
                : undefined),
      };
    }),
  };
}
