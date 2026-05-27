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
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';

const FOLLOWUP_TASK_DESC =
  'Send a NEW TASK to a running spawned agent. Routing is identical to send_message; the difference is intent — ' +
  'this is framed to the receiver as work to plan and execute, not a notification.\n' +
  '\n' +
  'Targets:\n' +
  '  - `/root/master/<role>-<agentRunId>` — master→sub. The sub treats the payload as a fresh task.\n' +
  '\n' +
  "USE: when a sub finished its previous task and you want to hand it the next one without re-spawning.\n" +
  "USE: when you (master) want to pipeline work through an existing sub session — cheaper than spawning fresh.\n" +
  "DON'T: use for status acknowledgements ('thanks, continue') — that's send_message.\n" +
  "DON'T: use for sub→master or sub→sub. Subs ask the master for work via ask_master.\n" +
  "DON'T: use to interrupt a sub that's blocked on its own ask_user/submit_plan — that's send_input.";

export const followupTask: CoderTool = {
  name: 'followup_task',
  description: maybeTerse(FOLLOWUP_TASK_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target agent path (e.g. `/root/master/frontend-7a3f`). Use list_agents to discover paths.',
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
