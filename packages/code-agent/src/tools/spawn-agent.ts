/**
 * spawn_agent — the ONE spawn tool.
 *
 * Replaces the trio:
 *   - spawn_subagent (1 inline)
 *   - spawn_agents   (N parallel, read-only only)
 *   - spawn_agent    (kind dispatcher wrapper)
 *
 * Shape:
 *   spawn_agent({
 *     agents: [
 *       { task, type?, label?, max_turns?, files? },
 *       ...
 *     ],
 *     parallel?: boolean,                // default: auto (true if agents.length>1)
 *     kind?: 'ephemeral' | 'persistent', // default ephemeral
 *     // persistent-only company fields (ignored elsewhere):
 *     role, project_id, provider, model, tier, skills,
 *     kanban_card_id, wait, forward_user_attachments,
 *   })
 *
 * Backward-compat: `task` singular at top level wraps into `agents:[{task}]`.
 *
 * Dispatch rules:
 *   - kind === 'persistent' ALWAYS spawns exactly ONE agent
 *     (parallel persistent makes no sense — each subordinate is its own
 *     coder session). In a Company master session it delegates to
 *     `spawn_subordinate_agent`. Outside Company it falls through to a
 *     single ephemeral implement agent (writes allowed).
 *   - kind === 'ephemeral' with agents.length === 1 → `runSubagent`.
 *   - kind === 'ephemeral' with agents.length  >  1 → `runParallelAgents`.
 *
 * Per-agent `type`:
 *   - 'explore'  (default) — read-only allowlist + non-mutating MCP externos
 *   - 'implement'          — read+write+shell + ALL MCP externos
 *   - 'full'               — no filter (parent registry as-is)
 *
 * Cache: identical (task,type,files) cached for ephemeral single-agent
 * paths only — parallel calls and persistent spawns bypass.
 */
import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolResult, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import {
  runSubagent,
  runParallelAgents,
  countSubagentOutcomes,
  extractLastAssistantText,
  emptyCollected,
  type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import { renderCollectedSnapshotForParent } from '@mcp/code-agent/tools/subagent-collector.js';
import {
  renderSingleHeader,
  renderSingleBody,
  renderTrail,
  renderParallelHeader,
  renderParallelBody,
  renderResumeHint,
} from '@mcp/code-agent/tools/spawn-agent-render.js';
import { retainSpawnGroup, countFailed } from '@mcp/code-agent/tools/spawn-agent-resume.js';
import {
  type NormalizedAgent,
  limitsForAgent,
  buildSubagentWorkspaceBriefing,
  taskWithWorkspaceBriefing,
  toRetentionAgent,
  prepareAgentsForDispatch,
  systemPromptForAgent,
} from '@mcp/code-agent/tools/spawn-agent-core.js';
import { runBackgroundEphemeral } from '@mcp/code-agent/tools/spawn-agent-background.js';
import { captureInvestigation } from '@mcp/code-agent/tools/investigation-capture.js';
import {
  describeProvider,
  type SubagentDeps,
} from '@mcp/code-agent/tools/subagent.js';
import { providerForProfile, effortForProfile } from '@mcp/code-agent/tools/subagent-provider.js';
import {
  MICRO_AGENT_PROFILE_NAMES,
  MICRO_AGENT_PROFILES,
  resolveMicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import {
  RESEARCH_DEPTHS,
  buildResearchPolicy,
  normalizeResearchDepth,
  researchPolicyCacheKey,
} from '@mcp/code-agent/tools/subagent-research-policy.js';

// Re-exported for callers/tests that import it from spawn-agent.js (moved to
// spawn-agent-core.js to break the spawn ↔ background import cycle).
export { buildSubagentWorkspaceBriefing };
import {
  isGlobalSubAgentCacheEnabled,
  tryGlobalSubAgentRead,
  writeGlobalSubAgentResult,
} from '@mcp/services/sub-agent-cache/index.js';

const SPAWN_AGENT_DESC =
  'Spawn one or more agents to run a task in a dedicated context window. ' +
  'Pass a single-element `agents` array for sequential; multiple to run in parallel (auto, up to 8). ' +
  'Each agent returns only its final summary — intermediate tool results NEVER enter your history. ' +
  'Token cost IS counted in this session.\n' +
  'For investigator/reviewer agents, `research_depth` controls breadth without imposing a hard stop: ' +
  'quick, standard (default), deep, or exhaustive. Use exhaustive only when the user explicitly asks for complete coverage.\n' +
  '\n' +
  'Per-agent `profile` controls the specialized toolset:\n' +
  '  - "explore" / "investigator" (default): read-only investigation + non-mutating MCPs. Cheap.\n' +
  '  - "implement" / "implementer": scoped writes + shell + external MCPs.\n' +
  '  - "verify" / "verifier": shell + diagnostics for tests/linters, no writes.\n' +
  '  - "review" / "reviewer": read-only bug/regression/security review.\n' +
  '  - "full": no filter, inherits the parent\'s exact toolset.\n' +
  '\n' +
  'USE: when a task needs many tool calls whose outputs would pollute your context.\n' +
  'USE: with multiple agents to investigate independent topics in parallel.\n' +
  'USE: `background:true` for long, independent work — it returns a job id IMMEDIATELY so you keep working; ' +
  'you get a <system-reminder> when it finishes, or fetch results early with collect_agents({job_id}).\n' +
  'USE: `kind:"persistent"` inside a company master session for a full coder subordinate (kanban/board/wait).\n' +
  "DON'T: use implement for read-only work — explore is cheaper.\n" +
  "DON'T: re-spawn a FAILED agent from scratch — resume_agent({spawn_id}) continues it with its progress intact.\n" +
  "DON'T: use persistent for one-shot exploration — default ephemeral fits.";

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAgents(args: Record<string, unknown>): { agents: NormalizedAgent[]; error: string | null } {
  const fallbackProfile = MICRO_AGENT_PROFILES.explore;

  // Backward-compat path: top-level `task` (singular) → wrap in agents:[{}].
  let rawList: unknown[];
  if (Array.isArray(args.agents)) {
    rawList = args.agents as unknown[];
  } else if (typeof args.task === 'string' && args.task.trim()) {
    rawList = [{
      task: args.task,
      profile: args.profile,
      tool_profile: args.tool_profile,
      type: args.type,
      label: args.label,
      max_turns: args.max_turns,
      files: args.files,
      research_depth: args.research_depth,
      target_minutes: args.target_minutes,
      target_tool_calls: args.target_tool_calls,
      completion_criteria: args.completion_criteria,
    }];
  } else {
    return { agents: [], error: 'spawn_agent: provide `agents` array OR top-level `task` (singular).' };
  }
  if (rawList.length === 0) return { agents: [], error: 'spawn_agent: `agents` must not be empty.' };
  if (rawList.length > 8) return { agents: [], error: 'spawn_agent: at most 8 agents per call.' };

  const out: NormalizedAgent[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i] as Record<string, unknown>;
    const task = typeof raw.task === 'string' ? raw.task.trim() : '';
    if (!task) return { agents: [], error: `spawn_agent: agent[${i}].task is required and non-empty.` };
    const profileName = rawString(raw.profile) ?? rawString(raw.tool_profile) ?? rawString(raw.type);
    const profile = profileName ? resolveMicroAgentProfile(profileName) : fallbackProfile;
    if (!profile) {
      return {
        agents: [],
        error:
          `spawn_agent: agent[${i}].profile='${profileName}' invalid - use one of: ` +
          MICRO_AGENT_PROFILE_NAMES.join(', '),
      };
    }
    const label = typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : `${profile.defaultLabel}-${i + 1}`;
    const max_turns = typeof raw.max_turns === 'number' && Number.isFinite(raw.max_turns)
      ? raw.max_turns
      : 0;
    const files = Array.isArray(raw.files)
      ? (raw.files as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0)
      : undefined;
    const requestedDepth = rawString(raw.research_depth);
    const explicitDepth = normalizeResearchDepth(requestedDepth);
    if (requestedDepth && !explicitDepth) {
      return {
        agents: [],
        error: `spawn_agent: agent[${i}].research_depth='${requestedDepth}' invalid - use one of: ${RESEARCH_DEPTHS.join(', ')}`,
      };
    }
    const readSoftNumber = (key: 'target_minutes' | 'target_tool_calls'): number | undefined | null => {
      if (raw[key] == null) return undefined;
      return typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0
        ? raw[key] as number
        : null;
    };
    const targetMinutes = readSoftNumber('target_minutes');
    const targetToolCalls = readSoftNumber('target_tool_calls');
    if (targetMinutes === null || targetToolCalls === null) {
      return { agents: [], error: `spawn_agent: agent[${i}] soft targets must be finite non-negative numbers.` };
    }
    const completionCriteria = Array.isArray(raw.completion_criteria)
      ? raw.completion_criteria.filter((value): value is string => typeof value === 'string')
      : undefined;
    const researchPolicy = profile.capability === 'explore' || profile.capability === 'review'
      ? buildResearchPolicy({
          task,
          explicitDepth,
          targetMinutes,
          targetToolCalls,
          completionCriteria,
        })
      : undefined;
    out.push({
      task,
      type: profile.capability,
      profile,
      label,
      maxTurns: Math.max(0, Math.floor(max_turns)),
      files,
      researchPolicy,
    });
  }
  return { agents: out, error: null };
}

function renderParallelProfilePrompts(agents: NormalizedAgent[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const agent of agents) {
    const key = `${agent.profile.id}:${researchPolicyCacheKey(agent.researchPolicy)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`# ${agent.profile.id} (${agent.researchPolicy?.depth ?? 'no research contract'})\n${systemPromptForAgent(agent)}`);
  }
  return parts.join('\n\n---\n\n');
}

async function runSingleEphemeral(
  deps: SubagentDeps,
  agent: NormalizedAgent,
  ctx: ToolContext,
): Promise<ToolResult> {
  const activeProvider = await providerForProfile(deps, agent.profile);
  const providerInfo = describeProvider(activeProvider);
  const parentSessionId = ctx.runner?.sessionId;
  const spawnId = randomUUID().slice(0, 8);
  console.log(
    `[coder s=${parentSessionId ?? '?'}] spawn_agent: type=${agent.type} provider=${providerInfo.label} ` +
    `max_turns=${agent.maxTurns} research=${agent.researchPolicy?.depth ?? 'n/a'} spawn=${spawnId}` +
    `${agent.files ? ` files=[${agent.files.join(', ')}]` : ''}`,
  );

  const cacheKeyInput = {
    prompt: agent.task,
    agentType: agent.type === 'explore' ? 'Explore' as const : 'general-purpose' as const,
    recentMutations: [
      ...(agent.files ?? []),
      `profile:${agent.profile.id}`,
      researchPolicyCacheKey(agent.researchPolicy),
    ],
  };
  if (isGlobalSubAgentCacheEnabled()) {
    const hit = tryGlobalSubAgentRead<{
      header: string;
      body: string;
      usage: import('@mcp/code-agent/core/messages.js').ChatUsage;
    }>(cacheKeyInput, { sessionId: parentSessionId });
    if (hit) {
      console.log(
        `[coder s=${parentSessionId ?? '?'}] spawn_agent: CACHE HIT type=${agent.type} ` +
        `ageMs=${hit.ageMs} hitCount=${hit.hitCount}`,
      );
      return {
        ...ok(`[cache-hit ageMs=${hit.ageMs} hits=${hit.hitCount}]\n\n` + hit.result.header + hit.result.body),
        subUsage: hit.result.usage,
      };
    }
  }

  if (deps.sessionStore && parentSessionId != null) {
    try {
      deps.sessionStore.recordSessionInput({
        session_id: parentSessionId,
        kind: 'subagent_prompt',
        source_label: `subagent:${agent.profile.id}`,
        content: systemPromptForAgent(agent),
        meta: {
          task: agent.task,
          max_turns: agent.maxTurns,
          files: agent.files,
          profile: agent.profile.id,
          research_depth: agent.researchPolicy?.depth,
          research_source: agent.researchPolicy?.source,
          soft_tool_target: agent.researchPolicy?.softToolTarget,
          soft_time_target_ms: agent.researchPolicy?.softTimeTargetMs,
          completion_criteria: agent.researchPolicy?.completionCriteria,
        },
      });
    } catch { /* best-effort */ }
  }

  const initialMessages: AgentMessage[] = [{
    role: 'user',
    content: [{ type: 'text', text: taskWithWorkspaceBriefing(agent.task, ctx) }],
  }];
  const result = await runSubagent(
    {
      provider: activeProvider,
      tools: deps.parentTools,
      ctx,
      sessionId: parentSessionId,
      sessionStore: deps.sessionStore,
      agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
      toolSelectionFilter: deps.toolSelectionFilter,
      externalToolTiers: deps.externalToolTiers,
    },
    {
      label: agent.label,
      profile: agent.profile.id,
      spawnId,
      reasoningEffort: effortForProfile(deps, agent.profile),
      systemPrompt: systemPromptForAgent(agent),
      researchPolicy: agent.researchPolicy,
      allowlist: agent.profile.allowlist,
      initialMessages,
      maxTurns: agent.maxTurns,
      pathScope: agent.profile.pathScopeMode === 'enforce-writes' && agent.files && agent.files.length > 0
        ? agent.files
        : undefined,
      pathScopeMode: agent.profile.pathScopeMode,
      limits: limitsForAgent(agent),
    },
  );

  const header = renderSingleHeader(providerInfo, agent.type, result.reason, result.usage, spawnId);
  const body = renderSingleBody(result.finalText, result.reason);
  // Frente C — append the sub's structured trail (memos / snapshots /
  // board posts) so the master sees what the sub explicitly flagged for
  // it. Empty when the sub didn't emit anything → no-op concat.
  const trail = renderTrail(result.collected);

  // Only COMPLETED runs are cacheable: watchdog failures produce a non-empty
  // salvage summary, and caching that would replay the failure to every
  // later identical spawn.
  if (isGlobalSubAgentCacheEnabled() && result.finalText && result.reason === 'completed') {
    writeGlobalSubAgentResult(cacheKeyInput, { header, body, usage: result.usage }, { sessionId: parentSessionId });
  }
  // Persist a durable digest into the investigation ledger (non-company).
  captureInvestigation(deps, ctx, agent, result.finalText ?? '', trail, result.usage.input_tokens + result.usage.output_tokens);
  void extractLastAssistantText; // keep helper referenced for re-exports

  // Retain for resume_agent (failed → transcript kept, hint appended).
  retainSpawnGroup({
    sessionId: parentSessionId,
    spawnId,
    provider: providerInfo.provider,
    model: providerInfo.model,
    agents: [toRetentionAgent(0, agent, result)],
  });
  const hint = result.reason !== 'completed' ? renderResumeHint(spawnId, 1) : '';
  return { ...ok(header + body + trail + hint), subUsage: result.usage };
}

async function runParallelEphemeral(
  deps: SubagentDeps,
  agents: NormalizedAgent[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const parentSessionId = ctx.runner?.sessionId;
  const groupId = randomUUID().slice(0, 8);
  // Resolve each agent's provider from its profile (memoized in the resolver,
  // so same-profile agents in the batch reuse one provider; a profile that
  // inherits falls back to the parent provider).
  const agentProviders = await Promise.all(
    agents.map((a) => providerForProfile(deps, a.profile)),
  );
  const agentInfos = agentProviders.map((p) => describeProvider(p));
  // Representative label for batch-level summaries (header/retention). When the
  // batch mixes providers, show them joined instead of one misleading value.
  const distinctLabels = [...new Set(agentInfos.map((info) => info.label))];
  const headInfo = distinctLabels.length <= 1
    ? (agentInfos[0] ?? describeProvider(deps.provider))
    : { provider: 'mixed', model: distinctLabels.join(', '), label: distinctLabels.join(', ') };
  console.log(
    `[coder s=${parentSessionId ?? '?'}] spawn_agent: ${agents.length} parallel ` +
    `providers=[${distinctLabels.join(', ')}] labels=[${agents.map((a) => a.label).join(', ')}] group=${groupId}`,
  );

  ctx.runner?.emit('agents_group_start', {
    groupId,
    provider: agentInfos[0]?.provider,
    model: agentInfos[0]?.model,
    agents: agents.map((a, i) => ({
      index: i,
      label: a.label,
      provider: agentInfos[i]?.provider,
      model: agentInfos[i]?.model,
      task: a.task,
      researchDepth: a.researchPolicy?.depth,
      softToolTarget: a.researchPolicy?.softToolTarget,
      softTimeTargetMs: a.researchPolicy?.softTimeTargetMs,
    })),
  });

  if (deps.sessionStore && parentSessionId != null) {
    try {
      deps.sessionStore.recordSessionInput({
        session_id: parentSessionId,
        kind: 'subagent_prompt',
        source_label: `subagent:parallel:${groupId}`,
        content: renderParallelProfilePrompts(agents),
        meta: {
          group_id: groupId,
          agent_count: agents.length,
          labels: agents.map((a) => a.label),
          types: agents.map((a) => a.type),
          profiles: agents.map((a) => a.profile.id),
          research_depths: agents.map((a) => a.researchPolicy?.depth ?? null),
        },
      });
    } catch { /* best-effort */ }
  }

  const specs: ParallelAgentSpec[] = agents.map((a, i) => ({
    task: taskWithWorkspaceBriefing(a.task, ctx),
    label: a.label,
    maxTurns: a.maxTurns,
    profile: a.profile.id,
    provider: agentProviders[i],
    reasoningEffort: effortForProfile(deps, a.profile),
    spawnId: groupId,
    systemPrompt: systemPromptForAgent(a),
    researchPolicy: a.researchPolicy,
    allowlist: a.profile.allowlist,
    pathScope: a.profile.pathScopeMode === 'enforce-writes' && a.files && a.files.length > 0
      ? a.files
      : undefined,
    pathScopeMode: a.profile.pathScopeMode,
    limits: limitsForAgent(a),
  }));

  const { results, totalUsage } = await runParallelAgents(
    {
      provider: deps.provider,
      tools: deps.parentTools,
      ctx,
      sessionId: parentSessionId,
      sessionStore: deps.sessionStore,
      agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
      toolSelectionFilter: deps.toolSelectionFilter,
      externalToolTiers: deps.externalToolTiers,
    },
    specs,
    MICRO_AGENT_PROFILES.explore.systemPrompt,
    MICRO_AGENT_PROFILES.explore.allowlist,
    (progress) => {
      const info = agentInfos[progress.agentIndex] ?? headInfo;
      ctx.runner?.emit('agent_progress', {
        groupId,
        provider: info.provider,
        model: info.model,
        ...progress,
      });
    },
  );

  const header = renderParallelHeader(results.length, headInfo, totalUsage, groupId);
  const body = renderParallelBody(results.map((r, i) => ({
    label: r.label,
    type: agents[i].type,
    reason: r.reason,
    toolCallCount: r.toolCallCount,
    usage: r.usage,
    finalText: r.finalText,
    collected: r.collected,
  })));

  // Persist each sub-agent's digest into the investigation ledger (non-company).
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const trail = renderCollectedSnapshotForParent(r.collected ?? emptyCollected());
    captureInvestigation(deps, ctx, agents[i], r.finalText ?? '', trail, r.usage.input_tokens + r.usage.output_tokens);
  }

  // Retain for resume_agent — spawnId is the groupId so UI rows patch on resume.
  const resumableCount = retainSpawnGroup({
    sessionId: parentSessionId,
    spawnId: groupId,
    provider: headInfo.provider,
    model: headInfo.model,
    agents: results.map((r, i) => ({
      ...toRetentionAgent(i, agents[i], r),
      toolCallCount: r.toolCallCount,
    })),
  });
  const outcomeCounts = countSubagentOutcomes(results);
  ctx.runner?.emit('agents_group_end', {
    groupId,
    totalUsage,
    agentCount: results.length,
    successCount: outcomeCounts.completedCount,
    ...outcomeCounts,
    resumableCount,
  });
  const failed = countFailed(results);
  const hint = failed > 0 ? renderResumeHint(groupId, failed) : '';
  return { ...ok(header + body + hint), subUsage: totalUsage };
}

async function runPersistent(
  registry: ToolRegistry,
  args: Record<string, unknown>,
  agent: NormalizedAgent,
  ctx: ToolContext,
): Promise<ToolResult> {
  // In a Company master session, persistent → spawn_subordinate_agent.
  const masterSpawn = registry.get('spawn_subordinate_agent');
  if (masterSpawn) {
    const role = typeof args.role === 'string' ? args.role.trim() : '';
    if (!role) return err('spawn_agent: in a Company master session, kind="persistent" requires `role`.');
    return await registry.invoke('spawn_subordinate_agent', {
      role,
      task: agent.task,
      project_id: args.project_id,
      provider: args.provider,
      model: args.model,
      tier: args.tier,
      skills: args.skills,
      kanban_card_id: args.kanban_card_id,
      wait: args.wait,
      forward_user_attachments: args.forward_user_attachments,
    }, ctx);
  }
  // Outside Company: fall through to a single inline implement agent.
  return runSingleEphemeral({ provider: ctx.runner?.provider as never, parentTools: [] } as never, agent, ctx);
}

export function buildSpawnAgentTool(registry: ToolRegistry): CoderTool;
export function buildSpawnAgentTool(deps: SubagentDeps, registry: ToolRegistry): CoderTool;
export function buildSpawnAgentTool(depsOrRegistry: SubagentDeps | ToolRegistry, maybeRegistry?: ToolRegistry): CoderTool {
  const registry = maybeRegistry ?? (depsOrRegistry as ToolRegistry);
  const deps = maybeRegistry
    ? depsOrRegistry as SubagentDeps
    : ({ provider: undefined as never, parentTools: [] } as SubagentDeps);

  // Persistent (Company subordinate) spawns delegate to spawn_subordinate_agent,
  // which is registered ONLY in a Company master session. When it's absent the
  // persistent path is unreachable, so its 9 config fields are pure dead weight
  // in the schema — omit them. Registration is fixed for the whole run, so the
  // serialized tool bytes stay stable for the prompt cache.
  const includePersistent = !!registry.get('spawn_subordinate_agent');
  return {
    name: 'spawn_agent',
    description: maybeTerse(SPAWN_AGENT_DESC),
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          description: 'List of agents to spawn. 1 item runs sequentially; 2+ run in parallel (auto).',
          items: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'Self-contained task description for this agent.' },
              profile: {
                type: 'string',
                enum: MICRO_AGENT_PROFILE_NAMES,
                description:
                  'Named micro-agent profile. Prefer investigator/verifier/reviewer/implementer/full for specialized toolsets.',
              },
              tool_profile: {
                type: 'string',
                enum: MICRO_AGENT_PROFILE_NAMES,
                description: 'Alias for profile, accepted for callers that describe tool capability explicitly.',
              },
              type: {
                type: 'string',
                enum: ['explore', 'implement', 'full', 'verify', 'review'],
                description: 'Backward-compatible alias for profile. Prefer profile/tool_profile for named specializations.',
              },
              label: { type: 'string', description: 'Short UI label shown in parallel mode (3-5 words).' },
              max_turns: {
                type: 'number',
                description: 'Optional exact turn cap. Omit or use 0 for unlimited (default); set a positive value only when an operator requested a cap.',
              },
              research_depth: {
                type: 'string',
                enum: RESEARCH_DEPTHS,
                description: 'Investigator/reviewer breadth: quick, standard (default), deep, or exhaustive. Soft guidance, not a hard limit.',
              },
              target_minutes: {
                type: 'number',
                description: 'Optional soft synthesis target in minutes for investigator/reviewer. Reaching it nudges a summary; 0 disables the time nudge.',
              },
              target_tool_calls: {
                type: 'number',
                description: 'Optional soft synthesis target in tool calls for investigator/reviewer. Reaching it nudges a summary; 0 disables the call nudge.',
              },
              completion_criteria: {
                type: 'array',
                items: { type: 'string' },
                description: 'Concrete evidence requirements. When satisfied, the agent must summarize instead of widening the search.',
              },
              files: { type: 'array', items: { type: 'string' }, description: 'Implement profile: paths the agent may write to.' },
            },
            required: ['task'],
          },
          minItems: 1,
          maxItems: 8,
        },
        parallel: { type: 'boolean', description: 'Force parallel/sequential. Default: parallel when agents.length > 1.' },
        background: { type: 'boolean', description: 'Fire-and-forget: return immediately with a job id and keep working; fetch results later with collect_agents. Use for long, independent work. Default false (blocks until done).' },
        kind: { type: 'string', enum: ['ephemeral', 'persistent'], description: 'Default "ephemeral". "persistent" needs Company master (uses spawn_subordinate_agent under the hood).' },
        // Persistent-only Company fields — surfaced only in a master session
        // (see includePersistent). Unreachable/ignored elsewhere. The handler
        // still reads the legacy single-agent shortcut (task/type/max_turns/
        // files) via normalizeAgents, so old callers keep working; they're just
        // no longer advertised — `agents:[{...}]` is the one documented shape.
        ...(includePersistent
          ? {
              role: { type: 'string', description: 'Persistent only — required inside Company master.' },
              project_id: { type: 'number', description: 'Persistent only.' },
              provider: { type: 'string', description: 'Persistent only.' },
              model: { type: 'string', description: 'Persistent only.' },
              tier: { type: 'string', enum: ['bootstrap', 'navigate', 'full'], description: 'Persistent only.' },
              skills: { type: 'array', items: { type: 'string' }, description: 'Persistent only.' },
              kanban_card_id: { type: 'number', description: 'Persistent only.' },
              wait: { type: 'boolean', description: 'Persistent only.' },
              forward_user_attachments: { type: 'boolean', description: 'Persistent only.' },
            }
          : {}),
      },
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const normalized = normalizeAgents(args);
      let agents = normalized.agents;
      const { error } = normalized;
      if (error) return err(error);

      const kind = typeof args.kind === 'string' ? args.kind : 'ephemeral';
      if (kind !== 'ephemeral' && kind !== 'persistent') {
        return err(`spawn_agent: kind='${kind}' invalid — must be 'ephemeral' or 'persistent'.`);
      }

      if (kind === 'ephemeral') agents = prepareAgentsForDispatch(agents, ctx);

      if (kind === 'persistent') {
        if (agents.length > 1) {
          return err('spawn_agent: kind="persistent" supports only ONE agent (parallel persistent is undefined — each subordinate has its own session).');
        }
        return runPersistent(registry, args, agents[0], ctx);
      }

      // Background (fire-and-forget) — returns immediately with a job id.
      // Ephemeral only; results fetched via collect_agents.
      if (args.background === true) {
        return runBackgroundEphemeral(deps, agents, ctx);
      }

      const parallel = typeof args.parallel === 'boolean' ? args.parallel : agents.length > 1;
      if (parallel && agents.length > 1) {
        return runParallelEphemeral(deps, agents, ctx);
      }
      // Sequential — if user forced parallel=false with N agents, run one at a time and concat.
      if (agents.length === 1) return runSingleEphemeral(deps, agents[0], ctx);
      const parts: string[] = [];
      let totalIn = 0, totalOut = 0;
      for (const a of agents) {
        const r = await runSingleEphemeral(deps, a, ctx);
        parts.push(typeof r.content === 'string' ? r.content : '');
        if (r.subUsage) { totalIn += r.subUsage.input_tokens; totalOut += r.subUsage.output_tokens; }
      }
      return {
        ...ok(`[sequential agents: ${agents.length}, input=${totalIn} output=${totalOut}]\n\n` + parts.join('\n\n---\n\n')),
        subUsage: { input_tokens: totalIn, output_tokens: totalOut },
      };
    },
  };
}
