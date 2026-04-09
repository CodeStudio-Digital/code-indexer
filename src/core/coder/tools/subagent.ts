import type { CoderTool, ToolResult, JsonSchema } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import type { ChatProvider } from '../providers/adapter.js';
import type { AgentMessage } from '../core/messages.js';
import { runSubagent, EXPLORE_ALLOWLIST, extractLastAssistantText } from './implement-subagent.js';

const EXPLORE_SYSTEM_PROMPT = `You are the EXPLORE subagent. A parent coder agent delegated a focused investigation to you. Your job:

1. Use the provided read-only tools to find what was asked.
2. Be terse. Return findings as \`file:line — what\` lines, or short bulleted facts.
3. NEVER speculate, NEVER write code, NEVER suggest implementation. Pure observation.

# CRITICAL — STOPPING RULES (must follow)

You have a HARD budget of about 8 tool-calling turns. If you go past that without producing your final summary, the parent receives nothing useful and your work is wasted. Therefore:

- **After at most 6 tool calls**, stop investigating and write your final summary.
- **If a search returns no results twice in a row**, stop searching that topic — the answer is likely "not found" and that itself is the finding. Report it explicitly: "No evidence of X in the codebase."
- **Never end a turn with only tool calls and no text** when you sense you're close to the limit. Always pair tool calls with a closing text block.
- **Your LAST turn must contain a text block** that summarizes everything. The parent only reads your final assistant text — without it, your run is a total loss.

# Output format

Final summary, max 25 lines, structured as:

\`\`\`
## Findings
- <fact 1 with file:line>
- <fact 2 with file:line>
- ...

## Confidence
<one line: high/medium/low + why>

## Open questions
<only if you couldn't fully answer, otherwise omit>
\`\`\`

# Token economy

Prefer \`get_file_skeleton\`, \`get_symbol_body\`, \`grep_code\`, \`find_references\` over \`read_file\` of whole files. Always pass \`max_tokens\`/\`limit\` parameters. If a tool returns "[output truncado]", refine the query — don't re-read.`;

export interface SubagentDeps {
  provider: ChatProvider;
  /**
   * Snapshot of the parent registry's tools at agent build time. The subagent
   * will create its own ToolRegistry containing only the allowlisted subset.
   */
  parentTools: CoderTool[];
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
      description: 'Max turns for the subagent loop (default 12, max 20).',
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
      const requestedMaxTurns = typeof args.max_turns === 'number' ? args.max_turns : 8;
      const maxTurns = Math.min(Math.max(1, requestedMaxTurns), 12);

      if (!task) return err('spawn_subagent: missing required parameter `task`');
      if (type !== 'explore') return err(`spawn_subagent: unknown type '${type}' (only 'explore' supported)`);

      const initialMessages: AgentMessage[] = [
        { role: 'user', content: [{ type: 'text', text: task }] },
      ];

      const result = await runSubagent(
        { provider: deps.provider, tools: deps.parentTools, ctx },
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

// Re-export for callers that import from subagent.ts (kept stable for the
// fallback summary helper that some scripts may use).
export { extractLastAssistantText };
