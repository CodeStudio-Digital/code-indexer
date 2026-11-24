/**
 * Public type + pure resolver shared by `spawn` / `resume` / their
 * tests. Lives outside `SubordinateLifecycle.ts` so the extracted
 * `spawn.ts` / `resume.ts` modules can import them without a circular
 * dependency back into the orchestrator class.
 *
 * `SubordinateLifecycle.ts` re-exports both for backward compatibility
 * with existing callers and tests.
 */
import type { AgentId } from '@mcp/code-agent/agents/index.js';
import type { CoderAttachment } from '@mcp/code-agent/index/types.js';
import type { RoleSkills } from '@mcp/company/types.js';
import type { RoleDispatchSource } from '@mcp/company/services/subordinate/role-runtime.js';

export interface SpawnSubordinateSpec {
  kanbanCardId?: string;
  /** Internal durable dispatch identity; allocated before starting work. */
  reservedAgentRunId?: string;
  role: string;
  task: string;
  /** Origin of this fresh run, persisted for runtime provenance. */
  dispatchSource?: RoleDispatchSource;
  /**
   * Primary project for native file/shell tools. Optional for every bound
   * role: the first configured project becomes primary and the subordinate
   * retains access to the role's complete `projectIds` scope. Required only
   * for roles with no project binding.
   */
  projectId?: number;
  provider?: string;
  model?: string;
  tier?: 'bootstrap' | 'navigate' | 'full';
  wait?: boolean;
  /**
   * Either a flat list of skill IDs (legacy, master-supplied) or the v2
   * `RoleSkillsConfig` (template-supplied). Resolved via
   * `resolveRoleSkills` after the subordinate stack is known so
   * conditional branches can pick stack-specific skills.
   */
  skills?: RoleSkills;
  roleOverride?: string;
  /**
   * Built-in agent identity for this spawn. When set, the runner loads the
   * matching `prompts/<agentId>.txt` and applies its policy gates. Callers can
   * pass `'spec'` to run the subordinate under spec-mode discipline; left
   * undefined the runner falls through to the default profile-driven behaviour
   * (no agentId-specific prompt).
   */
  agent?: AgentId;
  /**
   * Sampling temperature for this role, taken from `CompanyRoleConfig.temperature`.
   * Forwarded to the runner as `roleTemperature`. The resolver clamps to [0, 1]
   * and lets a per-session override (if set) win.
   */
  temperature?: number;
  /**
   * Per-role reasoning-effort override, taken from `CompanyRoleConfig.reasoningEffort`.
   * Orthogonal to `thinking`. Forwarded to `runCoder({ reasoningEffort })` →
   * `ChatRequest.reasoningEffort`. When undefined, `SubordinateLifecycle.spawn`
   * falls back to `RoleConfig.reasoningEffort` so the template default applies.
   * Only honoured by providers with discrete effort levels (Codex/OpenRouter).
   */
  reasoningEffort?: string;
  /**
   * Optional attachments (typically images) the master forwards to the
   * subordinate alongside the task — e.g. design inspiration for the
   * frontend role. Threaded through `runCoder` as the first user turn,
   * so the subordinate sees them natively.
   */
  attachments?: CoderAttachment[];
  /**
   * When true, the subordinate's first turn runs with extended thinking
   * (deep reasoning) on providers that support it. Threaded through to
   * `runCoder({ thinking })` and consumed by the provider adapter. The
   * master decides per spawn — not inherited from the master's own flag.
   *
   * Phase E "thinkmode per role": when undefined here, `SubordinateLifecycle.spawn`
   * falls back to `RoleConfig.thinking` so the template default applies
   * without the master having to opt in on every call.
   */
  thinking?: boolean;
  /**
   * Anthropic-specific budget for the extended-thinking response. Forwarded
   * to the runner as `thinkingBudgetTokens` and from there to the SDK's
   * `thinking.budget_tokens`. Ignored by providers that don't support it.
   * Defaults to provider-level (~5000) when undefined.
   */
  thinkingBudgetTokens?: number;
}

/**
 * Resolve the effective project id for a spawn given the role's session
 * bindings. Pure function — the four branches are unit-tested in
 * isolation without spinning up the orchestrator / sandbox / DB.
 *
 * Throws on invalid combinations with messages that name the allowed
 * ids, because the tool layer wraps these errors into the master's
 * `spawn_subordinate_agent` reply so it can autocorrect on retry.
 */
export function resolveSpawnProjectBinding(args: {
  role: string;
  specProjectId: number | undefined;
  boundProjectIds: number[];
}): number {
  const { role, specProjectId, boundProjectIds } = args;
  if (boundProjectIds.length === 0) {
    if (typeof specProjectId !== 'number') {
      throw new Error(
        `Role '${role}' has no project binding — pass project_id explicitly. ` +
          `Use list_company_projects to see available ids.`,
      );
    }
    return specProjectId;
  }
  if (boundProjectIds.length === 1) {
    if (typeof specProjectId !== 'number') return boundProjectIds[0];
    if (!boundProjectIds.includes(specProjectId)) {
      throw new Error(
        `Role '${role}' is bound to project ${boundProjectIds[0]}; ` +
          `project_id=${specProjectId} is not allowed. Omit project_id or delegate to a role bound to that project.`,
      );
    }
    return specProjectId;
  }
  if (typeof specProjectId !== 'number') return boundProjectIds[0];
  if (!boundProjectIds.includes(specProjectId)) {
    throw new Error(
      `Role '${role}' is bound to projects [${boundProjectIds.join(', ')}]; ` +
        `project_id=${specProjectId} is not allowed. Use one of the bound ids.`,
    );
  }
  return specProjectId;
}

/**
 * Resolve both the primary root and the complete role authorization scope.
 * Keeping this pair atomic prevents spawn/session/context persistence from
 * silently collapsing a multi-project role back to one project.
 */
export function resolveSpawnProjectScope(args: {
  role: string;
  specProjectId: number | undefined;
  boundProjectIds: number[];
}): { projectId: number; projectIds: number[] } {
  const projectId = resolveSpawnProjectBinding(args);
  return {
    projectId,
    projectIds: args.boundProjectIds.length > 0
      ? [...new Set([projectId, ...args.boundProjectIds])]
      : [projectId],
  };
}
