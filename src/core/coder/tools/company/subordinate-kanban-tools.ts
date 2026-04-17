/**
 * Subordinate-scoped Kanban tools.
 *
 * These tools let subordinate agents self-service their assigned Kanban card:
 * - Add comments (progress, blockers, decisions)
 * - Check off / add checklist items (objectives)
 * - Move their card to Review when done
 *
 * All tools auto-resolve the card ID from the agent's `agentRunId` —
 * subordinates never need to know or guess card IDs.
 *
 * These are distinct from the Master's `kanban_add_comment` / `kanban_update_checklist`
 * which operate on ANY card by ID. The `my_` prefix signals self-scoped access.
 */
import type { CoderTool, JsonSchema } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import type { CompanyOrchestrator } from '../../company/orchestrator.js';

export function buildSubordinateKanbanTools(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number,
): CoderTool[] {
  return [
    kanbanMyComment(orchestrator, agentRole, agentRunId),
    kanbanMyChecklist(orchestrator, agentRole, agentRunId),
    kanbanMoveToReview(orchestrator, agentRole, agentRunId),
  ];
}

// ─── kanban_my_comment ───────────────────────────────────────

function kanbanMyComment(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'Comment content — progress notes, decisions, blockers, technical context. ' +
          'This is preserved across agent restarts and visible to the Master and future agents.',
      },
    },
    required: ['content'],
  };

  return {
    name: 'kanban_my_comment',
    description:
      'Add a comment to YOUR assigned Kanban card. Use for progress updates, decisions, ' +
      'blockers, or technical context that should survive agent restarts. ' +
      'The Master and future agents will see these comments.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const cardId = orchestrator.findCardForAgent(agentRunId);
        if (!cardId) {
          return err('No Kanban card is currently assigned to you.');
        }

        const comment = orchestrator.kanbanAddComment(
          cardId,
          agentRole,
          agentRunId,
          args.content as string,
        );
        return ok(`Comment #${comment.id} added to your card #${cardId}`);
      } catch (e) {
        return err(`Failed to add comment: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_my_checklist ─────────────────────────────────────

function kanbanMyChecklist(
  orchestrator: CompanyOrchestrator,
  _agentRole: string,
  agentRunId: number,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Existing item ID (omit to create new). Get IDs from kanban_read_my_card.' },
            text: { type: 'string', description: 'Objective text' },
            checked: { type: 'boolean', description: 'Whether this objective is completed' },
          },
          required: ['text', 'checked'],
        },
        description: 'Checklist items to create or update on your card',
      },
    },
    required: ['items'],
  };

  return {
    name: 'kanban_my_checklist',
    description:
      'Check off completed objectives or add new checklist items to YOUR Kanban card. ' +
      'Use kanban_read_my_card first to see current item IDs.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const cardId = orchestrator.findCardForAgent(agentRunId);
        if (!cardId) {
          return err('No Kanban card is currently assigned to you.');
        }

        const items = args.items as Array<{ id?: number; text: string; checked: boolean }>;

        // Validate that referenced item IDs belong to this card
        const card = orchestrator.kanbanGetCard(cardId);
        if (card && items.some(i => i.id != null)) {
          const cardItemIds = new Set(card.checklist.map(ci => ci.id));
          const invalidIds = items.filter(i => i.id != null && !cardItemIds.has(i.id)).map(i => i.id);
          if (invalidIds.length > 0) {
            return err(`Checklist item(s) ${invalidIds.join(', ')} do not belong to your card #${cardId}.`);
          }
        }

        const result = orchestrator.kanbanUpdateChecklist(cardId, items);
        const checked = result.filter(i => i.checked).length;
        return ok(`Checklist updated: ${checked}/${result.length} items completed on card #${cardId}`);
      } catch (e) {
        return err(`Failed to update checklist: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_move_to_review ───────────────────────────────────

function kanbanMoveToReview(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number,
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

        orchestrator.kanbanMoveCard(cardId, 'review');
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
