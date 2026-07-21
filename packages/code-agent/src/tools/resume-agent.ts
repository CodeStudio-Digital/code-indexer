/**
 * resume_agent — relaunch failed ephemeral subagents FROM WHERE THEY STOPPED.
 *
 * The parent LLM discovers this tool from the footer appended to any spawn
 * result that had failed agents ("resume_agent({spawn_id:…})"). It reads a
 * retained transcript from the resume registry, appends a reason-specific
 * continuation nudge, and relaunches through the existing parallel worker pool
 * under the SAME groupId (UI rows flip back to running with a retry chip).
 *
 * Selection: by default targets agents that failed for a re-tryable reason
 * (tool_budget / timeout / crash). `aborted` (user stopped it) and `quality`
 * (monologuing) resume ONLY when named explicitly in `agents`. Total attempts
 * are capped server-side — no budget knob for the model to burn.
 */
import type { CoderTool, ToolResult, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import { classifyResumeKind } from '@mcp/code-agent/tools/resume-nudges.js';
import { relaunchResumedAgents } from '@mcp/code-agent/tools/resume-run.js';
import {
  getGroup,
  tryAcquireResume,
  releaseResume,
  type ResumableAgentState,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';

const MAX_ATTEMPTS = Number(process.env.CODER_SPAWN_MAX_ATTEMPTS ?? 3) || 3;
const QUALITY_MAX_ATTEMPTS = 2;

const RESUME_DESC =
  'Relaunch failed subagent(s) from a previous spawn_agent, keeping their progress (transcript) intact. ' +
  'Use the `spawn=`/`group=` id from the spawn result. Prefer this over re-spawning a failed task from scratch. ' +
  'By default retries agents that ran out of budget, timed out, or crashed; pass `agents` to also retry aborted/low-quality ones. ' +
  'Add `guidance` when you know what went wrong (e.g. "the test command is pnpm test, not npm").';

function attemptCap(state: ResumableAgentState): number {
  return classifyResumeKind(state.reason, state.failureNote) === 'quality' ? QUALITY_MAX_ATTEMPTS : MAX_ATTEMPTS;
}

export function buildResumeAgentTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'resume_agent',
    description: RESUME_DESC,
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        spawn_id: { type: 'string', description: 'The `spawn=<id>` or `group=<id>` token from the spawn result header.' },
        agents: {
          type: 'array',
          items: { type: 'number' },
          description: '1-based agent numbers (matches "### Agent N"). Omit to retry every re-tryable failed agent.',
        },
        guidance: { type: 'string', description: 'Optional corrective instruction passed to the resumed agent(s).' },
      },
      required: ['spawn_id'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const spawnId = typeof args.spawn_id === 'string' ? args.spawn_id.trim() : '';
      if (!spawnId) return err('resume_agent: `spawn_id` is required.');
      const sessionId = ctx.runner?.sessionId;
      if (sessionId == null) return err('resume_agent: no active session.');

      const group = getGroup(sessionId, spawnId);
      if (!group) {
        return err(
          `resume_agent: spawn '${spawnId}' not found — resumable states live ~45min in this session only. ` +
          `Re-run the task with spawn_agent instead.`,
        );
      }
      if (!tryAcquireResume(sessionId, spawnId)) {
        return err(`resume_agent: spawn '${spawnId}' is already being resumed. Wait for it to finish.`);
      }

      try {
        // Completed agents may ALSO carry a transcript now (observability
        // retention — read_agent_transcript). Resumable = non-completed only.
        const resumable = group.agents.filter((a) => a.transcript && a.reason !== 'completed');
        if (resumable.length === 0) {
          return ok(`resume_agent: nothing to resume in '${spawnId}' — all agents completed or their state expired.`);
        }

        const explicit = Array.isArray(args.agents)
          ? new Set((args.agents as unknown[]).filter((n): n is number => typeof n === 'number').map((n) => n - 1))
          : null;

        const skipped: string[] = [];
        const targets: ResumableAgentState[] = [];
        for (const state of resumable) {
          const kind = classifyResumeKind(state.reason, state.failureNote);
          const chosen = explicit ? explicit.has(state.agentIndex) : kind !== 'aborted' && kind !== 'quality';
          if (!chosen) {
            if (!explicit) skipped.push(`#${state.agentIndex + 1} ${state.label} (${kind} — name it in \`agents\` to retry)`);
            continue;
          }
          if (state.attempt >= attemptCap(state)) {
            skipped.push(`#${state.agentIndex + 1} ${state.label} (attempt cap ${attemptCap(state)} reached — decompose the task instead)`);
            continue;
          }
          targets.push(state);
        }

        if (targets.length === 0) {
          const why = skipped.length ? `\nSkipped: ${skipped.join('; ')}` : '';
          return ok(`resume_agent: no eligible agents to resume in '${spawnId}'.${why}`);
        }

        const guidance = typeof args.guidance === 'string' ? args.guidance : undefined;
        const { text, usage } = await relaunchResumedAgents(deps, ctx, group, targets, guidance);
        const tail = skipped.length ? `\n\n[also skipped: ${skipped.join('; ')}]` : '';
        return { ...ok(text + tail), subUsage: usage };
      } finally {
        releaseResume(sessionId, spawnId);
      }
    },
  };
}
