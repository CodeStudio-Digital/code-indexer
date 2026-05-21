/**
 * Public type + pure resolver shared by `spawn` / `resume` / their
 * tests. Lives outside `SubordinateLifecycle.ts` so the extracted
 * `spawn.ts` / `resume.ts` modules can import them without a circular
 * dependency back into the orchestrator class.
 *
 * `SubordinateLifecycle.ts` re-exports both for backward compatibility
 * with existing callers and tests.
 */
import type { CoderAttachment } from '@mcp/code-agent/index.js';
import type { RoleSkills } from '@mcp/company/types.js';

export interface SpawnSubordinateSpec {
  role: string;
  task: string;
  /**
   * Project id to run the subordinate in. Optional when the role has a
   * single-project binding (`CompanyRoleConfig.projectIds.length === 1`):
   * in that case the spawn auto-resolves to that project id. Required
   * otherwise, and enforced against the role's `projectIds` (if any).
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
   * Sampling temperature for this role, taken from `CompanyRoleConfig.temperature`.
   * Forwarded to the runner as `roleTemperature`. The resolver clamps to [0, 1]
   * and lets a per-session override (if set) win.
   */
  temperature?: number;
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
  if (typeof specProjectId !== 'number') {
    throw new Error(
      `Role '${role}' is bound to multiple projects [${boundProjectIds.join(', ')}]. ` +
        `Pass project_id to choose one.`,
    );
  }
  if (!boundProjectIds.includes(specProjectId)) {
    throw new Error(
      `Role '${role}' is bound to projects [${boundProjectIds.join(', ')}]; ` +
        `project_id=${specProjectId} is not allowed. Use one of the bound ids.`,
    );
  }
  return specProjectId;
}
