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
