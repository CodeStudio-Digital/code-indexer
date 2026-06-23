/**
 * Skill telemetry — when a subordinate finishes (success/failure/abort),
 * log one `skill_usage_log` row per skill that was active during its
 * run. Powers the dashboard's `/api/admin/skills/:id/health` endpoint
 * (success_rate + per-skill error_code histogram).
 *
 * Best-effort: every failure path here is silenced. Observability must
 * never load-bear the completion handler.
 */
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';

export type SkillOutcome = 'success' | 'failed' | 'aborted';

/**
 * Open the SkillStore, find the enabled skills for `sessionId`, and
 * log one row per skill with `outcome` + optional extracted `errorCode`.
 *
 * Error-code extraction: cheap regex over the message looking for
 * `vocab.X` / `props.X` / `css.X` / `schema.X` / `stories.X` / `audit.X` /
 * `semantic.X` — the codes the validation tools emit. Anything else
 * leaves `error_code` null.
 */
export function logSkillOutcome(
  sessionId: number,
  agentRunId: number,
  outcome: SkillOutcome,
  errorMessage?: string,
): void {
  try {
    const config = loadConfig();
    const skillStore = new SkillStore(config.dbPath);
    try {
      const overrides = skillStore.getSessionSkillConfig(sessionId);
      const enabledIds = Array.from(overrides.entries())
        .filter(([, enabled]) => enabled)
        .map(([id]) => id);
      if (enabledIds.length === 0) return;

      let errorCode: string | undefined;
      if (errorMessage) {
        const match = /\b(vocab\.\w+|props\.\w+|css\.\w+|schema\.\w+|stories\.\w+|audit\.\w+|semantic\.\w+)\b/.exec(
          errorMessage,
        );
        if (match) errorCode = match[1];
      }

      for (const skillId of enabledIds) {
        skillStore.logSkillUsage({
          session_id: sessionId,
          skill_id: skillId,
          invoked_by: 'system',
          outcome,
          error_code: errorCode,
          agent_run_id: agentRunId,
        });
      }
    } finally {
      skillStore.close();
    }
  } catch (e) {
    console.warn(
      `[company] Failed to log skill outcome for run ${agentRunId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
