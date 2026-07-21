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
  toolUseId?: string,
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
    maxTools?: number;
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
        /\[type=(\S+)(?:\s+profile=\S+)?\s+reason=(\w+)\s+tools=(\d+)\s+input=(\d+)\s+output=(\d+)(?:\s+attempt=(\d+))?(?:\s+max_tools=(\d+))?\]/,
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
        maxTools: metaMatch?.[7] ? parseInt(metaMatch[7], 10) : undefined,
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
        const singleMax = result.content.match(/\[subagent [^\]]*\bmax_tools=(\d+)/);
        agentResults.set(0, {
          provider: m[1],
          model: m[2],
          type: m[3],
          reason: m[4],
          tools: 0,
          input: parseInt(m[5], 10),
          output: parseInt(m[6], 10),
          summary,
          maxTools: singleMax ? parseInt(singleMax[1], 10) : undefined,
        });
      }
    }
  }

  const backgroundStartMatch = result?.content?.match(
    /^\[spawn_agent background\]\s+job=(\S+)\s+group=(\S+)\s+agents=\d+\b.*\sstarted\./m,
  );
  const persistedGroupId = backgroundStartMatch?.[2]
    ?? result?.content?.match(/\[parallel agents:[^\]]*\bgroup=([^,\s\]]+)/)?.[1]
    ?? result?.content?.match(/\[subagent [^\]]*\bspawn=([^\s\]]+)/)?.[1];
  // A background spawn persists an immediate tool_result saying only that the
  // job started. It is not a terminal agent report and must remain running.
  const isBackgroundStart = Boolean(backgroundStartMatch);
  const isCompleted = !!result && !isBackgroundStart;
  const parsedInputTotal = Array.from(agentResults.values()).reduce((s, r) => s + r.input, 0);
  const parsedOutputTotal = Array.from(agentResults.values()).reduce((s, r) => s + r.output, 0);
  const headerInputTotal = parseInt(groupUsageMatch?.[1] ?? '0', 10);
  const headerOutputTotal = parseInt(groupUsageMatch?.[2] ?? '0', 10);

  const background = (input as { background?: unknown })?.background === true;

  return {
    groupId: persistedGroupId ?? stablePersistedGroupId(input, toolUseId),
    toolUseId,
    status: isCompleted ? 'completed' : 'running',
    provider: groupProvider,
    model: groupModel,
    background: background || undefined,
    jobId: backgroundStartMatch?.[1],
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
          ? statusFromPersistedReason(parsed.reason)
          : isCompleted
            ? result?.isError
              ? ('error' as const)
              : ('completed' as const)
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
        maxToolCalls: parsed?.maxTools,
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

function statusFromPersistedReason(reason: string) {
  if (reason === 'completed') return 'completed' as const;
  if (reason === 'aborted') return 'aborted' as const;
  if (reason === 'timed_out' || reason === 'timeout' || reason === 'stalled') return 'timed_out' as const;
  if (reason === 'tool_budget' || reason === 'time_budget' || reason === 'max_turns') return 'partial' as const;
  return 'error' as const;
}

function stablePersistedGroupId(
  input: Record<string, unknown> | undefined,
  toolUseId: string | undefined,
): string {
  if (toolUseId) return `persisted-${toolUseId}`;
  let source = '';
  try {
    source = JSON.stringify(input ?? {});
  } catch {
    source = String(input ?? 'spawn-agent');
  }
  // Small deterministic FNV-1a hash. This is a renderer identity fallback for
  // legacy rows without tool_use ids, not a security primitive.
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `persisted-legacy-${(hash >>> 0).toString(16)}`;
}
