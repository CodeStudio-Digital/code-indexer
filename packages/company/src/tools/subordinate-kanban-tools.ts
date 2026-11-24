/**
 * Subordinate-scoped Kanban tools.
 *
 * As of the kanban-unification work: subordinates register the unified
 * `kanban_post_comment` and `kanban_update_objectives` (from
 * `kanban-tools.ts`) — same tools the master uses, with optional
 * `card_id` that auto-resolves to the sub's assigned card when omitted.
 *
 * What stays subordinate-only:
 *   - `kanban_move_to_review` — column transition with a hard
 *     constraint (only in_progress → review). Distinct enough from
 *     the master's generic `kanban_move_card` to warrant its own
 *     focused tool — the constraint encoded in the tool name + handler
 *     prevents the sub from moving cards backwards.
 *
 * The deprecated aliases (`kanban_my_comment`, `kanban_my_checklist`)
 * were removed after their grace release — the unknown-tool error lists
 * the valid names, so a stale agent self-corrects to the unified tools.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import { buildUnifiedKanbanTools } from './kanban-tools.js';

export function buildSubordinateKanbanTools(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string,
): CoderTool[] {
  return [
    // Unified surface — same tools master uses. Card auto-resolves via
    // ctx.companyContext.agentRunId when card_id is omitted.
    ...buildUnifiedKanbanTools(orchestrator),
    // Subordinate-only column transition with built-in constraint.
    kanbanMoveToReview(orchestrator, agentRole, agentRunId),
  ];
}

// ─── kanban_move_to_review ───────────────────────────────────

function kanbanMoveToReview(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Optional summary comment added to the card before moving (e.g., what was done, what to verify)',
      },
    },
  };

  return {
    name: 'kanban_move_to_review',
    description:
      'Signal that your work is complete and ready for Master review. ' +
      'Moves YOUR Kanban card from In Progress to the Review column. ' +
      'Only works when your card is currently in In Progress.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const cardId = orchestrator.findCardForAgent(agentRunId);
        if (!cardId) {
          return err(
            'No Kanban card is currently assigned to you. ' +
            'Ask the master to assign you a card via post_to_board, or use kanban_read_my_card to check your assignment status.',
          );
        }

        const card = orchestrator.kanbanGetCard(cardId);
        if (!card) {
          return err(
            `Card #${cardId} not found (it may have been deleted by the master). ` +
            `Notify the master via post_to_board requesting a new assignment.`,
          );
        }

        if (card.column !== 'in_progress') {
          return err(
            `Card #${cardId} is in "${card.column}" — can only move to review from "in_progress". ` +
            `If you believe work is complete, notify the master via post_to_board ` +
            `so they can move the card through the correct transitions.`,
          );
        }

        // Add summary comment if provided
        if (args.summary) {
          orchestrator.kanbanAddComment(
            cardId,
            agentRole,
            agentRunId,
            args.summary as string,
          );
        }

        const moved = orchestrator.kanbanMoveCard(cardId, 'review');
        if (moved.column !== 'review') return err(`Card #${cardId} is still in ${moved.column}. Check its blocking dependencies.`);
        return ok(
          `Card #${cardId} "${card.title}" moved to Review. ` +
          `The Master will verify your work and move it to Done.`,
        );
      } catch (e) {
        return err(`Failed to move card to review: ${(e as Error).message}`);
      }
    },
  };
}
