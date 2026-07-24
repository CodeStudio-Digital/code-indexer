import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { WorkerBackedOrchestrator } from '../../../sse/companyOrchestrator.js';

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
  orchestrator: Pick<WorkerBackedOrchestrator, 'startMaster' | 'resumeExistingMaster'>,
  masterExists: boolean,
  opts: {
    userMessage: string;
    provider: string;
    model: string;
    maxTurns: number;
    roleConfigs: Parameters<CompanyOrchestrator['startMaster']>[0]['roleConfigs'];
    attachments: Parameters<CompanyOrchestrator['startMaster']>[0]['attachments'];
    thinking?: boolean;
    thinkingBudgetTokens?: number;
    temperature?: number;
    /** Sticky master reasoning-effort override (config_json
     *  `master_reasoning_effort`). Orthogonal to thinking. */
    reasoningEffort?: string;
    fallbackModels?: Parameters<CompanyOrchestrator['startMaster']>[0]['fallbackModels'];
  },
): Promise<void> {
  if (masterExists) {
    await orchestrator.resumeExistingMaster({
      userMessage: opts.userMessage,
      provider: opts.provider,
      model: opts.model,
      maxTurns: opts.maxTurns,
      roleConfigs: opts.roleConfigs,
      attachments: opts.attachments,
      thinking: opts.thinking,
      thinkingBudgetTokens: opts.thinkingBudgetTokens,
      temperature: opts.temperature,
      reasoningEffort: opts.reasoningEffort,
      fallbackModels: opts.fallbackModels,
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
    thinkingBudgetTokens: opts.thinkingBudgetTokens,
    temperature: opts.temperature,
    reasoningEffort: opts.reasoningEffort,
    fallbackModels: opts.fallbackModels,
  });
}
