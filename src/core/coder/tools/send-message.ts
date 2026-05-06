/**
 * send_message — non-blocking cross-tier message delivery by agent path.
 *
 * Third slice of the unified agent tree (after `list_agents` and
 * `wait_agents`). Wraps the existing transport primitives so callers don't
 * have to know which one applies:
 *
 *  - master → `/root/master/<role>-<id>` (running sub): pushes a user
 *    message into the sub's runner queue. Same path the existing
 *    `forward_to_agent` master tool uses, minus the reactivation +
 *    attachment forwarding. Use `forward_to_agent` directly when you need
 *    those.
 *  - subordinate → `/root/master`: notifies the master via the same
 *    queue `ask_master` uses, but FIRE-AND-FORGET (no pause, no wait).
 *  - subordinate → `/root/master/<peer-role>-<id>`: routes through the
 *    inbox queue with `kind: 'notify'`, `wait: false`. Subordinate-tier
 *    messaging that already exists today, addressed by path instead of
 *    role.
 *  - master → `/root/master`: refused (you ARE the master).
 *  - subordinate → `/root/master/<self>`: refused.
 *  - standalone: refused (no peers).
 *
 * Blocking semantics are deliberately OUT of scope. Use `ask_master`,
 * `send_to_agent(wait=true)`, or `forward_to_agent` (for reactivation +
 * attachments) for those. This tool is the cheap, predictable path.
 */
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import type { CompanyContext } from '../company/types.js';
import { ok, err } from '../core/tool.js';
import { maybeTerse } from './descriptions.js';
import { parseAgentPathTarget } from './company/path-resolution.js';

const SEND_MESSAGE_DESC =
  'Non-blocking cross-tier message delivery by agent path. Path-addressed wrapper over forward_to_agent / ask_master / send_to_agent — picks the right transport based on caller and target.\n' +
  '\n' +
  'Targets:\n' +
  "  - `/root/master` — message goes to the master's queue (sub→master only).\n" +
  '  - `/root/master/<role>-<agentRunId>` — message goes to that subordinate.\n' +
  '\n' +
  "USE: when you have a one-way notification ('I'm done, here's the artifact path').\n" +
  "USE: master that already orchestrated the work and just needs to nudge a sub.\n" +
  "USE: peer-to-peer status updates that don't need an answer.\n" +
  "DON'T: use when you need an answer — `ask_master` and `send_to_agent(wait=true)` block correctly. send_message returns immediately even if no one read your message.\n" +
  "DON'T: use to forward user attachments — `forward_to_agent` handles that path.\n" +
  "DON'T: send to a dead/waiting sub from a sub — only the master can reactivate. Use list_agents to confirm status before sending.";

export const sendMessage: CoderTool = {
  name: 'send_message',
  description: maybeTerse(SEND_MESSAGE_DESC),
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Target agent path. Use list_agents to discover valid paths.',
      },
      message: { type: 'string', description: 'Body of the message. Plain text.' },
    },
    required: ['to', 'message'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const cc: CompanyContext | undefined = ctx.companyContext;
    if (!cc) {
      return err('send_message: no companyContext on this session — there is no peer to message.');
    }
    const message = String(args.message ?? '').trim();
    if (!message) return err('send_message: message cannot be empty');
    const toPath = String(args.to ?? '').trim();
    const target = parseAgentPathTarget(toPath);
    if (!target) {
      return err(`send_message: '${toPath}' is not a valid agent path. Expected /root/master or /root/master/<role>-<agentRunId>. Use list_agents to discover paths.`);
    }

    if (cc.isMaster) {
      // Master → master forbidden; master → sub goes through the orchestrator.
      if (target.kind === 'master') {
        return err("send_message: you are the master — there is no /root/master peer to message.");
      }
      const sub = cc.orchestrator.getSubordinate(target.agentRunId!);
      if (!sub) {
        return err(`send_message: no subordinate with agent_run_id=${target.agentRunId} in this session.`);
      }
      const isRunning = cc.orchestrator.isSubordinateRunning(target.agentRunId!);
      if (!isRunning) {
        return err(
          `send_message: subordinate ${sub.role} (run=${target.agentRunId}) is not running. ` +
          `Use forward_to_agent to reactivate it (preserves context) or spawn_subordinate_agent for a fresh one.`,
        );
      }
      sub.runner.pushUserMessage(`[From Master]: ${message}`);
      return ok(`Message delivered to /root/master/${sub.role}-${target.agentRunId}.`);
    }

    // Subordinate caller.
    if (target.kind === 'master') {
      cc.orchestrator.notifyMasterAboutSubordinate(
        `[From @${cc.agentRole} run=${cc.agentRunId ?? '?'}]: ${message}`,
      );
      return ok('Message delivered to /root/master (master notification queue).');
    }
    // Subordinate → subordinate via inbox (notify, fire-and-forget).
    if (target.agentRunId === cc.agentRunId) {
      return err('send_message: refusing to send to yourself.');
    }
    const sub = cc.orchestrator.getSubordinate(target.agentRunId!);
    if (!sub) {
      return err(`send_message: no subordinate with agent_run_id=${target.agentRunId} in this session.`);
    }
    try {
      const result = cc.orchestrator.inboxSend({
        fromAgentRunId: cc.agentRunId!,
        fromRole: cc.agentRole,
        toAgentRunId: target.agentRunId!,
        kind: 'notify',
        body: message,
        wait: false,
      });
      const tail = result.deliveredImmediately ? 'delivered' : 'pending';
      return ok(`Message ${result.message.id} queued for /root/master/${sub.role}-${target.agentRunId} (${tail}).`);
    } catch (e) {
      return err(`send_message: inbox send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const sendMessageTools: CoderTool[] = [sendMessage];
