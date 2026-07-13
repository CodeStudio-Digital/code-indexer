/**
 * Board tools available to ALL company agents (master + subordinates).
 *
 * The shared board is the primary communication channel between agents
 * in a company session.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';

export function buildBoardTools(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool[] {
  return [
    postToBoard(orchestrator, agentRole, agentRunId),
    readBoard(orchestrator, agentRole, agentRunId),
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
      content: {
        type: 'string',
        description: 'Message content. Use @role to mention other agents (e.g. @master, @frontend, @qa).',
      },
      kind: {
        type: 'string',
        enum: ['message', 'decision', 'question', 'deliverable', 'handoff', 'blocker'],
        description:
          'Type of post (default: message). Use "decision" for important choices, "question" for queries, ' +
          '"deliverable" for completed work, "handoff" for passing work to another agent. ' +
          '"blocker" = IMPEDIMENT — use ONLY when you genuinely cannot proceed without human ' +
          'intervention (missing tool/permission, ambiguous external state, contradictory instructions). ' +
          'Calling with kind="blocker" posts the message AND ENDS YOUR SESSION; the user will see the ' +
          'impediment, decide how to intervene, and their next message will resurrect you with full ' +
          'history. Reserve this for true dead-ends — for normal questions use awaits_response instead.',
      },
      // ── Interactive mode ──
      // When set, the post BLOCKS the runner and renders a card with
      // buttons / freeform input. The runner resumes once the user
      // responds via the existing /respond-plan or /answer endpoint.
      // This unifies the prior dichotomy of "post_to_board (fire and
      // forget)" vs "submit_plan / ask_user (blocking with UI)" into
      // a single tool — the agent decides per-call whether it needs
      // a structured response.
      awaits_response: {
        type: 'object',
        description:
          'Optional. When set, BLOCKS this agent until the user responds via an interactive card ' +
          '(approve/reject buttons, choice buttons, or freeform text). Use this when your message ' +
          'requires explicit acknowledgement — never post a plain message and loop waiting for the ' +
          "user to type a reply, the user has no structured way to do that.",
        properties: {
          mode: {
            type: 'string',
            enum: ['approval', 'choice', 'freeform'],
            description:
              '"approval" — Approve/Reject buttons + optional feedback (like submit_plan). ' +
              '"choice"   — N labeled buttons; pass `options`. May coexist with `allow_freeform`. ' +
              '"freeform" — open text input only (like ask_user without options).',
          },
          options: {
            type: 'array',
            description: 'For mode="choice". Array of {label, value} button definitions.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['label', 'value'],
            },
          },
          allow_freeform: {
            type: 'boolean',
            description: 'For mode="choice". When true, the user can also type a custom answer.',
          },
        },
        required: ['mode'],
      },
    },
    required: ['content'],
  };

  return {
    name: 'post_to_board',
    description:
      'Post a message to the shared company board.\n\n' +
      'Two modes:\n' +
      '  - Plain (default): fire-and-forget — your post appears in the feed; no response expected.\n' +
      "  - Interactive (`awaits_response: { mode }`): your post becomes a card with buttons; " +
      'YOUR RUNNER BLOCKS until the user responds. Use this when your message requires explicit ' +
      'approval/decision/answer (e.g. "may I start coding card #316?", "which strategy?", ' +
      '"what name should I use?").\n\n' +
      'Prefer interactive mode over a plain post + waiting in a loop — the loop wastes turns and ' +
      'the user has no structured way to reply.\n\n' +
      'Consolidate: ONE post covering several updates beats a sequence of small posts ' +
      '(each extra post costs a full turn). Post when you have something complete to report, ' +
      'not per micro-step.\n\n' +
      'Mention agents via @role.',
    parameters,
    source: 'native',
    handler: async (args, ctx) => {
      const content = args.content as string;
      const kind = (args.kind as string) ?? 'message';
      const awaits = args.awaits_response as
        | {
            mode: 'approval' | 'choice' | 'freeform';
            options?: Array<{ label: string; value: string }>;
            allow_freeform?: boolean;
          }
        | undefined;

      // ── Fire-and-forget path (current behaviour, byte-identical) ──
      if (!awaits) {
        try {
          orchestrator.postToBoard(
            agentRole,
            agentRunId,
            kind as 'message' | 'decision' | 'question' | 'deliverable' | 'handoff' | 'blocker',
            content,
          );
          // ── Blocker variant ──
          // Posts THEN aborts the runner. The agent is reporting an
          // impediment it can't resolve; the master ends gracefully
          // and the user sees the board entry. When the user later
          // sends a new message, `MasterLifecycle.sendUserMessage`
          // detects the master is ended and resurrects it with full
          // history. This is the "the runner stops here, human takes
          // over" path — distinct from `awaits_response` which
          // expects a structured reply mid-run.
          if (kind === 'blocker') {
            if (ctx.runner) {
              // Schedule the abort on the next microtask so the
              // tool_result still gets queued through the normal
              // dispatch path. Aborting synchronously here would
              // race with the runner's own "result emitted" book-
              // keeping and risk dropping the post from history.
              queueMicrotask(() => ctx.runner?.abort());
            }
            return ok(
              `Posted blocker to board as ${agentRole}. Session is ending — the user will see the ` +
                `impediment and decide how to intervene. Their next message will resurrect you with ` +
                `full history preserved.`,
            );
          }
          return ok(`Posted to board as ${agentRole} [${kind}]`);
        } catch (e) {
          return err(`Failed to post: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── Interactive path ──
      // Reuses the existing `plan_posted` / `question_posted` event
      // channels so the dashboard's BoardPanel + PlanPromptView /
      // QuestionPromptView render the card with no UI changes.
      const runner = ctx.runner;
      if (!runner) {
        // Fail-loud rather than silently degrade to a plain post:
        // the agent explicitly asked for a structured reply, so
        // returning ok() without one would defeat the whole point.
        return err(
          'post_to_board: awaits_response requires runner context (not available in this dispatch path). ' +
            'Either retry without awaits_response, or use submit_plan / ask_user.',
        );
      }

      const id = `board_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      if (awaits.mode === 'approval') {
        ctx.recordPlan?.(id, content);
        runner.emit('plan_posted', {
          type: 'plan',
          id,
          plan: content,
          kind: 'mutating',
        });
        const raw = await runner.waitForUserInput();
        let parsed: { approved?: boolean; feedback?: string; aborted?: boolean; interrupted?: boolean };
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { feedback: raw };
        }
        if (parsed.aborted) return err('User aborted before responding to post.');
        if (parsed.interrupted) {
          return err(`post_to_board interrupted: ${parsed.feedback ?? '(no details)'}`);
        }
        return ok(
          parsed.approved
            ? `Post approved by user.${parsed.feedback ? ` Feedback: ${parsed.feedback}` : ''}`
            : `Post rejected by user.${parsed.feedback ? ` Feedback: ${parsed.feedback}` : ''} Revise and post again if needed.`,
        );
      }

      // mode === 'choice' | 'freeform'
      const options = awaits.mode === 'choice' ? awaits.options ?? [] : [];
      const allowFreeform = awaits.mode === 'freeform' || !!awaits.allow_freeform;
      // Validate choice options to fail loud on bad input from the
      // model (duplicate values would confuse the radio state on the
      // dashboard).
      if (awaits.mode === 'choice') {
        if (options.length < 1) {
          return err('post_to_board: mode="choice" requires at least 1 option.');
        }
        const seen = new Set<string>();
        for (const o of options) {
          if (typeof o.label !== 'string' || typeof o.value !== 'string') {
            return err('post_to_board: each option must have string `label` and `value`.');
          }
          if (seen.has(o.value)) return err(`post_to_board: duplicate option value "${o.value}".`);
          seen.add(o.value);
        }
      }
      runner.emit('question_posted', {
        type: 'question',
        id,
        question: content,
        options,
        allowFreeform,
        header: kind === 'decision' ? 'Decision' : 'Question',
      });
      const raw = await runner.waitForUserInput();
      let parsed: { answer?: string; aborted?: boolean; interrupted?: boolean };
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { answer: raw };
      }
      if (parsed.aborted) return err('User aborted before responding to post.');
      if (parsed.interrupted) {
        return err(`post_to_board interrupted: ${parsed.answer ?? '(no details)'}`);
      }
      return ok(`User responded: ${parsed.answer ?? '(empty)'}`);
    },
  };
}

// ─── read_board ────────────────────────────────────────────────

function readBoard(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      since_id: { type: 'number', description: 'Only return entries after this ID (for incremental reads). Start with 0 to read from the beginning.' },
      limit: { type: 'number', description: 'Max entries to return (default: 50)' },
      mentions_me: { type: 'boolean', description: 'If true, only show entries that mention your role' },
      from_watermark: {
        type: 'boolean',
        description: 'If true and since_id is omitted, read from your last persisted watermark. Lets you skip the bookkeeping — only newer entries come back.',
      },
      mark_seen: {
        type: 'boolean',
        description: 'If true, advance your watermark after this read so the next `from_watermark` call skips entries returned here.',
      },
    },
  };

  return {
    name: 'read_board',
    // Board polling is canonical — master/subs re-read repeatedly to
    // discover new posts. With `from_watermark: true` results change
    // each call; without it, identical content returns are normal
    // "no new messages" signal. Either way, no dedup-marker.
    repeatable: true,
    description:
      'Read messages from the shared company board. Use `from_watermark: true` + `mark_seen: true` to do incremental reads without keeping `since_id` in your own context.',
    parameters,
    source: 'native',
    handler: async (args) => {
      const sinceId = args.since_id as number | undefined;
      const limit = args.limit as number | undefined;
      const mentionsMe = args.mentions_me as boolean | undefined;
      const fromWatermark = args.from_watermark as boolean | undefined;
      const markSeen = args.mark_seen as boolean | undefined;

      const entries = orchestrator.readBoard({
        sinceId,
        limit,
        mentionsRole: mentionsMe ? agentRole : undefined,
        // Only honour the watermark-based reads when we know the
        // agent's run id; otherwise fall through to the explicit
        // sinceId path.
        fromWatermarkAgentRunId:
          fromWatermark && agentRunId !== null ? agentRunId : undefined,
        markSeenForAgentRunId:
          markSeen && agentRunId !== null ? agentRunId : undefined,
      });

      if (entries.length === 0) {
        return ok(sinceId || fromWatermark ? 'No new board entries.' : 'Board is empty.');
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
    description:
      'Set your current agent status on the company board (working/waiting/reviewing/blocked/done).\n' +
      'Use "waiting" when you finish a task and are ready for the next one — this keeps you alive for reuse instead of being discarded.',
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
          cardId = orchestrator.findCardForAgent(agentRunId) ?? undefined;
        }

        if (!cardId) {
          return err('No card_id provided and no card currently assigned to this agent.');
        }

        const card = orchestrator.kanbanGetCard(cardId);
        if (!card) return err(`Card #${cardId} not found`);

        return okStructured(card);
      } catch (e) {
        return err(`Failed to read card: ${(e as Error).message}`);
      }
    },
  };
}
