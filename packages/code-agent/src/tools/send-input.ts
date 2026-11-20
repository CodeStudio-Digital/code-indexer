/**
 * send_input — interrupting cross-tier message delivery by agent path.
 *
 * Fourth slice of the unified agent tree. Same address/transport map as
 * `send_message`, with one extra effect: if the target's runner is
 * currently blocked on a `waitForUserInput()` (its own `ask_user` /
 * `submit_plan` / `submit_tasks` paused on the human), the wait is
 * forcibly released so the message lands NOW — not after the human
 * responds.
 *
 * v1 scope:
 *  - master → `/root/master/<role>-<id>` (running): pushUserMessage +
 *    runner.interruptWait. The blocked tool resolves with
 *    `{ interrupted: true }` and returns the structured envelope. The
 *    pushed text shows up on the next turn.
 *  - subordinate → `/root/master`: notify the master AND interrupt its
 *    pending wait (if any).
 *  - subordinate → `/root/master/<peer>-<id>`: refused. Peers cannot
 *    interrupt each other; that path is reserved for the master so
 *    coordination doesn't fork. Use `send_message` for fire-and-forget
 *    or `send_to_agent(wait=true)` to get a real answer.
 *  - master → `/root/master`: refused (you are the master).
 *  - subordinate → self: refused.
 *  - standalone: refused.
 *
 * What "interrupting" means here: the runner's pending `waitForUserInput`
 * resolves with the interrupted envelope, and the pushed text becomes the
 * next user message. It does NOT abort an in-flight tool call or LLM
 * stream — those run to completion. The interrupt only affects pause
 * points the runner explicitly opens.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { CompanyContext } from '@mcp/company/types.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { parseAgentPathTarget } from '@mcp/company/tools/path-resolution.js';

const SEND_INPUT_DESC =
  'Send urgent context to your parent or an owned descendant, using an exact path from list_agents. ' +
  'If the target has a pending question, release that question with an interrupted marker and apply the context at its next provider boundary. ' +
  'This does not abort an executing tool or provider stream. Only question/decision waits may be interrupted: ' +
  'tool permissions, plan/spec approvals and budget approvals remain with the human. It never supplies an approval. ' +
  'Peer interruption is refused; use send_message for peer notifications. ' +
  'Use only when new information supersedes a pending question; never repeat an uncertain send.';

export const sendInput: CoderTool = {
  name: 'send_input',
  description: SEND_INPUT_DESC,
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'read',
  effectBoundary: 'control',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target agent path. Use list_agents to discover valid paths.' },
      message: { type: 'string', description: 'Body of the message. Plain text.' },
    },
    required: ['to', 'message'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {

    const cc: CompanyContext | undefined = ctx.companyContext;
    if (!cc) {
      return err('send_input: no companyContext on this session — there is no peer to interrupt.');
    }
    const message = String(args.message ?? '').trim();
    if (!message) return err('send_input: message cannot be empty');
    const toPath = String(args.to ?? '').trim();
    const target = parseAgentPathTarget(toPath);
    if (!target) {
      return err(`send_input: '${toPath}' is not a valid agent path. Expected /root/master or /root/master/<role>-<agentRunId>.`);
    }

    if (cc.isMaster) {
      if (target.kind === 'master') {
        return err('send_input: you are the master — there is no /root/master peer to interrupt.');
      }
      const sub = cc.orchestrator.getSubordinate(target.agentRunId!);
      if (!sub) {
        return err(`send_input: no subordinate with agent_run_id=${target.agentRunId} in this session.`);
      }
      if (!cc.orchestrator.isSubordinateRunning(target.agentRunId!)) {
        return err(
          `send_input: subordinate ${sub.role} (run=${target.agentRunId}) is not running. ` +
          `Use forward_to_agent to reactivate it (preserves context) or spawn_subordinate_agent for a fresh one.`,
        );
      }
      sub.runner.pushUserMessage(`[From Master — interrupt]: ${message}`);
      const interrupted = sub.runner.interruptWait();
      const tail = interrupted ? 'released a pending wait' : 'queued for next turn (no wait was pending)';
      return ok(`send_input → /root/master/${sub.role}-${target.agentRunId}: ${tail}.`);
    }

    // Subordinate caller.
    if (target.kind === 'subordinate') {
      return err(
        'send_input: peer-to-peer interrupts are not allowed. Use send_message for fire-and-forget, ' +
        'or send_to_agent({ wait: true }) when you need an answer. Only the master can interrupt subordinates directly.',
      );
    }
    // sub → /root/master
    cc.orchestrator.notifyMasterAboutSubordinate(
      `[From @${cc.agentRole} run=${cc.agentRunId ?? '?'} — interrupt]: ${message}`,
    );
    const interrupted = cc.orchestrator.interruptMasterWait({
      kind: 'question',
      agentRunId: cc.agentRunId ?? undefined,
      role: cc.agentRole,
    });
    const tail = interrupted ? 'released a pending wait' : 'queued for next turn (no wait was pending)';
    return ok(`send_input → /root/master: ${tail}.`);
  },
};

export const sendInputTools: CoderTool[] = [sendInput];
