/**
 * kanban_create_card / kanban_move_card — batch-capable factories.
 *
 * Telemetry: masters plan boards ONE CARD PER TURN (`kanban_create_card =>
 * kanban_create_card` 91×, `kanban_move_card => kanban_move_card` 71× as
 * consecutive-turn bigrams) — each transition burning a full LLM round-trip.
 * Both tools now accept a batch array (`cards` / `moves`, max 15) alongside
 * the original single form.
 *
 * Batch semantics are PER-ITEM (not atomic, unlike update_todo): cards are
 * independent entities, so one failure (e.g. a blocked move) reports that
 * item and continues — the result lists every outcome with the created ids
 * the master needs for dependencies/assignment.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { KanbanColumn } from '@mcp/company/types.js';
import { KANBAN_COLUMNS } from '@mcp/company/types.js';

const MAX_BATCH = 15;

const CARD_PROPS: NonNullable<JsonSchema['properties']> = {
  title: { type: 'string', description: 'Card title — concise task name' },
  description: { type: 'string', description: 'Technical description of the task' },
  column: { type: 'string', enum: KANBAN_COLUMNS, description: 'Target column (default: backlog)' },
  tag: { type: 'string', enum: ['bug', 'feature', 'refactor', 'documentation'], description: 'Task category tag' },
  checklist: { type: 'array', items: { type: 'string' }, description: 'Initial objectives/checklist items' },
};

type Rec = Record<string, unknown>;

function createOne(orchestrator: CompanyOrchestrator, spec: Rec): string {
  const card = orchestrator.kanbanCreateCard({
    title: spec.title as string,
    description: spec.description as string | undefined,
    column: spec.column as KanbanColumn | undefined,
    tag: spec.tag as 'bug' | 'feature' | 'refactor' | 'documentation' | undefined,
    created_by: 'master',
    checklist: spec.checklist as string[] | undefined,
  });
  return `#${card.id} "${card.title}" → ${card.column} (position ${card.position})`;
}

function moveOne(orchestrator: CompanyOrchestrator, spec: Rec): string {
  const cardId = spec.card_id as string;
  const column = spec.column as KanbanColumn;
  // Dependency constraint: a card cannot advance while blockers are open.
  if (['in_progress', 'review', 'done'].includes(column)) {
    const full = orchestrator.kanbanGetCard(cardId);
    if (full && full.blocked_by.length > 0) {
      throw new Error(
        `Card #${cardId} is blocked by cards: ${full.blocked_by.join(', ')}. ` +
          `Resolve blockers first: move them to done, or remove the dependency ` +
          `(kanban_remove_dependency card_id=${cardId}, depends_on_card_id=<blocker>), ` +
          `or inspect them with kanban_get_card.`,
      );
    }
  }
  const card = orchestrator.kanbanMoveCard(cardId, column, spec.position as number | undefined);
  return `Card #${card.id} moved to ${column} (position ${card.position})`;
}

/**
 * Run a batch with per-item isolation: each entry either yields its success
 * line or its error line; the call is `isError` only when EVERY item failed.
 */
function runBatch(entries: Rec[], execOne: (spec: Rec) => string): ReturnType<typeof ok> {
  const lines: string[] = [];
  let failures = 0;
  for (let i = 0; i < entries.length; i++) {
    try {
      lines.push(`[${i + 1}/${entries.length}] ${execOne(entries[i])}`);
    } catch (e) {
      failures += 1;
      lines.push(`[${i + 1}/${entries.length}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const summary = `${entries.length - failures}/${entries.length} succeeded${failures ? `, ${failures} failed` : ''}`;
  const body = [summary, ...lines].join('\n');
  return failures === entries.length ? err(body) : ok(body);
}

/** Validate the batch array shape; null = caller should use the single form. */
function parseBatch(
  args: Rec, key: 'cards' | 'moves', requiredField: string, singleField: string,
): { entries: Rec[] | null; error?: string } {
  const raw = args[key];
  if (raw === undefined) return { entries: null };
  if (args[singleField] !== undefined) {
    return { entries: null, error: `Pass EITHER the single top-level form OR \`${key}: [...]\` — not both.` };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    return { entries: null, error: `\`${key}\` must be a non-empty array (max ${MAX_BATCH}).` };
  }
  if (raw.length > MAX_BATCH) {
    return { entries: null, error: `Too many entries (${raw.length}, max ${MAX_BATCH}). Split into two calls.` };
  }
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Rec;
    if (typeof e !== 'object' || e === null || e[requiredField] === undefined) {
      return { entries: null, error: `${key}[${i}] must be an object with \`${requiredField}\`.` };
    }
  }
  return { entries: raw as Rec[] };
}

export function kanbanCreateCardTool(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'kanban_create_card',
    description:
      'Create one or several Kanban task cards. Use this BEFORE delegating work to subordinates — ' +
      'the card becomes the single source of truth for the task.\n' +
      `Planning a board? Create ALL the cards in ONE call with \`cards: [{title, description?, column?, tag?, checklist?}, ...]\` (max ${MAX_BATCH}) ` +
      'instead of one call per card — the result lists each created id for kanban_add_dependency / kanban_assign_agent.',
    parameters: {
      type: 'object',
      properties: {
        ...CARD_PROPS,
        cards: {
          type: 'array',
          description: `Batch form: several cards in one call (max ${MAX_BATCH}). Each entry: {title (required), description?, column?, tag?, checklist?}.`,
          items: { type: 'object', properties: { ...CARD_PROPS }, required: ['title'] },
        },
      },
      required: [],
    },
    source: 'native',
    handler: async (args) => {
      const batch = parseBatch(args, 'cards', 'title', 'title');
      if (batch.error) return err(batch.error);
      if (batch.entries) return runBatch(batch.entries, (s) => createOne(orchestrator, s));
      if (typeof args.title !== 'string' || !args.title.trim()) {
        return err('title is required (single form) — or pass `cards: [...]` for a batch.');
      }
      try {
        return ok(createOne(orchestrator, args));
      } catch (e) {
        return err(`Failed to create card: ${(e as Error).message}`);
      }
    },
  };
}

export function kanbanMoveCardTool(orchestrator: CompanyOrchestrator): CoderTool {
  return {
    name: 'kanban_move_card',
    description:
      'Move one or several Kanban cards to different columns. Respects dependency constraints: a card ' +
      'cannot move to in_progress/review/done while it has blockers that are not done.\n' +
      `Reorganizing the board? Pass ALL the moves in ONE call with \`moves: [{card_id, column, position?}, ...]\` (max ${MAX_BATCH}) — ` +
      'a blocked card fails only that entry; the rest still apply.',
    parameters: {
      type: 'object',
      properties: {
        card_id: { type: 'string', description: 'UUID of the card to move (single form)' },
        column: { type: 'string', enum: KANBAN_COLUMNS, description: 'Target column (single form)' },
        position: { type: 'number', description: 'Position within the column (0-based, optional — appends at end by default)' },
        moves: {
          type: 'array',
          description: `Batch form: several moves in one call (max ${MAX_BATCH}). Each entry: {card_id, column, position?}.`,
          items: {
            type: 'object',
            properties: {
              card_id: { type: 'string' },
              column: { type: 'string', enum: KANBAN_COLUMNS },
              position: { type: 'number' },
            },
            required: ['card_id', 'column'],
          },
        },
      },
      required: [],
    },
    source: 'native',
    handler: async (args) => {
      const batch = parseBatch(args, 'moves', 'card_id', 'card_id');
      if (batch.error) return err(batch.error);
      if (batch.entries) return runBatch(batch.entries, (s) => moveOne(orchestrator, s));
      if (typeof args.card_id !== 'string' || typeof args.column !== 'string') {
        return err('card_id and column are required (single form) — or pass `moves: [...]` for a batch.');
      }
      try {
        return ok(moveOne(orchestrator, args));
      } catch (e) {
        return err(`Failed to move card: ${(e as Error).message}`);
      }
    },
  };
}
