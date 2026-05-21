import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { runSubagent, EXPLORE_ALLOWLIST, IMPLEMENT_ALLOWLIST, extractLastAssistantText, runParallelAgents } from '@mcp/code-agent/tools/implement-subagent.js';
import {
  isGlobalSubAgentCacheEnabled,
  tryGlobalSubAgentRead,
  writeGlobalSubAgentResult,
} from '@mcp/services/sub-agent-cache/index.js';

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
  /**
   * When set, subagents use this provider (possibly from a different
   * provider family) instead of the parent's. Created from admin subagent config.
   */
  subagentProvider?: ChatProvider;
}

function describeProvider(provider: ChatProvider): { provider: string; model: string; label: string } {
  const providerName = provider.name || 'provider';
  const model = provider.model || 'default';
  return { provider: providerName, model, label: `${providerName}:${model}` };
}

const IMPLEMENT_SYSTEM_PROMPT = `You are an IMPLEMENTATION subagent. The parent agent delegated a specific change to you to execute end-to-end and return a brief summary.

You have read AND write access to the project files plus shell. You do NOT have access to interactive prompts (no submit_plan, no ask_user, no submit_tasks): the parent already decided WHAT to do — your job is to DO it.

# Rules
1. Use the tools to read what you need, then make the edits.
2. Verify your work (run tests / lints when relevant).
3. Stop and write a final summary listing files changed + a 1-line description of what each change does.
4. NEVER end your run with only tool calls and no text — the parent reads ONLY your final assistant text. If you hit max_turns without a summary, the entire effort is wasted.
5. If you discover the task can't be done as described (missing prerequisite, ambiguous scope), stop and report findings instead of guessing.

# Output format

## Files changed
- src/foo.ts — added \`bar()\` per the task
- src/foo.test.ts — covered the happy path

## Verification
- ran \`npm test foo\`: passing
- ran \`tsc --noEmit\`: clean

## Notes (only if relevant)
<edge cases, assumptions, follow-ups>
`;

const subagentSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['explore', 'implement'],
      description:
        '"explore" (default): read-only investigation; subagent returns a findings summary. "implement": read+write+shell; subagent executes a delegated change and returns a list of files modified. Implement is meant for self-contained changes where the parent has already decided what to do.',
    },
    task: {
      type: 'string',
      description: 'Self-contained natural-language description of what the subagent must do. Include all context needed — the subagent has no access to the parent conversation.',
    },
    max_turns: {
      type: 'number',
      description: 'Max turns for the subagent loop (default 50, min 50).',
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Implement-mode only: optional whitelist of project-relative paths the subagent is allowed to write to. When provided, edits outside the list are refused. Omit for unscoped implement (full project write access).',
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
      const filesArg = Array.isArray(args.files)
        ? (args.files as unknown[]).filter((f): f is string => typeof f === 'string' && f.length > 0)
        : undefined;

      if (!task) return err('spawn_subagent: missing required parameter `task`');
      if (type !== 'explore' && type !== 'implement') {
        return err(`spawn_subagent: unknown type '${type}' (supported: 'explore', 'implement')`);
      }

      const initialMessages: AgentMessage[] = [
        { role: 'user', content: [{ type: 'text', text: task }] },
      ];

      const parentSessionId = ctx.runner?.sessionId;
      const activeProvider = deps.subagentProvider ?? deps.provider;
      const providerInfo = describeProvider(activeProvider);
      console.log(
        `[coder s=${parentSessionId ?? '?'}] spawn_subagent: type=${type} provider=${providerInfo.label} max_turns=${maxTurns}` +
        (filesArg ? ` files=[${filesArg.join(', ')}]` : ''),
      );

      // SubAgent cache check — when `MCP_PIPELINES_SUB_AGENT_CACHE=1` AND
      // the boot installed the global cache, identical (prompt, project,
      // agent_type) calls within the TTL window short-circuit here.
      // Cache key includes:
      //   - task (raw prompt)
      //   - type ('explore' | 'implement') — different system prompts
      //     produce different outputs, so they get separate cache lines
      //   - files (if `implement` with pathScope) — different scope =
      //     different cache line
      // Sessions are NOT part of the key — same task across sessions is
      // legitimately the same answer.
      const cacheKeyInput = {
        prompt: task,
        agentType: type === 'explore' ? 'Explore' as const : 'general-purpose' as const,
        recentMutations: filesArg ?? [],
      };
      if (isGlobalSubAgentCacheEnabled()) {
        const hit = tryGlobalSubAgentRead<{
          header: string;
          body: string;
          usage: import('@mcp/code-agent/core/messages.js').ChatUsage;
        }>(cacheKeyInput, { sessionId: parentSessionId });
        if (hit) {
          console.log(
            `[coder s=${parentSessionId ?? '?'}] spawn_subagent: CACHE HIT type=${type} ` +
            `ageMs=${hit.ageMs} hitCount=${hit.hitCount}`,
          );
          return {
            ...ok(`[cache-hit ageMs=${hit.ageMs} hits=${hit.hitCount}]\n\n` + hit.result.header + hit.result.body),
            subUsage: hit.result.usage,
          };
        }
      }

      const isImplement = type === 'implement';
      const systemPrompt = isImplement ? IMPLEMENT_SYSTEM_PROMPT : EXPLORE_SYSTEM_PROMPT;
      const allowlist = isImplement ? IMPLEMENT_ALLOWLIST : EXPLORE_ALLOWLIST;

      if (deps.sessionStore && parentSessionId != null) {
        try {
          deps.sessionStore.recordSessionInput({
            session_id: parentSessionId,
            kind: 'subagent_prompt',
            source_label: `subagent:${type}`,
            content: systemPrompt,
            meta: { task, max_turns: maxTurns, files: filesArg },
          });
        } catch {
          // best-effort
        }
      }

      const result = await runSubagent(
        {
          provider: activeProvider,
          tools: deps.parentTools,
          ctx,
          sessionId: parentSessionId,
          // PR-6 R23: propagate v2 framing + features to the subagent.
          agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
        },
        {
          systemPrompt,
          allowlist,
          initialMessages,
          maxTurns,
          // pathScope only when the caller declared files for an implement
          // run. Explore stays unscoped (read-only) and unscoped implement
          // mirrors the parent's full project write access.
          pathScope: isImplement && filesArg && filesArg.length > 0 ? filesArg : undefined,
        }
      );

      const cached = result.usage.cache_read_input_tokens ?? 0;
      const header = `[subagent provider=${providerInfo.provider} model=${providerInfo.model} type=${type} reason=${result.reason} input=${result.usage.input_tokens} output=${result.usage.output_tokens} cache_hit=${cached}]\n\n`;
      const body = result.finalText
        ? result.finalText
        : `(subagent did not produce a final summary — reason=${result.reason}. Recommendation: retry with a narrower task or investigate directly with MCP tools.)`;

      // Cache the fresh result so the next identical call short-circuits.
      // Only cache "good" runs (with final text). Reasons like 'max_turns'
      // or 'aborted' without text mean the subagent didn't actually
      // finish — caching that would propagate a bad answer.
      if (isGlobalSubAgentCacheEnabled() && result.finalText) {
        writeGlobalSubAgentResult(
          cacheKeyInput,
          { header, body, usage: result.usage },
          { sessionId: parentSessionId },
        );
      }

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
      const activeProvider = deps.subagentProvider ?? deps.provider;
      const providerInfo = describeProvider(activeProvider);
      console.log(
        `[coder s=${parentSessionId ?? '?'}] spawn_agents: ${agentSpecs.length} parallel provider=${providerInfo.label} labels=[${agentSpecs.map((a) => a.label).join(', ')}] group=${groupId}`,
      );

      // Emit group start so the UI can create the parallel agents container.
      ctx.runner?.emit('agents_group_start', {
        groupId,
        provider: providerInfo.provider,
        model: providerInfo.model,
        agents: agentSpecs.map((a, i) => ({
          index: i,
          label: a.label,
          provider: providerInfo.provider,
          model: providerInfo.model,
        })),
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
        {
          provider: activeProvider,
          tools: deps.parentTools,
          ctx,
          sessionId: parentSessionId,
          agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
        },
        agentSpecs,
        EXPLORE_SYSTEM_PROMPT,
        EXPLORE_ALLOWLIST,
        (progress) => {
          ctx.runner?.emit('agent_progress', {
            groupId,
            provider: providerInfo.provider,
            model: providerInfo.model,
            ...progress,
          });
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
      const header = `[parallel agents: ${results.length} agents, provider=${providerInfo.provider} model=${providerInfo.model}, input=${totalUsage.input_tokens} output=${totalUsage.output_tokens} cache_hit=${cached}]\n\n`;

      const body = results
        .map((r, i) => {
          const meta = `[provider=${providerInfo.provider} model=${providerInfo.model} reason=${r.reason} tools=${r.toolCallCount} input=${r.usage.input_tokens} output=${r.usage.output_tokens}]`;
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
