/**
 * Configure skill enablement on the master's coder session. Shared by the
 * `start` and `resume` paths — must run AFTER `buildMasterPromptInputs` so the
 * configured stack is known for conditional (stack-gated) skill resolution.
 *
 * Skill definitions remain in the essential SQLite catalog, but the resolved
 * per-session selection is part of the filesystem session state. Best-effort:
 * a failure here never aborts the master boot (the master can run without
 * sidebar-pinned skills), so it logs and returns.
 */
import { resolveRoleSkills, type RoleSkills } from '@mcp/company/types.js';
import type { RoleConfig } from '@mcp/company/services/MasterLifecycle.js';
import type { SessionId } from '@mcp/session-storage';

export interface SessionSkillSelectionStore {
  setSessionActiveSkills(
    sessionId: SessionId | string,
    skillIds: readonly string[],
  ): Promise<void>;
}

export async function configureMasterSkills(opts: {
  roleConfigs: readonly RoleConfig[];
  configuredStack: string | null | undefined;
  /** UUID of the master's filesystem session bundle. */
  coderSessionId: SessionId | string;
  sessionStore: SessionSkillSelectionStore;
  /** Authoritative App Master skills; [] explicitly disables all. */
  masterSkills?: RoleSkills;
}): Promise<void> {
  const masterRoleConfig = opts.roleConfigs.find((r) => r.role === 'master');
  const configuredSkills = opts.masterSkills ?? masterRoleConfig?.skills;
  if (configuredSkills === undefined) return;
  const masterResolvedSkills = resolveRoleSkills(configuredSkills, {
    stack: opts.configuredStack ?? undefined,
  });

  try {
    await opts.sessionStore.setSessionActiveSkills(
      opts.coderSessionId,
      masterResolvedSkills,
    );
  } catch (e) {
    console.warn(
      `[company] Failed to configure skills for master: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
