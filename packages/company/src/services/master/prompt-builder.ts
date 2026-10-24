/**
 * Shared prompt + CompanyContext assembly for the master agent's
 * `start` and `resumeExisting` paths. Extracted so the two methods
 * don't drift on what the master prompt sees vs. what the agent
 * actually runs against.
 *
 * Also handles the optional sandbox provisioning hook the orchestrator
 * exposes — a no-op for sessions without a primary container.
 */
import {
  buildMasterCompanyBlock,
  type MasterPromptContext,
} from '@mcp/company/system-prompts.js';
import {
  resolveRoleSkills,
  type AllowedModel,
  type CompanyContext,
  type RoleSkills,
  type SandboxBinding,
} from '@mcp/company/types.js';
import type { RoleConfig } from './role-config.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import { readOperationalRules } from '@mcp/company/services/master/config-loader.js';
import { buildAppStudioMasterRuntimeBlock } from '@mcp/company/tools/app-studio/runtime-prompt.js';

interface MasterOrchestratorHooks {
  provisionSandboxIfNeeded?: (signal?: AbortSignal) => Promise<SandboxBinding | null>;
  getSandboxStackForService?: (serviceId?: string | null) => string | null;
}

export interface MasterPromptInputs {
  companyContext: CompanyContext;
  promptBlock: string;
  sandboxBinding: SandboxBinding | null;
  configuredStack: string | null;
}

/** Append the Master role's own persisted instructions to its system block. */
export function appendMasterRoleInstructions(
  promptBlock: string,
  override: string | null | undefined,
): string {
  const normalized = override?.trim().slice(0, 12_000);
  return normalized
    ? `${promptBlock}\n\n## MASTER ROLE INSTRUCTIONS\n\n${normalized}`
    : promptBlock;
}

/**
 * Build the master prompt's roster section from `RoleConfig[]`,
 * resolving each role's skills against the current builder stack so
 * conditional template branches pick the right primary skill.
 */
export function buildPromptRoster(
  configs: readonly RoleConfig[],
  stack: string | null | undefined,
): MasterPromptContext['roster'] {
  return configs.map((cfg) => ({
    role: cfg.role,
    provider: cfg.provider,
    model: cfg.model,
    tier: cfg.tier,
    projectHints: cfg.projectHints,
    projectIds: cfg.projectIds,
    skills: resolveRoleSkills(cfg.skills as RoleSkills | undefined, {
      stack: stack ?? undefined,
    }),
    systemPromptOverride: cfg.systemPromptOverride,
  }));
}

/**
 * Compose the master's `CompanyContext` + system-prompt block from the
 * session context, role configs, allowed_models, and the orchestrator's
 * optional sandbox hooks. Returns the sandbox binding so callers can
 * pass `signal` for cancellation downstream.
 *
 * When `provisionSandboxIfNeeded` is absent (non-builder sessions or
 * tests without an orchestrator), the binding is `null` and the prompt
 * block degrades gracefully — see `buildBuilderInstructions`.
 */
export async function buildMasterPromptInputs(
  ctx: SessionContext,
  agentRunId: string,
  roleConfigs: readonly RoleConfig[],
  allowedModels: readonly AllowedModel[],
  orchestratorRef: unknown,
  signal?: AbortSignal,
  /** Extra flags threaded into the prompt without touching the legacy positional signature. */
  flags: { masterSystemPromptOverride?: string } = {},
): Promise<MasterPromptInputs> {
  const orchestrator = orchestratorRef as MasterOrchestratorHooks;
  const configuredStack = orchestrator.getSandboxStackForService?.() ?? null;

  // Provision the primary sandbox BEFORE runCoder so the binding can be
  // woven into the master's CompanyContext. For sessions without a
  // primary container config this call is a no-op that returns null
  // (the SandboxService inspects the session config and bails out
  // cleanly). It never throws — returns null when the container can't
  // start, so the master always starts.
  const sandboxBinding = orchestrator.provisionSandboxIfNeeded
    ? await orchestrator.provisionSandboxIfNeeded(signal)
    : null;

  const companyContext: CompanyContext = {
    orchestrator: orchestratorRef as never,
    companySessionId: ctx.companySessionId,
    runtimeKind: ctx.runtimeKind,
    appStudioSessionId: ctx.appStudioSessionId ?? undefined,
    capabilities: ctx.capabilities,
    agentRole: 'master',
    agentRunId,
    allowedProjectIds: ctx.projects.map((p) => p.project_id),
    isMaster: true,
    sandbox: sandboxBinding ?? undefined,
  };

  const projectInfos = ctx.projects.map((p) => {
    const proj = ctx.db.getProject(p.project_id);
    return {
      id: p.project_id,
      name: proj?.name ?? `project-${p.project_id}`,
      rootPath: proj?.root_path ?? '',
      label: p.label ?? undefined,
    };
  });

  let promptBlock = buildMasterCompanyBlock({
    roster: buildPromptRoster(roleConfigs, configuredStack),
    projects: projectInfos,
    // Curated pool — when non-empty, the master prompt gains a strict
    // "ALLOWED SUBORDINATE MODELS" section + tool rejection guidance.
    allowedModels: allowedModels.length > 0 ? [...allowedModels] : undefined,
    // Session-level operational rules — single source of truth, injected
    // verbatim. The same text reaches every subordinate (see spawn/resume),
    // so the master enforces rather than re-pastes them into each task.
    operationalRules: readOperationalRules(
      ctx.companyFiles.getSession().config_json,
    ),
    runtimeKind: ctx.capabilities.promptProfile,
  });

  if (ctx.runtimeKind === 'app_studio' && ctx.appStudioSessionId != null) {
    promptBlock += `\n\n${buildAppStudioMasterRuntimeBlock(ctx.appStudioSessionId)}`;
  }

  promptBlock = appendMasterRoleInstructions(
    promptBlock,
    flags.masterSystemPromptOverride,
  );

  return { companyContext, promptBlock, sandboxBinding, configuredStack };
}
