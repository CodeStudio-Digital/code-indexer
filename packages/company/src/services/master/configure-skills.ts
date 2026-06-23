/**
 * Configure skill enablement on the master's coder session. Shared by the
 * `start` and `resume` paths — must run AFTER `buildMasterPromptInputs` so the
 * configured stack is known for conditional (stack-gated) skill resolution.
 *
 * Best-effort: a failure here never aborts the master boot (the master can run
 * without sidebar-pinned skills), so it logs and returns.
 */
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { resolveRoleSkills } from '@mcp/company/types.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';

export function configureMasterSkills(opts: {
  roleConfigs: readonly RoleConfig[];
  configuredStack: string | null | undefined;
  /** `coder_sessions.id` of the master. */
  coderSessionId: number;
  primaryProjectId: number | undefined;
}): void {
  const masterRoleConfig = opts.roleConfigs.find((r) => r.role === 'master');
  const masterResolvedSkills = resolveRoleSkills(masterRoleConfig?.skills, {
    stack: opts.configuredStack ?? undefined,
  });
  if (masterResolvedSkills.length === 0) return;
  if (opts.primaryProjectId == null) return;

  try {
    const skillStore = new SkillStore(loadConfig().dbPath);
    const allSkills = skillStore.resolveActiveSkills(opts.coderSessionId, opts.primaryProjectId);
    for (const skill of allSkills) {
      skillStore.setSessionSkillEnabled(
        opts.coderSessionId,
        skill.id,
        masterResolvedSkills.includes(skill.id),
      );
    }
    skillStore.close();
  } catch (e) {
    console.warn(
      `[company] Failed to configure skills for master: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
