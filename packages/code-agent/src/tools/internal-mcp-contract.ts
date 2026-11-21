import type { CoderTool } from '@mcp/code-agent/core/tool.js';

// First-party contracts, checked against the index tools' declared access in
// apps/http-api/workers/__tests__/native-index-definitions.test.ts.
// Remote MCP annotations never grant read/parallel execution rights here.
export const INTERNAL_MCP_ACCESS = {
  search: 'read', grep_code: 'read',
  get_file_skeleton: 'read', read_file: 'read', list_directory: 'read',
  get_recently_modified_files: 'read', get_dependencies: 'read', get_dependents: 'read',
  find_references: 'read', get_hierarchy: 'read', find_implementations: 'read',
  trace_usage: 'read', get_symbol_body: 'read', prepare_edit: 'read', semantic_neighbors: 'read',
  search_memory: 'read', save_memory: 'write',
  get_costs: 'read', export_docs: 'admin', list_models: 'read',
  rag_search_docs: 'read', rag_read_doc: 'read', rag_doc_outline: 'read',
  index_project: 'admin', get_project_overview: 'read', get_project_pulse: 'read', get_repo_map: 'read',
} as const;

type Contract = Required<Pick<CoderTool, 'mutates' | 'riskLevel' | 'parallelSafe'>> & Pick<CoderTool, 'effectBoundary' | 'codeExecReturnsData'>;
const independentReads = new Set(['search', 'grep_code', 'get_recently_modified_files', 'get_dependencies', 'get_dependents', 'get_project_overview', 'get_project_pulse', 'rag_search_docs', 'rag_read_doc', 'rag_doc_outline', 'get_costs', 'list_models', 'list_directory', 'read_file', 'get_file_skeleton', 'get_hierarchy', 'find_implementations', 'get_symbol_body', 'find_references', 'semantic_neighbors', 'trace_usage', 'prepare_edit', 'get_repo_map', 'search_memory']);
export function internalMcpContract(name: string): Contract {
  const access = Object.hasOwn(INTERNAL_MCP_ACCESS, name)
    ? INTERNAL_MCP_ACCESS[name as keyof typeof INTERNAL_MCP_ACCESS] : 'write';
  return {
    ...(name === 'list_models' ? { codeExecReturnsData: true } : {}),
    ...(name === 'export_docs' ? { effectBoundary: 'control' as const } : {}),
    ...(name === 'index_project' ? { effectBoundary: 'control' as const } : {}),
    ...(name === 'save_memory' ? { effectBoundary: 'database' as const } : {}),
    mutates: access !== 'read',
    riskLevel: access,
    // Other reads may wait for shared services; independence needs its own proof.
    parallelSafe: independentReads.has(name),
  };
}
