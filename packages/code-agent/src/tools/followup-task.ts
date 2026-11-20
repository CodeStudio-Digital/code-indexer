/**
 * followup_task — send a follow-up task to a running spawned agent.
 *
 * Port of the multi-agent v2 semantic from OpenAI Codex (codex-rs/core/
 * src/tools/handlers/multi_agents_v2.rs). Different from `send_message`
 * in INTENT, not in transport:
 *
 *   send_message: a notification or status update. "I'm done." "Here's
 *                 the artifact path." Fire-and-forget; the receiver
 *                 reads it on their next turn but you don't expect any
 *                 specific next action from them.
 *
 *   followup_task: new work for the receiver to pick up. The framing
 *                  ("[Follow-up task]: ...") tells the receiving model
 *                  that this is a unit of work to plan/execute, not a
 *                  status ping. Reuses the same transport as
 *                  send_message under the hood.
 *
 * Why a separate tool instead of just calling send_message? The model
 * picks tools by name + description before reading the message body.
 * Splitting these makes the orchestration intent legible in the
 * tool-call log — easier for the human reviewing what the master
 * actually orchestrated, and easier for the receiving agent to route
 * the message internally.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { sendMessage } from '@mcp/code-agent/tools/send-message.js';

const FOLLOWUP_TASK_DESC =
  'Assign new work to a live subordinate using its exact path from list_agents. ' +
  'Keep the task self-contained. Use send_message for status updates and send_input to supersede a pending question. ' +
  'Human permission gates still apply. A finished subordinate is resumed by the master with resume_subordinate.';

export const followupTask: CoderTool = {
  name: 'followup_task',
  description: FOLLOWUP_TASK_DESC,
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  effectBoundary: 'control',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Exact owned descendant path returned by list_agents.',
      },
      task: {
        type: 'string',
        description:
          'Task description — what the receiving agent should plan and execute next. Be self-contained: the receiver only sees this text plus its own history, not your reasoning.',
      },
    },
    required: ['to', 'task'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {

    const to = String(args.to ?? '').trim();
    const task = String(args.task ?? '').trim();
    if (!to) return err('followup_task: `to` is required (agent path).');
    if (!task) return err('followup_task: `task` cannot be empty.');

    // Delegate to send_message with the follow-up framing. The receiver's
    // model sees the `[Follow-up task]:` prefix and tends to route it
    // through its planning loop instead of treating it as ambient context.
    return sendMessage.handler({ to, message: `[Follow-up task]: ${task}` }, ctx);
  },
};

export const followupTaskTools: CoderTool[] = [followupTask];
