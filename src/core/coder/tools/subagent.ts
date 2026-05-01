import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolResult, JsonSchema } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import type { ChatProvider } from '../providers/adapter.js';
import type { AgentMessage } from '../core/messages.js';
import type { SessionStore } from '../sessions/store.js';
import { runSubagent, EXPLORE_ALLOWLIST, extractLastAssistantText, runParallelAgents } from './implement-subagent.js';

const EXPLORE_SYSTEM_PROMPT = `You are the EXPLORE subagent. A parent coder agent delegated a focused investigation to you.

1. Use the provided read-only tools to find what was asked.
2. Return findings as \`file:line — what\` lines, or short bulleted facts.
3. NEVER speculate, NEVER write code, NEVER suggest implementation. Pure observation.

# CRITICAL — ALWAYS PRODUCE A SUMMARY

The parent agent ONLY reads your final assistant text. If you hit max_turns without a text summary, your entire investigation is WASTED — the parent gets "(no summary produced)" and all your tool calls were for nothing.

**Rules:**
- Every few turns, write a partial text summary of what you found so far. This ensures the parent gets SOMETHING even if you hit max_turns.
- When you have gathered enough info, stop and write your complete final summary.
- If a search returns no results twice in a row, stop — report "No evidence of X" as a finding.
- NEVER end your run with only tool calls and no text.

# Output format

## Findings
- <fact 1 with file:line>
- <fact 2 with file:line>
...

## Confidence
<high/medium/low + why>

## Open questions
<only if relevant>

# Token economy

Prefer get_file_skeleton, get_symbol_body, grep_code, find_references over read_file of whole files. Always pass max_tokens/limit parameters.`;

export interface SubagentDeps {
  provider: ChatProvider;
  /**
   * Snapshot of the parent registry's tools at agent build time. The subagent
   * will create its own ToolRegistry containing only the allowlisted subset.
   */
  parentTools: CoderTool[];
  /**
   * Optional — when present, every sub-agent system prompt is mirrored into
   * `coder_session_inputs` on the parent session for the Input tab.
   */
  sessionStore?: SessionStore;
}

const subagentSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['explore'],
      description: 'Subagent type. Currently only "explore" (read-only investigation) is supported.',
    },
    task: {
      type: 'string',
      description: 'Self-contained natural-language description of what the subagent must find. Include all context needed — the subagent has no access to the parent conversation.',
    },
    max_turns: {
      type: 'number',
      description: 'Max turns for the subagent loop (default 50).',
    },
  },
  required: ['type', 'task'],
} as unknown as JsonSchema;

/**
 * Build the spawn_subagent native tool. The factory captures the parent's
 * provider and tool list so each invocation can spin up an isolated runner
 * via the shared `runSubagent()` helper in implement-subagent.ts.
 *
 * Cost accounting: the subagent's full ChatUsage is returned in
 * `result.subUsage`. The parent runner adds it to its own totalUsage and
 * the SessionStore bumps the persisted counters — so subagent tokens are
 * NEVER hidden from the user/dashboard.
 */
export function buildSubagentTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'spawn_subagent',
    description:
      'Delegate a focused, read-only investigation to a fresh subagent that runs in an isolated context window. Use this when a task requires many exploratory tool calls (file reads, greps, reference lookups) whose intermediate output would otherwise pollute your own history. The subagent returns only its final summary; its token usage is added to this session.',
    parameters: subagentSchema,
    source: 'native',
    handler: async (args, ctx): Promise<ToolResult> => {
      const type = String(args.type ?? 'explore');
      const task = typeof args.task === 'string' ? args.task : '';
      const MIN_TURNS = 50;
      const requestedMaxTurns = typeof args.max_turns === 'number' ? args.max_turns : 100;
      const maxTurns = Math.max(MIN_TURNS, requestedMaxTurns);

      if (!task) return err('spawn_subagent: missing required parameter `task`');
      if (type !== 'explore') return err(`spawn_subagent: unknown type '${type}' (only 'explore' supported)`);

      const initialMessages: AgentMessage[] = [
        { role: 'user', content: [{ type: 'text', text: task }] },
      ];

      const parentSessionId = ctx.runner?.sessionId;
      console.log(
        `[coder s=${parentSessionId ?? '?'}] spawn_subagent: type=${type} max_turns=${maxTurns}`,
      );

      if (deps.sessionStore && parentSessionId != null) {
        try {
          deps.sessionStore.recordSessionInput({
            session_id: parentSessionId,
            kind: 'subagent_prompt',
            source_label: 'subagent:explore',
            content: EXPLORE_SYSTEM_PROMPT,
            meta: { task, max_turns: maxTurns },
          });
        } catch {
          // best-effort
        }
      }

      const result = await runSubagent(
        { provider: deps.provider, tools: deps.parentTools, ctx, sessionId: parentSessionId },
        {
          systemPrompt: EXPLORE_SYSTEM_PROMPT,
          allowlist: EXPLORE_ALLOWLIST,
          initialMessages,
          maxTurns,
          // No pathScope: explore is read-only and may need to roam.
        }
      );

      const cached = result.usage.cache_read_input_tokens ?? 0;
      const header = `[subagent type=${type} reason=${result.reason} input=${result.usage.input_tokens} output=${result.usage.output_tokens} cache_hit=${cached}]\n\n`;
      const body = result.finalText
        ? result.finalText
        : `(subagent did not produce a final summary — reason=${result.reason}. Recommendation: retry with a narrower task or investigate directly with MCP tools.)`;

      return {
        ...ok(header + body),
        subUsage: result.usage,
      };
    },
  };
}

// ─── spawn_agents (parallel) ──────────────────────────────────

const spawnAgentsSchema: JsonSchema = {
  type: 'object',
  properties: {
    agents: {
      type: 'array',
      description:
        'Array of agent tasks to run in parallel. Each gets its own isolated context window. ' +
        'Only their final summaries come back — intermediate tool results never enter your history.',
      items: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'Self-contained natural-language description of what this agent must find. ' +
              'Include all context needed — the agent has no access to the parent conversation.',
          },
          label: {
            type: 'string',
            description: 'Short label (3-5 words) shown in the UI during execution.',
          },
          max_turns: {
            type: 'number',
            description: 'Max turns for this agent (default 50).',
          },
        },
        required: ['task', 'label'],
      },
      minItems: 1,
      maxItems: 8,
    },
  },
  required: ['agents'],
} as unknown as JsonSchema;

/**
 * Build the spawn_agents tool for running multiple explore subagents in parallel.
 * Each agent gets its own isolated CoderRunner. Progress events are emitted to
 * the parent runner so the dashboard can show real-time per-agent status.
 */
export function buildSpawnAgentsTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'spawn_agents',
    description:
      'Run multiple read-only investigations IN PARALLEL. Each agent gets its own isolated context ' +
      'window — their intermediate tool results never enter your history. Only the combined summaries ' +
      'come back. Use this when you need to explore 2+ independent topics simultaneously. ' +
      'The token cost of all agents IS counted in this session.',
    parameters: spawnAgentsSchema,
    source: 'native',
    handler: async (args, ctx): Promise<ToolResult> => {
      const rawAgents = args.agents;
      if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
        return err('spawn_agents: `agents` must be a non-empty array');
      }
      if (rawAgents.length > 8) {
        return err('spawn_agents: maximum 8 agents allowed');
      }

      const agentSpecs = rawAgents.map((a: Record<string, unknown>) => ({
        task: typeof a.task === 'string' ? a.task : '',
        label: typeof a.label === 'string' ? a.label : 'agent',
        maxTurns: Math.max(50, typeof a.max_turns === 'number' ? a.max_turns : 100),
      }));

      for (const s of agentSpecs) {
        if (!s.task) return err('spawn_agents: each agent must have a non-empty `task`');
      }

      const groupId = randomUUID().slice(0, 8);
      const parentSessionId = ctx.runner?.sessionId;
      console.log(
        `[coder s=${parentSessionId ?? '?'}] spawn_agents: ${agentSpecs.length} parallel — labels=[${agentSpecs.map((a) => a.label).join(', ')}] group=${groupId}`,
      );

      // Emit group start so the UI can create the parallel agents container.
      ctx.runner?.emit('agents_group_start', {
        groupId,
        agents: agentSpecs.map((a, i) => ({ index: i, label: a.label })),
      });

      if (deps.sessionStore && parentSessionId != null) {
        try {
          deps.sessionStore.recordSessionInput({
            session_id: parentSessionId,
            kind: 'subagent_prompt',
            source_label: `subagent:explore-parallel:${groupId}`,
            content: EXPLORE_SYSTEM_PROMPT,
            meta: {
              group_id: groupId,
              agent_count: agentSpecs.length,
              labels: agentSpecs.map((a) => a.label),
            },
          });
        } catch {
          // best-effort
        }
      }

      const { results, totalUsage } = await runParallelAgents(
        { provider: deps.provider, tools: deps.parentTools, ctx, sessionId: parentSessionId },
        agentSpecs,
        EXPLORE_SYSTEM_PROMPT,
        EXPLORE_ALLOWLIST,
        (progress) => {
          ctx.runner?.emit('agent_progress', { groupId, ...progress });
        },
      );

      // Emit group end.
      ctx.runner?.emit('agents_group_end', {
        groupId,
        totalUsage,
        agentCount: results.length,
        successCount: results.filter((r) => r.reason === 'completed').length,
      });

      // Build combined text result for the parent conversation.
      const cached = totalUsage.cache_read_input_tokens ?? 0;
      const header = `[parallel agents: ${results.length} agents, input=${totalUsage.input_tokens} output=${totalUsage.output_tokens} cache_hit=${cached}]\n\n`;

      const body = results
        .map((r, i) => {
          const meta = `[reason=${r.reason} tools=${r.toolCallCount} input=${r.usage.input_tokens} output=${r.usage.output_tokens}]`;
          const text = r.finalText || '(no summary produced)';
          return `### Agent ${i + 1}: ${r.label}\n${meta}\n${text}`;
        })
        .join('\n\n---\n\n');

      return {
        ...ok(header + body),
        subUsage: totalUsage,
      };
    },
  };
}

// Re-export for callers that import from subagent.ts (kept stable for the
// fallback summary helper that some scripts may use).
export { extractLastAssistantText };
