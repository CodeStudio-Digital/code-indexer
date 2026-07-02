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
  extractLastAssistantText,
  emptyCollected,
  type SubagentLimits,
  type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import { renderCollectedSnapshotForParent } from '@mcp/code-agent/tools/subagent-collector.js';
import { getInvestigationEmbedder } from '@mcp/code-agent/tools/investigation-embedder.js';
import {
  describeProvider,
  type SubagentDeps,
} from '@mcp/code-agent/tools/subagent.js';
import {
  MICRO_AGENT_PROFILE_NAMES,
  MICRO_AGENT_PROFILES,
  resolveMicroAgentProfile,
  type MicroAgentCapability,
  type MicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
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
  'USE: `kind:"persistent"` inside a company master session for a full coder subordinate (kanban/board/wait).\n' +
  "DON'T: use implement for read-only work — explore is cheaper.\n" +
  "DON'T: use persistent for one-shot exploration — default ephemeral fits.";

interface NormalizedAgent {
  task: string;
  type: MicroAgentCapability;
  profile: MicroAgentProfile;
  label: string;
  maxTurns: number;
  files?: string[];
}

const SPAWN_LIMITS: Record<MicroAgentCapability, Required<SubagentLimits>> = {
  explore: {
    // `maxToolCalls` is a budget of tool *CALLS* (invocations), NOT the number
    // of tools available (the env name is kept for back-compat). Default 0 =
    // unlimited (codex-style): explore is read-only, so we let it run until it
    // concludes or trips the time/turn/stall guards below — instead of cutting
    // an in-flight investigation short. Set the env to a positive N to re-cap.
    maxToolCalls: Number(process.env.CODER_SPAWN_EXPLORE_MAX_TOOLS ?? 0) || 0,
    timeoutMs: Number(process.env.CODER_SPAWN_EXPLORE_TIMEOUT_MS ?? 10 * 60_000) || 10 * 60_000,
    stallMs: Number(process.env.CODER_SPAWN_EXPLORE_STALL_MS ?? 90_000) || 90_000,
  },
  implement: {
    maxToolCalls: Number(process.env.CODER_SPAWN_IMPLEMENT_MAX_TOOLS ?? 80) || 80,
    timeoutMs: Number(process.env.CODER_SPAWN_IMPLEMENT_TIMEOUT_MS ?? 20 * 60_000) || 20 * 60_000,
    stallMs: Number(process.env.CODER_SPAWN_IMPLEMENT_STALL_MS ?? 120_000) || 120_000,
  },
  verify: {
    maxToolCalls: Number(process.env.CODER_SPAWN_VERIFY_MAX_TOOLS ?? 40) || 40,
    timeoutMs: Number(process.env.CODER_SPAWN_VERIFY_TIMEOUT_MS ?? 15 * 60_000) || 15 * 60_000,
    stallMs: Number(process.env.CODER_SPAWN_VERIFY_STALL_MS ?? 120_000) || 120_000,
  },
  review: {
    maxToolCalls: Number(process.env.CODER_SPAWN_REVIEW_MAX_TOOLS ?? 40) || 40,
    timeoutMs: Number(process.env.CODER_SPAWN_REVIEW_TIMEOUT_MS ?? 15 * 60_000) || 15 * 60_000,
    stallMs: Number(process.env.CODER_SPAWN_REVIEW_STALL_MS ?? 120_000) || 120_000,
  },
  full: {
    maxToolCalls: Number(process.env.CODER_SPAWN_FULL_MAX_TOOLS ?? 80) || 80,
    timeoutMs: Number(process.env.CODER_SPAWN_FULL_TIMEOUT_MS ?? 20 * 60_000) || 20 * 60_000,
    stallMs: Number(process.env.CODER_SPAWN_FULL_STALL_MS ?? 120_000) || 120_000,
  },
};

function limitsForAgent(agent: NormalizedAgent): SubagentLimits {
  return SPAWN_LIMITS[agent.type];
}

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeAgents(args: Record<string, unknown>): { agents: NormalizedAgent[]; error: string | null } {
  const MIN_TURNS = 50;
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
    const max_turns = typeof raw.max_turns === 'number' ? raw.max_turns : 100;
    const files = Array.isArray(raw.files)
      ? (raw.files as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0)
      : undefined;
    out.push({
      task,
      type: profile.capability,
      profile,
      label,
      maxTurns: Math.max(MIN_TURNS, max_turns),
      files,
    });
  }
  return { agents: out, error: null };
}

/**
 * Auto-capture a finished sub-agent's digest into the project-scoped
 * investigation ledger (migration 126) so a later session can
 * `recall_investigations` it instead of re-running the same explore — and
 * so the `record_memo` trail (which is otherwise discarded after the parent
 * reads it) gets a durable home. Best-effort; never throws. Skipped in
 * company sessions (they have the shared drive) and when the sub produced
 * no summary.
 */
function captureInvestigation(
  deps: SubagentDeps,
  ctx: ToolContext,
  agent: NormalizedAgent,
  finalText: string,
  trail: string,
  tokens: number,
): void {
  if (ctx.companyContext) return;
  const sessionId = ctx.runner?.sessionId;
  if (!deps.sessionStore || sessionId == null || !finalText.trim()) return;
  try {
    const topic = agent.task.slice(0, 300);
    const summary = finalText.slice(0, 1000);
    const row = deps.sessionStore.recordInvestigation({
      session_id: sessionId,
      topic,
      summary,
      body: `${finalText}${trail}`.slice(0, 20000),
      source_label: agent.label,
      agent_type: agent.type,
      tokens,
    });
    // Live-update the Drive panel.
    ctx.runner?.emit('session_drive_changed', { kind: 'investigation' });
    // Semantic recall: embed the digest in the background (in-process only;
    // worker mode / no embedder → keyword recall still works). Fire-and-forget
    // so the spawn result isn't blocked on a network/CPU round-trip.
    const embed = getInvestigationEmbedder();
    if (embed) {
      void embed(`${topic}\n${summary}`)
        .then((vec) => {
          if (vec && vec.length > 0 && vec.some((x) => x !== 0)) {
            deps.sessionStore!.setInvestigationEmbedding(row.id, vec);
          }
        })
        .catch(() => { /* embedding is best-effort */ });
    }
  } catch (e) {
    console.warn(`[coder] captureInvestigation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function renderParallelProfilePrompts(agents: NormalizedAgent[]): string {
  const seen = new Set<MicroAgentProfile['id']>();
  const parts: string[] = [];
  for (const agent of agents) {
    if (seen.has(agent.profile.id)) continue;
    seen.add(agent.profile.id);
    parts.push(`# ${agent.profile.id}\n${agent.profile.systemPrompt}`);
  }
  return parts.join('\n\n---\n\n');
}

async function runSingleEphemeral(
  deps: SubagentDeps,
  agent: NormalizedAgent,
  ctx: ToolContext,
): Promise<ToolResult> {
  const activeProvider = deps.subagentProvider ?? deps.provider;
  const providerInfo = describeProvider(activeProvider);
  const parentSessionId = ctx.runner?.sessionId;
  console.log(
    `[coder s=${parentSessionId ?? '?'}] spawn_agent: type=${agent.type} provider=${providerInfo.label} ` +
    `max_turns=${agent.maxTurns}${agent.files ? ` files=[${agent.files.join(', ')}]` : ''}`,
  );

  const cacheKeyInput = {
    prompt: agent.task,
    agentType: agent.type === 'explore' ? 'Explore' as const : 'general-purpose' as const,
    recentMutations: [...(agent.files ?? []), `profile:${agent.profile.id}`],
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
        content: agent.profile.systemPrompt,
        meta: {
          task: agent.task,
          max_turns: agent.maxTurns,
          files: agent.files,
          profile: agent.profile.id,
        },
      });
    } catch { /* best-effort */ }
  }

  const initialMessages: AgentMessage[] = [{ role: 'user', content: [{ type: 'text', text: agent.task }] }];
  const result = await runSubagent(
    {
      provider: activeProvider,
      tools: deps.parentTools,
      ctx,
      sessionId: parentSessionId,
      agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
    },
    {
      label: agent.label,
      systemPrompt: agent.profile.systemPrompt,
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

  const cached = result.usage.cache_read_input_tokens ?? 0;
  const header =
    `[subagent provider=${providerInfo.provider} model=${providerInfo.model} type=${agent.type} ` +
    `reason=${result.reason} input=${result.usage.input_tokens} output=${result.usage.output_tokens} cache_hit=${cached}]\n\n`;
  const body = result.finalText
    || `(subagent did not produce a final summary — reason=${result.reason}. Retry with narrower scope or investigate directly.)`;
  // Frente C — append the sub's structured trail (memos / snapshots /
  // board posts) so the master sees what the sub explicitly flagged for
  // it. Empty when the sub didn't emit anything → no-op concat.
  const trail = renderCollectedSnapshotForParent(result.collected ?? emptyCollected());

  if (isGlobalSubAgentCacheEnabled() && result.finalText) {
    writeGlobalSubAgentResult(cacheKeyInput, { header, body, usage: result.usage }, { sessionId: parentSessionId });
  }
  // Persist a durable digest into the investigation ledger (non-company).
  captureInvestigation(deps, ctx, agent, result.finalText ?? '', trail, result.usage.input_tokens + result.usage.output_tokens);
  void extractLastAssistantText; // keep helper referenced for re-exports
  return { ...ok(header + body + trail), subUsage: result.usage };
}

async function runParallelEphemeral(
  deps: SubagentDeps,
  agents: NormalizedAgent[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const activeProvider = deps.subagentProvider ?? deps.provider;
  const providerInfo = describeProvider(activeProvider);
  const parentSessionId = ctx.runner?.sessionId;
  const groupId = randomUUID().slice(0, 8);
  console.log(
    `[coder s=${parentSessionId ?? '?'}] spawn_agent: ${agents.length} parallel ` +
    `provider=${providerInfo.label} labels=[${agents.map((a) => a.label).join(', ')}] group=${groupId}`,
  );

  ctx.runner?.emit('agents_group_start', {
    groupId,
    provider: providerInfo.provider,
    model: providerInfo.model,
    agents: agents.map((a, i) => ({
      index: i,
      label: a.label,
      provider: providerInfo.provider,
      model: providerInfo.model,
      task: a.task,
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
        },
      });
    } catch { /* best-effort */ }
  }

  const specs: ParallelAgentSpec[] = agents.map((a) => ({
    task: a.task,
    label: a.label,
    maxTurns: a.maxTurns,
    systemPrompt: a.profile.systemPrompt,
    allowlist: a.profile.allowlist,
    pathScope: a.profile.pathScopeMode === 'enforce-writes' && a.files && a.files.length > 0
      ? a.files
      : undefined,
    pathScopeMode: a.profile.pathScopeMode,
    limits: limitsForAgent(a),
  }));

  const { results, totalUsage } = await runParallelAgents(
    {
      provider: activeProvider,
      tools: deps.parentTools,
      ctx,
      sessionId: parentSessionId,
      agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
    },
    specs,
    MICRO_AGENT_PROFILES.explore.systemPrompt,
    MICRO_AGENT_PROFILES.explore.allowlist,
    (progress) => {
      ctx.runner?.emit('agent_progress', {
        groupId,
        provider: providerInfo.provider,
        model: providerInfo.model,
        ...progress,
      });
    },
  );

  ctx.runner?.emit('agents_group_end', {
    groupId,
    totalUsage,
    agentCount: results.length,
    successCount: results.filter((r) => r.reason === 'completed').length,
  });

  const cached = totalUsage.cache_read_input_tokens ?? 0;
  const header =
    `[parallel agents: ${results.length} agents, provider=${providerInfo.provider} model=${providerInfo.model}, ` +
    `input=${totalUsage.input_tokens} output=${totalUsage.output_tokens} cache_hit=${cached}]\n\n`;
  const body = results
    .map((r, i) => {
      const meta =
        `[type=${agents[i].type} profile=${agents[i].profile.id} reason=${r.reason} ` +
        `tools=${r.toolCallCount} input=${r.usage.input_tokens} output=${r.usage.output_tokens}]`;
      const text = r.finalText || '(no summary produced)';
      // Frente C — per-agent trail (memos/snapshots/board) appended after
      // its summary so the master can attribute each entry to the right
      // sub. `r.collected` is always present (empty arrays when nothing
      // was emitted), so the render returns '' and concat is a no-op.
      const trail = renderCollectedSnapshotForParent(r.collected ?? emptyCollected());
      return `### Agent ${i + 1}: ${r.label}\n${meta}\n${text}${trail}`;
    })
    .join('\n\n---\n\n');

  // Persist each sub-agent's digest into the investigation ledger (non-company).
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const trail = renderCollectedSnapshotForParent(r.collected ?? emptyCollected());
    captureInvestigation(deps, ctx, agents[i], r.finalText ?? '', trail, r.usage.input_tokens + r.usage.output_tokens);
  }

  return { ...ok(header + body), subUsage: totalUsage };
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
              max_turns: { type: 'number', description: 'Max turns for this agent (default 50, min 50).' },
              files: { type: 'array', items: { type: 'string' }, description: 'Implement profile: paths the agent may write to.' },
            },
            required: ['task'],
          },
          minItems: 1,
          maxItems: 8,
        },
        parallel: { type: 'boolean', description: 'Force parallel/sequential. Default: parallel when agents.length > 1.' },
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
      const { agents, error } = normalizeAgents(args);
      if (error) return err(error);

      const kind = typeof args.kind === 'string' ? args.kind : 'ephemeral';
      if (kind !== 'ephemeral' && kind !== 'persistent') {
        return err(`spawn_agent: kind='${kind}' invalid — must be 'ephemeral' or 'persistent'.`);
      }

      if (kind === 'persistent') {
        if (agents.length > 1) {
          return err('spawn_agent: kind="persistent" supports only ONE agent (parallel persistent is undefined — each subordinate has its own session).');
        }
        return runPersistent(registry, args, agents[0], ctx);
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
