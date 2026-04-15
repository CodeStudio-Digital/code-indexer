/**
 * Master tool filter — strips code-level tools from the Master agent.
 *
 * The Master is an orchestrator: it delegates code work to subordinates.
 * It should only see management, overview, and communication tools.
 * This allowlist approach removes all code-reading/editing tools so the
 * Master's prompt stays lean and it doesn't accidentally read code directly.
 */
import type { CoderTool } from '../../core/tool.js';

/**
 * Native tools the Master is allowed to use.
 * Everything not in this set (and not a company tool) is stripped.
 */
export const MASTER_ALLOWED_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  // Interaction / orchestration
  'ask_user',
  'submit_plan',
  'submit_tasks',
  'execute_task',
  'task_complete',
  'expand_toolset',
  'get_tool_output',
  'todo_write',
  'invoke_skill',
  // Minimal exploration (structure only, no code reading)
  'glob',
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
  'set_agent_status',
  'kanban_',
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
