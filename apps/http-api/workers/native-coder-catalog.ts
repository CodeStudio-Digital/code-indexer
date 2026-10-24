import type { CoderTool } from '../../../packages/code-agent/src/core/tool.js';

/** The development cohort grows only after each physical effect boundary is
 * integrated. Shells, external tools and nested runs need separate ownership. */
export const NATIVE_CODER_TOOL_NAMES = Object.freeze([
  'read_file', 'list_directory', 'glob', 'view_image',
  'get_tool_output',
  'code_exec',
  'spawn_agent', 'resume_agent', 'request_review', 'read_agent_transcript', 'workflow', 'execute_tasks', 'list_agents', 'wait_agents',
  'docs_deep_research', 'collect_agents', 'followup_task', 'send_input', 'send_message',
  'enter_worktree', 'exit_worktree',
  'self_review',
  'create_goal', 'get_goal', 'update_goal',
  'todo_write', 'update_todo', 'task_list', 'submit_tasks', 'list_tasks',
  'update_task', 'cancel_tasks', 'delete_tasks', 'archive_task_list', 'task_complete',
  'capability_catalog', 'find_tools', 'expand_toolset',
  'read_plan', 'save_note', 'list_notes', 'recall_investigations', 'recall_conversation',
  'remember', 'forget_memory',
  'create_skill',
  'http_request',
  'web_fetch', 'web_search',
  'get_diagnostics',
  'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
  'mcp_list_resources', 'mcp_read_resource',
  'api_import_openapi', 'api_list_requests', 'api_get_request', 'api_run_request',
  'api_update_request', 'api_mark_verified', 'api_run_collection',
  'mcp__search', 'mcp__grep_code',
  'mcp__export_docs', 'mcp__save_memory',
  'mcp__index_project',
  'mcp__list_agents', 'mcp__list_agent_runs', 'mcp__get_agent_run', 'mcp__get_agent_result',
  'mcp__get_recently_modified_files', 'mcp__get_dependencies', 'mcp__get_dependents',
  'mcp__get_project_overview', 'mcp__get_project_pulse',
  'mcp__rag_search_docs', 'mcp__rag_read_doc', 'mcp__rag_doc_outline',
  'mcp__get_costs', 'mcp__list_models', 'mcp__list_directory', 'mcp__read_file', 'mcp__get_file_skeleton',
  'mcp__get_hierarchy', 'mcp__find_implementations', 'mcp__get_symbol_body', 'mcp__find_references', 'mcp__semantic_neighbors', 'mcp__trace_usage', 'mcp__prepare_edit', 'mcp__get_repo_map', 'mcp__search_memory',
  'list_skill_namespaces', 'get_skills_list', 'get_skill_content', 'invoke_skill',
  'recall_memory',
  'rag_search_docs', 'rag_read_doc', 'rag_doc_outline',
  'ask_user', 'decision_gate', 'submit_plan', 'submit_spec',
  'write_file', 'create_file', 'edit_file', 'multi_edit', 'apply_patch', 'manage_path',
  'diagram_create', 'diagram_update', 'diagram_read', 'diagram_list', 'diagram_export',
  'run_command', 'exec_command', 'write_stdin', 'list_sessions', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_add', 'git_commit',
  'preview_open', 'preview_close', 'preview_navigate', 'preview_viewport', 'preview_console', 'preview_network',
  'preview_eval', 'preview_screenshot', 'preview_inspect_css', 'preview_performance', 'preview_memory', 'preview_storage',
  'preview_snapshot', 'preview_click', 'preview_fill', 'preview_type', 'preview_press', 'preview_wait_for',
  'preview_scroll', 'preview_hover', 'preview_double_click', 'preview_right_click',
  'browser_open', 'browser_snapshot', 'browser_extract', 'browser_click', 'browser_fill', 'browser_press',
  'browser_screenshot', 'browser_close',
  'db_list', 'db_schema', 'db_query', 'db_command',
]);
/** These capabilities exist only inside an owned child; never add them to a root attempt. */
export const NATIVE_CODER_CHILD_TOOL_NAMES = Object.freeze(['record_memo']);
const readOnly = new Set(['read_file', 'list_directory', 'glob', 'view_image', 'get_tool_output', 'mcp__search', 'mcp__grep_code', 'list_sessions']);
const knowledgeTools = new Set(['list_skill_namespaces', 'get_skills_list', 'get_skill_content', 'invoke_skill', 'recall_memory', 'rag_search_docs', 'rag_read_doc', 'rag_doc_outline']);
const interactionTools = new Set(['ask_user', 'decision_gate', 'submit_plan']);
const shellTools = new Set(['run_command', 'exec_command', 'git_status', 'git_diff', 'git_log', 'git_branch', 'git_add', 'git_commit']);
const indexReads = new Set(['mcp__list_agents', 'mcp__list_agent_runs', 'mcp__get_agent_run', 'mcp__get_agent_result', 'mcp__get_recently_modified_files', 'mcp__get_dependencies', 'mcp__get_dependents', 'mcp__get_project_overview', 'mcp__get_project_pulse', 'mcp__rag_search_docs', 'mcp__rag_read_doc', 'mcp__rag_doc_outline', 'mcp__get_costs', 'mcp__list_models', 'mcp__list_directory', 'mcp__read_file', 'mcp__get_file_skeleton', 'mcp__get_hierarchy', 'mcp__find_implementations', 'mcp__get_symbol_body', 'mcp__find_references', 'mcp__semantic_neighbors', 'mcp__trace_usage', 'mcp__prepare_edit', 'mcp__get_repo_map', 'mcp__search_memory']);

export function nativeCoderWorkspaceAccess(tools: readonly CoderTool[], internalTree = false): 'read_only' | 'exclusive_write' {
  let access: 'read_only' | 'exclusive_write' = 'read_only';
  for (const tool of tools) {
    // Collector state is child-local; it is never a root catalog capability.
    if (internalTree && NATIVE_CODER_CHILD_TOOL_NAMES.includes(tool.name)) {
      if (tool.source !== 'native' || tool.effectBoundary !== undefined || tool.mutates !== false || tool.parallelSafe !== true
        || tool.executionClass !== 'read' || tool.riskLevel !== 'read') {
        throw new Error('Native child memo lost its bounded collector contract');
      }
      continue;
    }
    if (['spawn_agent', 'resume_agent', 'request_review', 'workflow', 'execute_tasks', 'docs_deep_research'].includes(tool.name)) {
      if (tool.source !== 'native' || tool.effectBoundary !== 'nested' || tool.parallelSafe === true) throw new Error('Native spawn lost its owned tree contract');
      if (tool.name === 'execute_tasks' && (tool.mutates !== true || tool.parallelSafe !== false || tool.riskLevel !== 'write')) {
        throw new Error('Native task execution lost its sequential owned tree contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'enter_worktree' || tool.name === 'exit_worktree') {
      if (tool.source !== 'native' || tool.mutates !== true || tool.parallelSafe !== false
        || tool.riskLevel !== 'admin' || tool.effectBoundary !== 'shell') throw new Error('Native worktree lost its sequential workspace boundary');
      access = 'exclusive_write'; continue;
    }
    if (['send_message', 'send_input', 'followup_task'].includes(tool.name)) {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.effectBoundary !== 'control') throw new Error('Native messaging lost its owned sequential mailbox contract');
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'collect_agents') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.repeatPolicy !== 'pollable' || tool.effectBoundary !== undefined) throw new Error('Native collection lost its bounded owned job contract');
      continue;
    }
    if (tool.name === 'read_agent_transcript') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.effectBoundary !== undefined) throw new Error('Native transcript lost its read contract');
      continue;
    }
    if (tool.name === 'list_agents') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== true
        || tool.riskLevel !== 'read' || tool.repeatPolicy !== 'volatile' || tool.effectBoundary !== undefined) {
        throw new Error('Native tree inventory lost its fresh owned read contract');
      }
      continue;
    }
    if (tool.name === 'wait_agents') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.repeatPolicy !== 'pollable' || tool.effectBoundary !== undefined) {
        throw new Error('Native agent wait lost its bounded owned read contract');
      }
      continue;
    }
    if (isNativeExternalMcpTool(tool)) { access = 'exclusive_write'; continue; }
    if (!NATIVE_CODER_TOOL_NAMES.includes(tool.name)) throw new Error(`Native development catalog does not support ${tool.name}`);
    if (['mcp__list_agents', 'mcp__list_agent_runs', 'mcp__get_agent_run', 'mcp__get_agent_result'].includes(tool.name)
      && tool.repeatPolicy !== 'volatile') throw new Error('Native agent query lost its fresh read contract');
    if (tool.name === 'self_review') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.effectBoundary !== 'control') {
        throw new Error('Native self-review lost its owned session control contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'code_exec') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== true
        || tool.riskLevel !== 'read' || tool.effectBoundary !== 'nested' || tool.repeatPolicy !== 'volatile') {
        throw new Error('Native script lost its owned nested execution contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'mcp__save_memory') {
      if (tool.source !== 'mcp' || tool.capabilityProvenance?.kind !== 'mcp_internal'
        || tool.capabilityProvenance.providerId !== 'code-indexer'
        || tool.capabilityProvenance.provenanceRef !== 'mcp-internal:code-indexer'
        || tool.mutates !== true || tool.parallelSafe !== false || tool.riskLevel !== 'write' || tool.effectBoundary !== 'database') {
        throw new Error('Native MCP memory lost its owned project mutation contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'mcp__export_docs') {
      if (tool.source !== 'mcp' || tool.capabilityProvenance?.kind !== 'mcp_internal'
        || tool.capabilityProvenance.providerId !== 'code-indexer'
        || tool.capabilityProvenance.provenanceRef !== 'mcp-internal:code-indexer'
        || tool.mutates !== true || tool.parallelSafe !== false || tool.riskLevel !== 'admin' || tool.effectBoundary !== 'control') {
        throw new Error('Native document export lost its owned publication contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'mcp__index_project') {
      if (tool.source !== 'mcp' || tool.capabilityProvenance?.kind !== 'mcp_internal'
        || tool.capabilityProvenance.providerId !== 'code-indexer'
        || tool.capabilityProvenance.provenanceRef !== 'mcp-internal:code-indexer'
        || tool.mutates !== true || tool.parallelSafe !== false || tool.riskLevel !== 'admin' || tool.effectBoundary !== 'control') {
        throw new Error('Native indexing lost its owned project mutation contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'manage_path') {
      if (tool.source !== 'native' || tool.mutates !== true || tool.parallelSafe !== false
        || tool.riskLevel !== 'write' || tool.effectBoundary !== 'filesystem') throw new Error('Native path management lost its sequential filesystem contract');
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'submit_spec') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.interactive !== true || tool.effectBoundary !== 'filesystem') {
        throw new Error('Native specification lost its sequential approval and filesystem contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'create_skill') {
      if (tool.source !== 'native' || tool.mutates !== true || tool.parallelSafe !== false || tool.riskLevel !== 'write' || tool.effectBoundary !== 'control') throw new Error('Native skill authoring lost its owned write contract');
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'remember' || tool.name === 'forget_memory') {
      if (tool.source !== 'native' || tool.mutates !== true || tool.parallelSafe !== false
        || tool.riskLevel !== 'write' || tool.effectBoundary !== 'database') throw new Error('Native memory lost its owned mutation contract');
      access = 'exclusive_write'; continue;
    }
    if (['read_plan', 'save_note', 'list_notes', 'recall_investigations', 'recall_conversation'].includes(tool.name)) {
      const write = tool.name === 'save_note';
      if (tool.source !== 'native' || tool.mutates !== write || tool.parallelSafe !== !write
        || tool.riskLevel !== (write ? 'write' : 'read') || tool.effectBoundary !== (write ? 'control' : undefined)) {
        throw new Error('Native session data lost its owned storage contract');
      }
      if (write) access = 'exclusive_write';
      continue;
    }
    if (['capability_catalog', 'find_tools', 'expand_toolset'].includes(tool.name)) {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false || tool.riskLevel !== 'read'
        || tool.effectBoundary !== 'control' || tool.executionClass !== 'control') throw new Error('Native discovery lost its immutable catalog contract');
      access = 'exclusive_write'; continue;
    }
    if (['create_goal', 'get_goal', 'update_goal'].includes(tool.name)) {
      const write = tool.name !== 'get_goal';
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== !write || tool.riskLevel !== 'read'
        || tool.effectBoundary !== (write ? 'control' : undefined) || (write && tool.executionClass !== 'control')) {
        throw new Error('Native goal lost its sequential journal contract');
      }
      if (write) access = 'exclusive_write';
      continue;
    }
    if (['todo_write', 'update_todo', 'task_list', 'submit_tasks', 'list_tasks',
      'update_task', 'cancel_tasks', 'delete_tasks', 'archive_task_list', 'task_complete'].includes(tool.name)) {
      const write = tool.name !== 'list_tasks';
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== !write || tool.riskLevel !== 'read'
        || tool.effectBoundary !== (write ? 'control' : undefined) || write && tool.executionClass !== 'control') {
        throw new Error('Native tasks lost their sequential journal contract');
      }
      if (write) access = 'exclusive_write';
      continue;
    }
    if (tool.name.startsWith('diagram_')) {
      const read = tool.name === 'diagram_read' || tool.name === 'diagram_list';
      if (tool.source !== 'native' || tool.mutates !== !read || tool.parallelSafe !== read
        || tool.riskLevel !== (read ? 'read' : 'write') || tool.effectBoundary !== (read ? undefined : 'filesystem')) {
        throw new Error('Native diagram tool lost its filesystem contract');
      }
      if (!read) access = 'exclusive_write';
      continue;
    }
    if (tool.name.startsWith('lsp_')) {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.effectBoundary !== undefined) throw new Error('Native LSP lost its owned sequential read contract');
      continue;
    }
    if (tool.name === 'mcp_list_resources' || tool.name === 'mcp_read_resource') {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== true
        || tool.riskLevel !== 'read' || tool.effectBoundary !== undefined) throw new Error('Native MCP resources lost their bounded read contract');
      continue;
    }
    if (tool.name === 'get_diagnostics') {
      if (tool.source !== 'native' || tool.effectBoundary !== 'shell' || tool.mutates !== true
        || tool.parallelSafe !== false || tool.riskLevel !== 'execute') throw new Error('Native diagnostics lost its owned command contract');
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'get_tool_output' && (tool.source !== 'native' || tool.mutates !== false
      || tool.parallelSafe !== true || tool.riskLevel !== 'read')) throw new Error('Native output recovery lost its read contract');
    if (tool.name === 'http_request') {
      if (tool.source !== 'native' || tool.effectBoundary !== 'network' || tool.mutates !== true
        || tool.parallelSafe !== false || tool.riskLevel !== 'execute' || typeof tool.riskOf !== 'function') throw new Error('Native HTTP lost its physical network contract');
      access = 'exclusive_write'; continue;
    }
    if (tool.name === 'web_fetch' || tool.name === 'web_search') {
      if (tool.source !== 'native' || tool.effectBoundary !== undefined || tool.mutates !== false
        || tool.parallelSafe !== true || tool.riskLevel !== 'read') throw new Error('Native public web lost its read network contract');
      continue;
    }
    if (tool.name.startsWith('api_')) {
      const read = tool.name === 'api_list_requests' || tool.name === 'api_get_request';
      const run = tool.name === 'api_run_request' || tool.name === 'api_run_collection';
      if (tool.source !== 'native' || tool.mutates !== !read || tool.parallelSafe !== read
        || tool.riskLevel !== (read ? 'read' : run ? 'execute' : 'write')
        || (!read && tool.effectBoundary !== 'control')) throw new Error('Native API client lost its project control contract');
      // Reads inspect the project store; writers/network require one attempt.
      if (!read) access = 'exclusive_write';
      continue;
    }
    if (tool.name.startsWith('db_')) {
      const write = tool.name === 'db_query' || tool.name === 'db_command';
      if (tool.source !== 'native' || tool.effectBoundary !== 'database' || tool.parallelSafe !== false
        || tool.mutates !== write || tool.riskLevel !== (write ? 'write' : 'read')
        || (write && typeof tool.riskOf !== 'function')) {
        throw new Error('Native database tool lost its physical database contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name.startsWith('browser_')) {
      if (tool.source !== 'native' || tool.effectBoundary !== 'control' || tool.parallelSafe !== false
        || tool.mutates !== false || tool.riskLevel !== 'read') {
        throw new Error('Native research browser lost its physical control contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (tool.name.startsWith('preview_')) {
      const mutates = ['eval', 'click', 'fill', 'type', 'press', 'double_click', 'right_click'].includes(tool.name.slice(8));
      const execute = mutates || ['preview_open', 'preview_close', 'preview_navigate'].includes(tool.name);
      if (tool.source !== 'native' || tool.effectBoundary !== 'control' || tool.parallelSafe !== false
        || tool.mutates !== mutates || tool.riskLevel !== (execute ? 'execute' : 'read')) {
        throw new Error('Native preview tool lost its physical control contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (interactionTools.has(tool.name)) {
      if (tool.source !== 'native' || tool.mutates !== false || tool.parallelSafe !== false
        || tool.riskLevel !== 'read' || tool.interactive !== true || tool.effectBoundary !== 'control') {
        throw new Error('Native interaction tool lost its control contract');
      }
      access = 'exclusive_write'; continue;
    }
    if (['exec_command', 'write_stdin', 'list_sessions'].includes(tool.name)) {
      const read = tool.name === 'list_sessions';
      if (tool.source !== 'native' || tool.mutates !== !read || tool.parallelSafe !== read
        || tool.riskLevel !== (read ? 'read' : 'execute')) throw new Error('Native persistent command lost its ownership contract');
    }
    if (knowledgeTools.has(tool.name)) {
      if (tool.name.startsWith('rag_') && (tool.parallelSafe !== true || tool.effectBoundary !== undefined || tool.riskOf !== undefined)) {
        throw new Error('Native documentation lost its bounded read contract');
      }
      if (tool.source !== 'native' || tool.mutates !== false || tool.riskLevel !== 'read') {
        throw new Error('Native knowledge tool lost its read contract');
      }
      continue;
    }
    if (tool.name.startsWith('mcp__') && (tool.source !== 'mcp'
      || tool.capabilityProvenance?.kind !== 'mcp_internal'
      || tool.capabilityProvenance.providerId !== 'code-indexer'
      || tool.capabilityProvenance.provenanceRef !== 'mcp-internal:code-indexer'
      || tool.mutates !== false || tool.parallelSafe !== true || tool.riskLevel !== 'read' || tool.effectBoundary !== undefined)) {
      throw new Error('Native index read lacks its first-party read contract');
    }
    if (!readOnly.has(tool.name) && !indexReads.has(tool.name)) {
      const boundary = tool.name === 'write_stdin' ? 'control' : shellTools.has(tool.name) ? 'shell' : 'filesystem';
      if (tool.effectBoundary !== boundary) throw new Error('Native tool lost its physical effect boundary');
      access = 'exclusive_write';
    }
  }
  return access;
}

/** Host-owned MCP dispatch requires an exact catalogue revision. Local stdio
 * additionally requires physical descendant containment attested by the pool. */
export function isNativeExternalMcpTool(tool: CoderTool): boolean {
  const transport = tool.externalMcpTransport;
  return tool.source === 'mcp_external' && tool.capabilityProvenance?.kind === 'mcp_external'
    && tool.capabilityProvenance.providerId === 'mcp-external'
    && !!transport && (transport.transport === 'streamable_http' || transport.transport === 'sse'
      || (transport.transport === 'stdio' && transport.processTreeContained === true))
    && !!transport.catalogueRevision && transport.serverId === tool.capabilityProvenance.serverId
    && tool.capabilityProvenance.provenanceRef === 'mcp-server:' + transport.serverId + ':' + transport.catalogueRevision
    && tool.name === 'ext_' + transport.serverId + '__' + transport.toolName
    && tool.mutates === true && tool.parallelSafe === false && tool.riskLevel === 'write'
    && tool.effectBoundary === 'external_mcp';
}
