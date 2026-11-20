import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { BROWSER_TOOL_NAMES } from './tools.js';

/** Exact built-in surface for the read-only research preset. */
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BROWSER_TOOL_NAMES,
  'web_search', 'web_fetch', 'view_image', 'get_tool_output',
  'ask_user', 'find_tools',
  'rag_search_docs', 'rag_read_doc', 'rag_doc_outline',
  'recall_memory', 'recall_conversation', 'recall_investigations',
  'read_file', 'list_directory', 'glob',
  'get_diagnostics', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
  'git_status', 'git_diff', 'git_log',
  'list_skill_namespaces', 'get_skills_list', 'get_skill_content',
  'mcp__get_project_pulse', 'mcp__get_project_overview', 'mcp__list_directory',
  'mcp__get_recently_modified_files', 'mcp__get_file_skeleton', 'mcp__get_symbol_body',
  'mcp__get_dependencies', 'mcp__get_dependents', 'mcp__find_references',
  'mcp__find_implementations', 'mcp__trace_usage', 'mcp__get_hierarchy',
  'mcp__grep_code', 'mcp__read_file', 'mcp__search', 'mcp__search_memory',
]);

export function isResearchToolAllowed(
  tool: Pick<CoderTool, 'name' | 'source' | 'mutates'>,
): boolean {
  if (RESEARCH_TOOL_NAMES.has(tool.name)) return true;
  return tool.source === 'mcp_external' && tool.mutates === false;
}
