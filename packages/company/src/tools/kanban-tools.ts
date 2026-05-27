/**
 * Kanban tools for the Company orchestrator.
 *
 * Master-only tools for creating, moving, updating, and managing Kanban cards.
 * These enable structured task management where cards carry full context
 * (description, objectives, comments, agent history) across agent swaps.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { KanbanColumn } from '@mcp/company/types.js';
import { KANBAN_COLUMNS } from '@mcp/company/types.js';

export function buildKanbanTools(orchestrator: CompanyOrchestrator): CoderTool[] {
  return [
    kanbanCreateCard(orchestrator),
    kanbanMoveCard(orchestrator),
    kanbanUpdateMeta(orchestrator),
    // Unified comment + checklist tools — work for master AND
    // subordinates (sub auto-resolves card_id via assigned card).
    // Replace the prior split (kanban_add_comment + kanban_my_comment
    // and kanban_update_checklist + kanban_my_checklist) that
    // confused agents about which variant to use.
    kanbanPostComment(orchestrator),
    kanbanUpdateObjectives(orchestrator),
    // Deprecated aliases — kept registered for one release so agents
    // mid-session that learned the old names don't break. Mark with
    // [DEPRECATED] in description; remove next sprint.
    kanbanAddComment(orchestrator),
    kanbanUpdateChecklist(orchestrator),
    kanbanUpdateCard(orchestrator),
    kanbanAddDependency(orchestrator),
    kanbanRemoveDependency(orchestrator),
    kanbanAssignAgent(orchestrator),
    kanbanListCards(orchestrator),
    kanbanGetCard(orchestrator),
  ];
}

/**
 * Exported for `buildSubordinateKanbanTools` to register the same
 * unified tools on the subordinate's runner. The handler reads
 * `ctx.companyContext.agentRunId` to auto-resolve the card when
 * `card_id` is omitted — works seamlessly for both master and sub.
 */
export function buildUnifiedKanbanTools(orchestrator: CompanyOrchestrator): CoderTool[] {
  return [kanbanPostComment(orchestrator), kanbanUpdateObjectives(orchestrator)];
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
            return err(
              `Card #${cardId} is blocked by cards: ${full.blocked_by.join(', ')}. ` +
              `Resolve blockers first by either:\n` +
              `  1. Moving blocker(s) to done (use kanban_move_card on each blocker), or\n` +
              `  2. Removing the dependency (use kanban_remove_dependency card_id=${cardId}, depends_on_card_id=<blocker>), or\n` +
              `  3. Inspecting each blocker with kanban_get_card to decide next action.`,
            );
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

// ─── kanban_update_meta (renamed from kanban_update_card) ─────
//
// Renamed for clarity: `kanban_update_card` was ambiguous — agents
// confused it with `kanban_update_checklist` ("update card" feels
// like "update everything on the card, including objectives"). The
// new name `kanban_update_meta` makes it explicit: this tool ONLY
// changes title/description/tag, NOT the checklist or comments.

function kanbanUpdateMeta(orchestrator: CompanyOrchestrator): CoderTool {
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
    name: 'kanban_update_meta',
    description:
      "Update a Kanban card's metadata (title / description / tag). " +
      'Does NOT touch checklist objectives or comments — use ' +
      '`kanban_update_objectives` or `kanban_post_comment` for those.',
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
        return card ? ok(`Card #${card.id} updated`) : err(`Card #${args.card_id} not found. Use kanban_list_cards to see valid ids.`);
      } catch (e) {
        return err(`Failed to update card: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_update_card (deprecated alias for kanban_update_meta) ──

function kanbanUpdateCard(orchestrator: CompanyOrchestrator): CoderTool {
  // Same parameters / handler as `kanban_update_meta` — only the
  // name + description differs. Reduces duplication while preserving
  // the old surface for one release cycle.
  const meta = kanbanUpdateMeta(orchestrator);
  return {
    ...meta,
    name: 'kanban_update_card',
    description: '[DEPRECATED — use kanban_update_meta] ' + meta.description,
  };
}

// ─── kanban_post_comment (unified — replaces add_comment + my_comment) ──
//
// Single comment surface for master AND subordinates. `card_id` is
// optional: when omitted, the handler auto-resolves to the caller's
// assigned card via `findCardForAgent(agentRunId)`. Master must
// always pass `card_id` explicitly (they don't have an "assigned"
// card). Subordinates can omit it and let auto-resolve work.
//
// This kills the old split (`kanban_add_comment` for master vs
// `kanban_my_comment` for subs) that confused agents about which
// variant applied to their role.

function kanbanPostComment(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: {
        type: 'number',
        description:
          'ID of the card. OMIT when you are a subordinate with an assigned card ' +
          '(your card is auto-resolved). Required when you are the master.',
      },
      content: {
        type: 'string',
        description:
          'Comment content — decisions, progress logs, file paths, technical context, ' +
          'variable states. Comments are durable and visible to all agents who later ' +
          'work on this card; treat them as the canonical handoff record.',
      },
    },
    required: ['content'],
  };

  return {
    name: 'kanban_post_comment',
    description:
      'Add a comment to a Kanban card. Master + subordinates both use this. ' +
      "If you're a subordinate, omit `card_id` and your assigned card is used. " +
      "If you're the master, pass `card_id` explicitly. " +
      'Use for: handoff context, blockers, decisions, progress checkpoints — ' +
      'anything that needs to survive agent restarts.',
    parameters,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const agentRunId = ctx.companyContext?.agentRunId ?? null;
        const authorRole = ctx.companyContext?.agentRole ?? 'master';
        // Resolve card_id: explicit > auto-resolve from assigned card.
        let cardId = args.card_id as number | undefined;
        if (cardId == null) {
          if (agentRunId == null) {
            return err(
              "kanban_post_comment: card_id is required when you are the master " +
                '(no card is automatically assigned to you). Pass an explicit card_id ' +
                'from kanban_list_cards or kanban_get_card.',
            );
          }
          const resolved = orchestrator.findCardForAgent(agentRunId);
          if (!resolved) {
            return err(
              "kanban_post_comment: no card is currently assigned to you. " +
                'Either pass card_id explicitly, or ask the master to assign one.',
            );
          }
          cardId = resolved;
        }
        const comment = orchestrator.kanbanAddComment(
          cardId,
          authorRole,
          agentRunId,
          args.content as string,
        );
        return ok(`Comment #${comment.id} added to card #${cardId}`);
      } catch (e) {
        return err(`Failed to add comment: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_update_objectives (unified — replaces update_checklist + my_checklist) ──
//
// Same shape as kanban_post_comment: single surface for master and
// subordinates, optional `card_id` auto-resolves for subs.

function kanbanUpdateObjectives(orchestrator: CompanyOrchestrator): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: {
        type: 'number',
        description:
          'ID of the card. OMIT as a subordinate with an assigned card (auto-resolves). ' +
          'Required when you are the master.',
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'number',
              description:
                'Existing item ID (omit to create new). Get IDs from kanban_get_card or kanban_read_my_card.',
            },
            text: { type: 'string', description: 'Objective text' },
            checked: { type: 'boolean', description: 'Whether this objective is completed' },
          },
          required: ['text', 'checked'],
        },
        description: 'Checklist items to create (omit id) or update (pass id).',
      },
    },
    required: ['items'],
  };

  return {
    name: 'kanban_update_objectives',
    description:
      'Add or update checklist objectives on a Kanban card. Master + subordinates both use this. ' +
      "If you're a subordinate, omit `card_id` and your assigned card is used. " +
      "If you're the master, pass `card_id` explicitly. " +
      'Provide `id` to update an existing item, or omit `id` to create a new one.',
    parameters,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const agentRunId = ctx.companyContext?.agentRunId ?? null;
        let cardId = args.card_id as number | undefined;
        if (cardId == null) {
          if (agentRunId == null) {
            return err(
              'kanban_update_objectives: card_id is required when you are the master.',
            );
          }
          const resolved = orchestrator.findCardForAgent(agentRunId);
          if (!resolved) {
            return err(
              'kanban_update_objectives: no card is currently assigned to you. ' +
                'Pass card_id explicitly, or ask the master to assign one.',
            );
          }
          cardId = resolved;
        }
        const items = args.items as Array<{ id?: number; text: string; checked: boolean }>;
        // Defensive validation: when items reference existing IDs, ensure
        // they belong to THIS card. Prevents accidental cross-card writes.
        if (items.some((i) => i.id != null)) {
          const card = orchestrator.kanbanGetCard(cardId);
          if (card) {
            const cardItemIds = new Set(card.checklist.map((ci) => ci.id));
            const invalidIds = items
              .filter((i) => i.id != null && !cardItemIds.has(i.id))
              .map((i) => i.id);
            if (invalidIds.length > 0) {
              return err(
                `Checklist item(s) ${invalidIds.join(', ')} do not belong to card #${cardId}.`,
              );
            }
          }
        }
        const result = orchestrator.kanbanUpdateChecklist(cardId, items);
        const checked = result.filter((i) => i.checked).length;
        return ok(`Checklist updated: ${checked}/${result.length} items completed on card #${cardId}`);
      } catch (e) {
        return err(`Failed to update objectives: ${(e as Error).message}`);
      }
    },
  };
}

// ─── kanban_add_comment (deprecated alias for kanban_post_comment) ──

function kanbanAddComment(orchestrator: CompanyOrchestrator): CoderTool {
  const unified = kanbanPostComment(orchestrator);
  return {
    ...unified,
    name: 'kanban_add_comment',
    description:
      '[DEPRECATED — use kanban_post_comment instead] ' + unified.description,
  };
}

// ─── kanban_update_checklist (deprecated alias for kanban_update_objectives) ──

function kanbanUpdateChecklist(orchestrator: CompanyOrchestrator): CoderTool {
  const unified = kanbanUpdateObjectives(orchestrator);
  return {
    ...unified,
    name: 'kanban_update_checklist',
    description:
      '[DEPRECATED — use kanban_update_objectives instead] ' + unified.description,
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
        return card ? ok(JSON.stringify(card, null, 2)) : err(`Card #${args.card_id} not found. Use kanban_list_cards to see available cards.`);
      } catch (e) {
        return err(`Failed to get card: ${(e as Error).message}`);
      }
    },
  };
}
