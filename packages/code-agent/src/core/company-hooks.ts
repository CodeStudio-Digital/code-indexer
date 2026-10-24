/**
 * Company-specific runtime hooks.
 *
 * When a subordinate agent is running inside a company session, these hooks
 * automatically notify the Master about important lifecycle events:
 *
 * - **onError**: Notifies master and posts to the board when the subordinate
 *   encounters a provider error. The master can then decide to resume,
 *   abort, or escalate.
 *
 * - **onFallback**: Posts to the board when the subordinate's provider
 *   switches via fallback chain. Informational — no master action needed.
 *
 * - **onCompletion**: Posts a brief completion notice to the board.
 *   The orchestrator's `done` handler already handles the main flow,
 *   but this hook allows custom post-completion behavior.
 */
import type { RuntimeHookRegistry } from '@mcp/code-agent/core/hook-registry.js';
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';

export function registerCompanyHooks(
  hookRegistry: RuntimeHookRegistry,
  orchestrator: CompanyOrchestrator,
  agentRunId: string,
  role: string,
): void {
  // ─── Error → notify master + post to board ──────────────────
  hookRegistry.onError(async (ctx) => {
    const msg =
      `[SYSTEM] Agent @${role} (run=${agentRunId}) encountered an error.\n` +
      `Error type: ${ctx.errorType}\n` +
      `Error: ${ctx.error.message}\n` +
      `Will retry: ${ctx.willRetry} | Will fallback: ${ctx.willFallback}`;

    // Notify master (wakes master if idle, or queues for resurrection)
    orchestrator.notifyMasterAboutSubordinate(msg);

    // Also post to the shared board for visibility
    try {
      orchestrator.postToBoard(role, agentRunId, 'message',
        `[@master] Error: ${ctx.error.message} (type: ${ctx.errorType}, retry: ${ctx.willRetry}, fallback: ${ctx.willFallback})`,
      );
    } catch {
      // Board post is best-effort
    }
  });

  // ─── Fallback → post to board ───────────────────────────────
  hookRegistry.onFallback(async (ctx) => {
    const msg =
      `[@master] Provider fallback activated: ` +
      `${ctx.from.provider}/${ctx.from.model} → ${ctx.to.provider}/${ctx.to.model} ` +
      `(trigger: ${ctx.triggerError})`;

    try {
      orchestrator.postToBoard(role, agentRunId, 'message', msg);
    } catch {
      // Best-effort
    }
  });

  // ─── Completion → brief board notice + kanban auto-comment ──
  hookRegistry.onCompletion(async (ctx) => {
    try {
      orchestrator.postToBoard(role, agentRunId, 'message',
        `[@master] Session completed (reason: ${ctx.reason}, turns: ${ctx.turnCount}, ` +
        `tokens: ${ctx.totalUsage.input_tokens}in/${ctx.totalUsage.output_tokens}out)`,
      );
    } catch {
      // Best-effort
    }

    // Kanban: add completion comment to the agent's card
    try {
      const cardId = orchestrator.findCardForAgent(agentRunId);
      if (cardId) {
        orchestrator.kanbanAddComment(cardId, role, agentRunId,
          `[AUTO] Session completed (reason: ${ctx.reason}, turns: ${ctx.turnCount}, ` +
          `tokens: ${ctx.totalUsage.input_tokens}in/${ctx.totalUsage.output_tokens}out)`,
        );
      }
    } catch {
      // Best-effort
    }
  });
}
