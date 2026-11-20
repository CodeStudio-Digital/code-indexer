/**
 * Company-specific runtime hooks.
 *
 * When a subordinate agent is running inside a company session, this hook
 * reports its completion:
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
