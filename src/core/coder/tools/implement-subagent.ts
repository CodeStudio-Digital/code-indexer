/**
 * Generalized subagent runner — extracted from src/coder/tools/subagent.ts so
 * that both the read-only `spawn_subagent` (explore) flow AND the new
 * `execute_task` mode='subagent' flow can spin up isolated CoderRunners with
 * a curated tool registry, parameterized system prompt, and (optionally) a
 * path scope for filesystem/shell tools.
 *
 * The implement-subagent variant additionally:
 *   - whitelists write_file/edit_file/create_file/run_command;
 *   - wraps fs/shell tools with a path-scope sandbox that LOGS (warning mode)
 *     reads/writes outside the declared task files but DOES NOT block them;
 *   - parses a structured `<result>{...}</result>` block from the subagent's
 *     final assistant message into a TaskResult.
 *
 * The wrapper deliberately uses warning mode instead of strict blocking
 * because subagents can have legitimate reasons to read an imported file
 * outside the declared scope (e.g. to look at a type definition). The parent
 * orchestrator gets the violation list in the TaskResult and can decide.
 */
import type { CoderTool, ToolContext, ToolResult } from '../core/tool.js';
import type { AgentMessage, ChatUsage } from '../core/messages.js';
import type { ChatProvider } from '../providers/adapter.js';
import { ToolRegistry } from '../core/registry.js';
import { CoderRunner, SUBAGENT_TOOL_RESULT_CAP, extractPathsFromToolArgs, isPathInsideScope } from '../core/runner.js';
import type { CoderTask, TaskResult, TaskReference } from '../sessions/types.js';

export interface SubagentSpec {
  systemPrompt: string;
  /** Set of tool names from the parent registry that the subagent may use. */
  allowlist: Set<string>;
  initialMessages: AgentMessage[];
  maxTurns: number;
  pushTimeCap?: number;
  /** When set, fs/shell tools log (do not block) reads/writes outside this list. */
  pathScope?: string[];
}

export interface SubagentRunResult {
  reason: 'completed' | 'max_turns' | 'aborted' | 'error' | 'plan_required';
  finalText: string;
  usage: ChatUsage;
  /** Path strings flagged by the path-scope wrapper, in arrival order. */
  sandboxViolations: string[];
}

export interface SubagentParent {
  provider: ChatProvider;
  /** Snapshot of the parent registry's tools — filtered by `spec.allowlist`. */
  tools: CoderTool[];
  ctx: ToolContext;
}

/**
 * Spin up an isolated CoderRunner constrained by `spec`, run it to completion,
 * and return the structured result.
 *
 * The subagent inherits the parent's provider instance (no extra connection
 * pool needed for sequential subagents), the same overlay/cwd, and the parent
 * abort signal. It does NOT receive a `ctx.runner` back-reference — submit_plan,
 * ask_user and submit_tasks intentionally fail inside subagents because the
 * subagent only talks to its parent via the final `<result>` block, never to
 * the user directly.
 */
export async function runSubagent(parent: SubagentParent, spec: SubagentSpec): Promise<SubagentRunResult> {
  const sandboxViolations: string[] = [];

  // Build the filtered + (optionally) path-wrapped registry.
  const subRegistry = new ToolRegistry();
  for (const tool of parent.tools) {
    if (!spec.allowlist.has(tool.name)) continue;
    subRegistry.register(spec.pathScope ? wrapToolForPathScope(tool, spec.pathScope, sandboxViolations) : tool);
  }

  const subContext: ToolContext = {
    cwd: parent.ctx.cwd,
    projectName: parent.ctx.projectName,
    overlay: parent.ctx.overlay,
    signal: parent.ctx.signal,
    // Intentionally NO `runner` — interactive tools fail inside the subagent.
    planMode: false,
  };

  const subRunner = new CoderRunner({
    provider: parent.provider,
    registry: subRegistry,
    systemPrompt: spec.systemPrompt,
    toolContext: subContext,
    initialMessages: spec.initialMessages,
    maxTurns: spec.maxTurns,
    pushTimeCap: spec.pushTimeCap ?? SUBAGENT_TOOL_RESULT_CAP,
  });

  if (parent.ctx.signal) {
    parent.ctx.signal.addEventListener('abort', () => subRunner.abort(), { once: true });
  }

  let result: { totalUsage: ChatUsage; reason: SubagentRunResult['reason'] };
  try {
    result = await subRunner.run();
  } catch (e) {
    return {
      reason: 'error',
      finalText: e instanceof Error ? e.message : String(e),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      sandboxViolations,
    };
  }

  return {
    reason: result.reason,
    finalText: extractLastAssistantText(subRunner.messages),
    usage: result.totalUsage,
    sandboxViolations,
  };
}

/**
 * Read-only allowlist for the explore subagent (legacy `spawn_subagent`).
 * Pure MCP code-indexer tools — nothing that touches the filesystem or shell.
 */
export const EXPLORE_ALLOWLIST = new Set<string>([
  'mcp__get_project_pulse',
  'mcp__get_project_overview',
  'mcp__get_project_stats',
  'mcp__get_architecture',
  'mcp__list_directory',
  'mcp__list_projects',
  'mcp__get_recently_modified_files',
  'mcp__get_file_skeleton',
  'mcp__get_file_structure',
  'mcp__get_symbol_body',
  'mcp__get_symbol_details',
  'mcp__get_class_members',
  'mcp__get_dependencies',
  'mcp__get_dependents',
  'mcp__find_references',
  'mcp__find_implementations',
  'mcp__trace_usage',
  'mcp__get_hierarchy',
  'mcp__grep_code',
  'mcp__read_file',
  'mcp__search',
  'mcp__search_by_kind',
  'mcp__search_concepts',
  'mcp__query_snapshots',
  'mcp__get_context_for',
  'mcp__prepare_edit',
]);

/**
 * Allowlist for an implementation subagent. Includes the read tools needed to
 * navigate the local file scope plus the mutating tools that actually carry
 * out the task. Notably absent: submit_plan, submit_tasks, ask_user,
 * spawn_subagent, execute_task, task_complete — subagents do not interact
 * with the user or recurse into other subagents.
 */
export const IMPLEMENT_ALLOWLIST = new Set<string>([
  // Read tools (essential subset of the explore allowlist)
  'mcp__read_file',
  'mcp__get_file_skeleton',
  'mcp__get_symbol_body',
  'mcp__grep_code',
  'mcp__find_references',
  'mcp__find_implementations',
  'mcp__list_directory',
  'mcp__get_dependencies',
  // Native filesystem reads (faster than MCP for paths the subagent owns)
  'read_file',
  // Mutating filesystem tools — the whole point of an implement subagent
  'write_file',
  'edit_file',
  'create_file',
  // Shell — gated by the parent runner's plan-mode allowlist for read-only,
  // but inside an approved task scope the subagent gets the full set.
  'run_command',
]);

/**
 * Format a TaskReference into a readable Markdown-style block for the
 * implement subagent's system prompt. Snippets get fenced code blocks; symbol
 * and file refs get a single line. Doc refs are dumped verbatim.
 */
function formatReference(r: TaskReference): string {
  switch (r.type) {
    case 'symbol':
      return `**Symbol**: \`${r.value}\``;
    case 'file':
      return `**File reference**: \`${r.value}\` (read it via mcp__read_file or get_file_skeleton)`;
    case 'snippet':
      return `**Snippet**:\n\n\`\`\`\n${r.value}\n\`\`\``;
    case 'doc':
      return `**Doc**:\n${r.value}`;
    default:
      return String(r);
  }
}

function buildImplementSystemPrompt(task: CoderTask): string {
  const fileList = task.files.length > 0 ? task.files.map((f) => `- ${f}`).join('\n') : '(none declared)';
  const refs = (task.references && task.references.length > 0)
    ? task.references.map(formatReference).join('\n\n')
    : '(no references — work from the files in scope)';

  return `You are an IMPLEMENTATION subagent. The orchestrator delegated ONE specific task to you. Execute it end-to-end with the tools available, then stop.

# Your task
${task.title}

${task.description}

# Files in scope (you may read AND write these)
${fileList}

# Curated references the orchestrator pre-extracted
${refs}

# Rules
1. Stay inside the files listed above. Reading other files is allowed but logged as a sandbox warning that the orchestrator will see.
2. Make the changes, then VERIFY them when appropriate (run tests/build/lint via run_command).
3. STOP when the task is done. Do not start adjacent work even if you notice opportunities.
4. Your LAST assistant message MUST contain a JSON block in this exact format:
   \`\`\`
   <result>{"summary": "<≤200 chars: what was done>", "files_modified": ["path1", "path2"], "errors": "<only on failure>"}</result>
   \`\`\`
   The orchestrator parses this. If the block is absent or unparseable, the task is treated as failed.
5. You CANNOT call submit_plan, submit_tasks, ask_user, spawn_subagent, execute_task, or task_complete. You answer only to the orchestrator via your final <result> block.
6. Be terse. Don't narrate every file read — just do the work and report.

# Token economy
Prefer get_file_skeleton + get_symbol_body over read_file of whole files. Use grep_code/find_references for navigation. Avoid re-reading files you already read this turn.`;
}

/**
 * High-level entry point for executing a single CoderTask in an isolated
 * implementation subagent. Builds the system prompt + initial message, calls
 * runSubagent, and parses the final `<result>` block into a TaskResult.
 */
export async function runImplementSubagent(parent: SubagentParent, task: CoderTask): Promise<TaskResult> {
  const systemPrompt = buildImplementSystemPrompt(task);
  const initialMessages: AgentMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Begin the task now. When done, output your final <result> block as instructed. ` +
            `Reminder: stay inside the files listed in the system prompt.`,
        },
      ],
    },
  ];

  const result = await runSubagent(parent, {
    systemPrompt,
    allowlist: IMPLEMENT_ALLOWLIST,
    initialMessages,
    // Implement subagents need more turns than explore — they read, edit,
    // verify, and report. 20 is the practical ceiling before token cost
    // outweighs the savings vs inline.
    maxTurns: 20,
    pathScope: task.files,
  });

  const parsed = parseResultBlock(result.finalText);
  if (parsed) {
    return {
      summary: parsed.summary || '(subagent returned an empty summary)',
      files_modified: parsed.files_modified ?? [],
      errors: parsed.errors,
      sandbox_violations: result.sandboxViolations.length > 0 ? result.sandboxViolations : undefined,
      subagent_usage: result.usage as unknown as Record<string, number | undefined>,
    };
  }

  // No structured result — surface what we can so the orchestrator gets
  // actionable info instead of a silent "failed".
  return {
    summary: 'subagent did not return a structured <result> block',
    files_modified: [],
    errors: result.finalText
      ? `subagent reason=${result.reason}. Last assistant text: ${result.finalText.slice(0, 400)}`
      : `subagent reason=${result.reason}; produced no text output`,
    sandbox_violations: result.sandboxViolations.length > 0 ? result.sandboxViolations : undefined,
    subagent_usage: result.usage as unknown as Record<string, number | undefined>,
  };
}

/**
 * Permissive parser for the subagent's `<result>{...}</result>` JSON block.
 * Tries the strict pattern first, then falls back to JSON-parsing the whole
 * final text in case the model forgot the wrapper.
 */
function parseResultBlock(finalText: string): { summary: string; files_modified?: string[]; errors?: string } | null {
  if (!finalText) return null;
  // Strict: <result>{...}</result>
  const match = finalText.match(/<result>([\s\S]*?)<\/result>/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
        return parsed as { summary: string; files_modified?: string[]; errors?: string };
      }
    } catch {
      /* fall through */
    }
  }
  // Permissive: try parsing the whole text as JSON.
  try {
    const parsed = JSON.parse(finalText.trim());
    if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
      return parsed as { summary: string; files_modified?: string[]; errors?: string };
    }
  } catch {
    /* fall through */
  }
  // Last resort: search for a JSON object that has a "summary" key anywhere.
  const objMatch = finalText.match(/\{[\s\S]*?"summary"[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && typeof parsed.summary === 'string') {
        return parsed as { summary: string; files_modified?: string[]; errors?: string };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Wrap a tool's handler so any path arguments outside `pathScope` are
 * recorded into `violations` (and the call still proceeds — warning mode).
 *
 * We don't touch the parent's tool object — return a clone with a new handler.
 */
function wrapToolForPathScope(tool: CoderTool, pathScope: string[], violations: string[]): CoderTool {
  const fsOrShellTools = new Set([
    'write_file',
    'edit_file',
    'create_file',
    'read_file',
    'mcp__read_file',
    'run_command',
  ]);
  if (!fsOrShellTools.has(tool.name)) return tool;

  return {
    ...tool,
    handler: async (args, ctx): Promise<ToolResult> => {
      const paths = extractPathsFromToolArgs(tool.name, args);
      for (const p of paths) {
        if (!isPathInsideScope(p, pathScope)) {
          violations.push(`${tool.name}:${p}`);
        }
      }
      return tool.handler(args, ctx);
    },
  };
}

// ─── shared helpers ────────────────────────────────────────────

/**
 * Walk the message history backwards and return the most recent assistant
 * message that contains a non-empty text block. Returns '' if none.
 *
 * Exported because both `spawn_subagent` (legacy) and the new
 * `runImplementSubagent` need to extract the final summary text.
 */
export function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim().length > 0) parts.push(b.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}
