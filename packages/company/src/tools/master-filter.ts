/**
 * Master tool filter — strips code-level tools from the Master agent.
 *
 * The Master is an orchestrator: it delegates code work to subordinates.
 * It should only see management, overview, and communication tools.
 * This allowlist approach removes all code-reading/editing tools so the
 * Master's prompt stays lean and it doesn't accidentally read code directly.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';

/**
 * Native tools the Master is allowed to use.
 * Everything not in this set (and not a company tool) is stripped.
 */
export const MASTER_ALLOWED_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  // Interaction / orchestration
  'ask_user',
  'submit_plan',
  'submit_tasks',
  'list_tasks',
  'cancel_tasks',
  'delete_tasks',
  'archive_task_list',
  'execute_tasks',
  'execute_task',
  'task_complete',
  'update_task',
  'expand_toolset',
  'get_tool_output',
  'todo_write',
  'invoke_skill',
  // Minimal exploration (structure only, no code reading)
  'glob',
  // Unified agent-tree tools — observability + messaging across tiers.
  // Pure orchestration: no code reads, no mutations.
  'list_agents',
  'wait_agents',
  'send_message',
  'send_input',
  'spawn_agent',
  // Session-level objective + visual context. Useful for orchestration
  // (set goal once, re-read after compaction; load a screenshot the user
  // attached). Both are read-only and don't touch code.
  'goal',
  'create_goal',
  'get_goal',
  'update_goal',
  'view_image',
  // MCP resource discovery — read-only static content, doesn't expose code.
  'mcp_list_resources',
  'mcp_read_resource',
  // Session env — read-only for the master. It orchestrates, so it may
  // ANSWER a subordinate's env question (read/list/validate) but must not
  // mutate the shared store (no env_set / env_delete).
  'env_list',
  'env_read',
  'env_validate',
]);

/**
 * MCP tool suffixes the Master is allowed to use (after the project prefix).
 * e.g. if suffix is "get_project_pulse", then mcp__my_project__get_project_pulse is kept.
 *
 * Only high-level overview tools — NO code-reading tools like read_file,
 * get_file_skeleton, grep_code, get_symbol_body, etc.
 */
export const MASTER_ALLOWED_MCP_SUFFIXES: ReadonlySet<string> = new Set([
  'get_project_pulse',
  'list_projects',
  'get_project_stats',
  'get_project_overview',
  'get_architecture',
  'list_directory',
  'search',
  'get_recently_modified_files',
  // Project memory (Mem C) — read-only retrieval of distilled decisions/
  // gotchas from prior runs. The master plans delegation with this context
  // (e.g. quote a known gotcha in the spawn task); writes stay with
  // subordinates + the run-end distiller.
  'search_memory',
  'get_context_for',
]);

/**
 * Prefixes that identify company-specific tools (always kept for master).
 * These are board, kanban, and master delegation tools.
 */
const COMPANY_TOOL_PREFIXES = [
  'spawn_subordinate',
  'wait_for_subordinates',
  'resume_subordinate',
  'approve_subordinate',
  'answer_subordinate',
  'abort_subordinate',
  'list_subordinates',
  'list_company_projects',
  'forward_to_agent',
  'finalize_subordinates',
  'post_to_board',
  'read_board',
  // Shared drive (company-scoped file pool). Master must be able to read
  // artifacts dropped by subordinates and write briefs of its own.
  'write_shared_file',
  'read_shared_file',
  'list_shared_files',
  'delete_shared_file',
  'append_shared_file',
  'set_agent_status',
  'kanban_',
  // Design System Creator tools — master needs `ds_publish_version` and
  // `ds_set_version_status` to finish a round; without this prefix they
  // were stripped here, so the master never published anything.
  'ds_',
];

function isCompanyTool(name: string): boolean {
  return COMPANY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Extract the MCP suffix from a prefixed tool name.
 * e.g. "mcp__my_project__get_project_pulse" → "get_project_pulse"
 *      "mcp__read_file" → "read_file"
 */
function extractMcpSuffix(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  // Prefixed: mcp__{slug}__{tool} — find the last __ separator
  const rest = name.slice(5); // drop "mcp__"
  const lastSep = rest.lastIndexOf('__');
  if (lastSep >= 0) {
    return rest.slice(lastSep + 2);
  }
  // Unprefixed: mcp__{tool}
  return rest;
}

/**
 * Filter predicate for master agents. Returns true if the tool should be kept.
 */
export function isMasterAllowed(tool: CoderTool): boolean {
  const { name, source } = tool;

  // Company tools are always allowed
  if (isCompanyTool(name)) return true;

  // MCP tools: check suffix against allowlist
  const mcpSuffix = extractMcpSuffix(name);
  if (mcpSuffix !== null) {
    return MASTER_ALLOWED_MCP_SUFFIXES.has(mcpSuffix);
  }

  // Native tools: check against allowlist
  if (source === 'native') {
    return MASTER_ALLOWED_NATIVE_TOOLS.has(name);
  }

  // External MCP tools (mcp_external) — keep for now, they may be admin/management tools
  if (source === 'mcp_external') return true;

  // Default: strip
  return false;
}

/**
 * Filter an array of tools, keeping only those allowed for the Master agent.
 */
export function filterForMaster(tools: CoderTool[]): CoderTool[] {
  return tools.filter(isMasterAllowed);
}
