/**
 * Skill telemetry — when a subordinate finishes (success/failure/abort),
 * append one bundle-local event per skill that was active during its run.
 * Global dashboards aggregate these immutable session events in memory.
 *
 * Best-effort: every failure path here is silenced. Observability must
 * never load-bear the completion handler.
 */
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';

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
export async function logSkillOutcome(
  sessionStore: FsSessionStore,
  sessionId: string,
  agentRunId: string,
  outcome: SkillOutcome,
  errorMessage?: string,
): Promise<void> {
  try {
    const session = await sessionStore.getSession(sessionId);
    const configured = session?.state.tools.active_skills;
    const enabledIds = Array.isArray(configured)
      ? configured.filter((id): id is string => typeof id === 'string')
      : [];
    if (enabledIds.length === 0) return;

    let errorCode: string | undefined;
    if (errorMessage) {
      const match = /\b(vocab\.\w+|props\.\w+|css\.\w+|schema\.\w+|stories\.\w+|audit\.\w+|semantic\.\w+)\b/.exec(
        errorMessage,
      );
      if (match) errorCode = match[1];
    }

    for (const skillId of enabledIds) {
      await sessionStore.appendSessionEvent(sessionId, 'skill_usage', {
        skill_id: skillId,
        invoked_by: 'system',
        outcome,
        error_code: errorCode ?? null,
        agent_run_id: agentRunId,
      });
    }
  } catch (e) {
    console.warn(
      `[company] Failed to log skill outcome for run ${agentRunId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
