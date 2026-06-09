import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';

/**
 * Resume-or-start the master, idempotent over an existing master run.
 *
 * If the session already has a master `company_agent_run`, we RESUME it —
 * reusing its `coder_session_id`, so the full conversation + context survives
 * (`resumeMaster` reuses the row; it does NOT create a new one). Only a session
 * with NO master run (a brand-new sub-session) cold-starts a fresh master.
 *
 * Shared by BOTH `/start` and `/resume` so neither can silently spawn a
 * DUPLICATE master that drops the prior context — the bug that left company
 * session 104 with 5 distinct master runs (5 distinct coder-sessions). The
 * explicit "start fresh" path stays `/reestablish-master`.
 *
 * Takes a `Pick` so callers (and tests) only need the two lifecycle methods.
 */
export async function resolveAndRunMaster(
  orchestrator: Pick<CompanyOrchestrator, 'startMaster' | 'resumeExistingMaster'>,
  masterExists: boolean,
  opts: {
    userMessage: string;
    provider: string;
    model: string;
    maxTurns: number;
    roleConfigs: Parameters<CompanyOrchestrator['startMaster']>[0]['roleConfigs'];
    attachments: Parameters<CompanyOrchestrator['startMaster']>[0]['attachments'];
    thinking?: boolean;
  },
): Promise<void> {
  if (masterExists) {
    await orchestrator.resumeExistingMaster({
      userMessage: opts.userMessage,
      maxTurns: opts.maxTurns,
      roleConfigs: opts.roleConfigs,
      attachments: opts.attachments,
      thinking: opts.thinking,
    });
    return;
  }
  await orchestrator.startMaster({
    userMessage: opts.userMessage,
    provider: opts.provider,
    model: opts.model,
    maxTurns: opts.maxTurns,
    roleConfigs: opts.roleConfigs,
    attachments: opts.attachments,
    thinking: opts.thinking,
  });
}
