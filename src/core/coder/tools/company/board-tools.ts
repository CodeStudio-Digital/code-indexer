/**
 * Board tools available to ALL company agents (master + subordinates).
 *
 * The shared board is the primary communication channel between agents
 * in a company session.
 */
import type { CoderTool, JsonSchema } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';
import type { CompanyOrchestrator } from '../../company/orchestrator.js';

export function buildBoardTools(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool[] {
  return [
    postToBoard(orchestrator, agentRole, agentRunId),
    readBoard(orchestrator, agentRole),
    setAgentStatus(orchestrator, agentRole, agentRunId),
    kanbanReadMyCard(orchestrator, agentRunId),
  ];
}

// ─── post_to_board ─────────────────────────────────────────────

function postToBoard(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Message content. Use @role to mention other agents (e.g. @master, @frontend, @qa).' },
      kind: {
        type: 'string',
        enum: ['message', 'decision', 'question', 'deliverable', 'handoff'],
        description: 'Type of post (default: message). Use "decision" for important choices, "question" for queries, "deliverable" for completed work, "handoff" for passing work to another agent.',
      },
    },
    required: ['content'],
  };

  return {
    name: 'post_to_board',
    description: 'Post a message to the shared company board. All agents can read it. Use @role to mention specific agents.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const content = args.content as string;
      const kind = (args.kind as string) ?? 'message';

      try {
        orchestrator.postToBoard(
          agentRole,
          agentRunId,
          kind as 'message' | 'decision' | 'question' | 'deliverable' | 'handoff',
          content,
        );
        return ok(`Posted to board as ${agentRole} [${kind}]`);
      } catch (e) {
        return err(`Failed to post: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// ─── read_board ────────────────────────────────────────────────

function readBoard(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      since_id: { type: 'number', description: 'Only return entries after this ID (for incremental reads). Start with 0 to read from the beginning.' },
      limit: { type: 'number', description: 'Max entries to return (default: 50)' },
      mentions_me: { type: 'boolean', description: 'If true, only show entries that mention your role' },
    },
  };

  return {
    name: 'read_board',
    description: 'Read messages from the shared company board. Use since_id for incremental reads to avoid re-reading old messages.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const sinceId = args.since_id as number | undefined;
      const limit = args.limit as number | undefined;
      const mentionsMe = args.mentions_me as boolean | undefined;

      const entries = orchestrator.readBoard({
        sinceId,
        limit,
        mentionsRole: mentionsMe ? agentRole : undefined,
      });

      if (entries.length === 0) {
        return ok(sinceId ? 'No new board entries.' : 'Board is empty.');
      }

      const lines = entries.map((e) => {
        const mentions = e.mentions.length > 0 ? ` (mentions: ${e.mentions.join(', ')})` : '';
        return `[${e.id}] @${e.author_role} [${e.kind}]${mentions}: ${e.content}`;
      });

      return ok(lines.join('\n\n'));
    },
  };
}

// ─── set_agent_status ──────────────────────────────────────────

function setAgentStatus(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['working', 'waiting', 'reviewing', 'blocked', 'done'],
        description: 'Your current status. Use "waiting" when done with current task and ready for more. Use "working" when actively coding. Use "done" when all work is finished.',
      },
      message: { type: 'string', description: 'Brief status description (e.g., "Investigation done. Ready for next task.", "Working on campaign routes")' },
    },
    required: ['status'],
  };

  return {
    name: 'set_agent_status',
    description: 'Set your current status. Use "waiting" when you finish a task and are ready for the next one — this keeps you alive for reuse instead of being discarded.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const status = args.status as string;
      const message = (args.message as string) ?? '';

      if (!agentRunId) return err('No agent_run_id available');

      orchestrator.setAgentStatus(agentRunId, agentRole, status, message);
      return ok(`Status set to "${status}"${message ? `: ${message}` : ''}`);
    },
  };
}

// ─── kanban_read_my_card ──────────────────────────────────────

function kanbanReadMyCard(
  orchestrator: CompanyOrchestrator,
  agentRunId: number | null,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      card_id: { type: 'number', description: 'ID of the Kanban card to read. If omitted, reads the card assigned to your current agent run.' },
    },
  };

  return {
    name: 'kanban_read_my_card',
    description: 'Read a Kanban card with full details (description, objectives checklist, comments, agent history, dependencies). Use this to get the latest context for your assigned task.',
    parameters,
    source: 'native',
    handler: async (args) => {
      try {
        let cardId = args.card_id as number | undefined;

        // If no card_id provided, look up the card assigned to this agent run
        if (!cardId && agentRunId) {
          const context = orchestrator.getCardContextForSubordinate(0); // dummy — we need to find the card first
          // Use the store method directly via orchestrator
          const cards = orchestrator.kanbanListCardsFull();
          const myCard = cards.find(c =>
            c.agents.some(a => a.agent_run_id === agentRunId && !a.unassigned_at)
          );
          if (myCard) cardId = myCard.id;
        }

        if (!cardId) {
          return err('No card_id provided and no card currently assigned to this agent.');
        }

        const card = orchestrator.kanbanGetCard(cardId);
        if (!card) return err(`Card #${cardId} not found`);

        return ok(JSON.stringify(card, null, 2));
      } catch (e) {
        return err(`Failed to read card: ${(e as Error).message}`);
      }
    },
  };
}
