/**
 * Kanban tools for the Company orchestrator.
 *
 * Master-only tools for creating, moving, updating, and managing Kanban cards.
 * These enable structured task management where cards carry full context
 * (description, objectives, comments, agent history) across agent swaps.
 */
import type { CoderTool, JsonSchema } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import type { CompanyOrchestrator } from '../../company/orchestrator.js';
import type { KanbanColumn } from '../../company/types.js';
import { KANBAN_COLUMNS } from '../../company/types.js';

export function buildKanbanTools(orchestrator: CompanyOrchestrator): CoderTool[] {
  return [
    kanbanCreateCard(orchestrator),
    kanbanMoveCard(orchestrator),
    kanbanUpdateCard(orchestrator),
    kanbanAddComment(orchestrator),
    kanbanUpdateChecklist(orchestrator),
    kanbanAddDependency(orchestrator),
    kanbanRemoveDependency(orchestrator),
    kanbanAssignAgent(orchestrator),
    kanbanListCards(orchestrator),
    kanbanGetCard(orchestrator),
  ];
}

// ─── kanban_create_card ───────────────────────────────────────

function kanbanCreateCard(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Card title — concise task name' },
      description: { type: 'string', description: 'Technical description of the task' },
      column: { type: 'string', enum: KANBAN_COLUMNS, description: 'Target column (default: backlog)' },
      tag: { type: 'string', enum: ['bug', 'feature', 'refactor', 'documentation'], description: 'Task category tag' },
      checklist: { type: 'array', items: { type: 'string' }, description: 'Initial objectives/checklist items' },
    },
    required: ['title'],
  };

  return {
    name: 'kanban_create_card',
    description: 'Create a Kanban task card with title, description, objectives checklist, and tag. Use this BEFORE delegating work to subordinates — the card becomes the single source of truth for the task.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const card = orchestrator.kanbanCreateCard({
          title: args.title as string,
          description: args.description as string | undefined,
          column: args.column as KanbanColumn | undefined,
          tag: args.tag as 'bug' | 'feature' | 'refactor' | 'documentation' | undefined,
          created_by: 'master',
          checklist: args.checklist as string[] | undefined,
        });
        return ok(JSON.stringify(card, null, 2));
      } catch (e) {
        return err(`Failed to create card: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_move_card ─────────────────────────────────────────

function kanbanMoveCard(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card to move' },
      column: { type: 'string', enum: KANBAN_COLUMNS, description: 'Target column' },
      position: { type: 'number', description: 'Position within the column (0-based, optional — appends at end by default)' },
    },
    required: ['card_id', 'column'],
  };

  return {
    name: 'kanban_move_card',
    description: 'Move a Kanban card to a different column. Respects dependency constraints: a card cannot move to in_progress/review/done if it has blockers that are not yet done.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const cardId = args.card_id as number;
        const column = args.column as KanbanColumn;

        // Validate dependency constraints
        if (['in_progress', 'review', 'done'].includes(column)) {
          const full = orchestrator.kanbanGetCard(cardId);
          if (full && full.blocked_by.length > 0) {
            return err(`Card #${cardId} is blocked by cards: ${full.blocked_by.join(', ')}. Resolve blockers first.`);
          }
        }

        const card = orchestrator.kanbanMoveCard(cardId, column, args.position as number | undefined);
        return ok(`Card #${card.id} moved to ${column} (position ${card.position})`);
      } catch (e) {
        return err(`Failed to move card: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_update_card ───────────────────────────────────────

function kanbanUpdateCard(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card to update' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      tag: { type: 'string', enum: ['bug', 'feature', 'refactor', 'documentation', ''], description: 'New tag (empty string to clear)' },
    },
    required: ['card_id'],
  };

  return {
    name: 'kanban_update_card',
    description: 'Update a Kanban card\'s title, description, or tag.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const tag = args.tag === '' ? null : args.tag as 'bug' | 'feature' | 'refactor' | 'documentation' | undefined;
        const card = orchestrator.kanbanUpdateCard(args.card_id as number, {
          title: args.title as string | undefined,
          description: args.description as string | undefined,
          tag,
        });
        return card ? ok(`Card #${card.id} updated`) : err('Card not found');
      } catch (e) {
        return err(`Failed to update card: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_add_comment ───────────────────────────────────────

function kanbanAddComment(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card' },
      content: { type: 'string', description: 'Comment content — use this to save context, decisions, progress logs, and variable states that subordinates need to resume work' },
    },
    required: ['card_id', 'content'],
  };

  return {
    name: 'kanban_add_comment',
    description: 'Add a context comment to a Kanban card. THIS IS THE KEY MECHANISM for passing context to subordinates. Comments are injected into the subordinate\'s task briefing when they are assigned to this card. Save: decisions, file paths, function names, technical context, variable states — anything needed to resume work.',
    parameters,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const agentRunId = ctx.companyContext?.agentRunId ?? null;
        const authorRole = ctx.companyContext?.agentRole ?? 'master';
        const comment = orchestrator.kanbanAddComment(
          args.card_id as number,
          authorRole,
          agentRunId,
          args.content as string,
        );
        return ok(`Comment #${comment.id} added to card #${args.card_id}`);
      } catch (e) {
        return err(`Failed to add comment: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_update_checklist ──────────────────────────────────

function kanbanUpdateChecklist(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Existing item ID (omit to create new)' },
            text: { type: 'string', description: 'Objective text' },
            checked: { type: 'boolean', description: 'Whether this objective is completed' },
          },
          required: ['text', 'checked'],
        },
        description: 'Checklist items to create or update',
      },
    },
    required: ['card_id', 'items'],
  };

  return {
    name: 'kanban_update_checklist',
    description: 'Add or update checklist items (objectives) on a Kanban card. Provide id to update existing items, omit id to create new ones.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const items = args.items as Array<{ id?: number; text: string; checked: boolean }>;
        const result = orchestrator.kanbanUpdateChecklist(args.card_id as number, items);
        const checked = result.filter(i => i.checked).length;
        return ok(`Checklist updated: ${checked}/${result.length} items completed`);
      } catch (e) {
        return err(`Failed to update checklist: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_add_dependency ────────────────────────────────────

function kanbanAddDependency(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card that depends on another' },
      depends_on_card_id: { type: 'number', description: 'ID of the card that blocks this one' },
    },
    required: ['card_id', 'depends_on_card_id'],
  };

  return {
    name: 'kanban_add_dependency',
    description: 'Create a blocking dependency: card_id is blocked by depends_on_card_id. The blocked card cannot move to in_progress until the blocker is done.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        orchestrator.kanbanAddDependency(args.card_id as number, args.depends_on_card_id as number);
        return ok(`Card #${args.card_id} now depends on card #${args.depends_on_card_id}`);
      } catch (e) {
        return err(`Failed to add dependency: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_remove_dependency ─────────────────────────────────

function kanbanRemoveDependency(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card' },
      depends_on_card_id: { type: 'number', description: 'ID of the blocker card to remove' },
    },
    required: ['card_id', 'depends_on_card_id'],
  };

  return {
    name: 'kanban_remove_dependency',
    description: 'Remove a blocking dependency between two cards.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const removed = orchestrator.kanbanRemoveDependency(args.card_id as number, args.depends_on_card_id as number);
        return removed
          ? ok(`Dependency removed: card #${args.card_id} no longer blocked by #${args.depends_on_card_id}`)
          : err('Dependency not found');
      } catch (e) {
        return err(`Failed to remove dependency: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_assign_agent ──────────────────────────────────────

function kanbanAssignAgent(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card' },
      agent_run_id: { type: 'number', description: 'ID of the agent run to assign' },
    },
    required: ['card_id', 'agent_run_id'],
  };

  return {
    name: 'kanban_assign_agent',
    description: 'Assign an agent run to a Kanban card. This records which agent is working on the task. Prefer using kanban_card_id parameter in spawn_subordinate_agent instead — it auto-assigns.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const sub = orchestrator.getSubordinate(args.agent_run_id as number);
        const role = sub?.role ?? 'unknown';
        orchestrator.kanbanAssignAgent(args.card_id as number, args.agent_run_id as number, role);
        return ok(`Agent run #${args.agent_run_id} (${role}) assigned to card #${args.card_id}`);
      } catch (e) {
        return err(`Failed to assign agent: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_list_cards ────────────────────────────────────────

function kanbanListCards(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      column: { type: 'string', enum: KANBAN_COLUMNS, description: 'Filter by column (optional)' },
      include_details: { type: 'boolean', description: 'Include checklist, comments, agents, dependencies (default: false)' },
    },
  };

  return {
    name: 'kanban_list_cards',
    description: 'List all Kanban cards in the current session. Optionally filter by column and include full details.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const column = args.column as KanbanColumn | undefined;
        if (args.include_details) {
          const cards = column
            ? orchestrator.kanbanListCardsFull().filter(c => c.column === column)
            : orchestrator.kanbanListCardsFull();
          return ok(JSON.stringify(cards, null, 2));
        }
        const cards = orchestrator.kanbanListCards({ column });
        const summary = cards.map(c => `#${c.id} [${c.column}] ${c.title}${c.tag ? ` (${c.tag})` : ''}`);
        return ok(summary.join('\n') || 'No cards found.');
      } catch (e) {
        return err(`Failed to list cards: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_get_card ──────────────────────────────────────────

function kanbanGetCard(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the card' },
    },
    required: ['card_id'],
  };

  return {
    name: 'kanban_get_card',
    description: 'Get full details of a Kanban card including checklist, comments, dependencies, and agent history.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        const card = orchestrator.kanbanGetCard(args.card_id as number);
        return card ? ok(JSON.stringify(card, null, 2)) : err('Card not found');
      } catch (e) {
        return err(`Failed to get card: ${(e as Error).message}`);
      }
    },
  };
}
