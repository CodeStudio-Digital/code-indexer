import type { CoderTool } from '../core/tool.js';
import type { ToolTier } from './tiers.js';
import { getToolTier } from './tiers.js';
import { canInvokeInsideCodeExec } from './code-exec-eligibility.js';
import { PREVIEW_WORKFLOW_FLOOR, ROLE_CAPABILITY_FLOOR } from './tool-priority.js';
import { isEssentialCompanyTool } from '../core/runner/company-essentials.js';

/**
 * A working surface, not a ranking of every registered tool. Discovery is a
 * separate surface: the authorized registry remains available to code_exec.
 * Adding a plugin must not displace search, edits, process polling or recovery.
 * These groups are provider-independent; JSON/freeform adaptation happens later.
 */
const CORE = [
  'find_tools', 'code_exec', 'glob', 'mcp__grep_code', 'mcp__search',
  'apply_patch', 'edit_file', 'get_tool_output', 'ask_user', 'task_list',
  'remember', 'recall_memory', 'recall_conversation',
] as const;

// Optional groups are admitted whole. Never publish a start without its finish.
const OPTIONAL_GROUPS: readonly (readonly string[])[] = [
  ['mcp__get_file_skeleton', 'mcp__get_symbol_body', 'mcp__prepare_edit'],
  ['git_status', 'git_diff'],
  ['rag_search_docs', 'rag_read_doc'],
  ['invoke_skill'],
];

export interface WorkflowCatalogOptions {
  activeTiers: ReadonlySet<ToolTier> | null;
  externalToolTiers?: ReadonlyMap<string, ToolTier>;
  requiredPinnedTools?: ReadonlySet<string>;
  company?: { isMaster: boolean };
  agenticChat?: boolean;
  cap: number;
  hardLimit?: number;
}

export function selectWorkflowCatalog(
  authorized: readonly CoderTool[], options: WorkflowCatalogOptions,
): { tools: CoderTool[]; protectedNames: ReadonlySet<string> } {
  const byName = new Map(authorized.map(tool => [tool.name, tool]));
  const selected = new Map<string, CoderTool>();
  const add = (name: string) => {
    const tool = byName.get(name);
    if (tool) selected.set(name, tool);
  };
  const first = (...names: string[]) => {
    const name = names.find(candidate => byName.has(candidate));
    if (name) add(name);
  };
  for (const name of CORE) add(name);
  first('read_file', 'mcp__read_file');
  first('list_directory', 'mcp__list_directory');
  if (byName.has('exec_command') && byName.has('write_stdin')) {
    add('exec_command');
    add('write_stdin');
  } else {
    // A reduced registry still needs a usable execution path. Existing process
    // handles must remain pollable even if creating new processes was disabled.
    add('run_command');
    add('write_stdin');
  }
  if (!byName.has('apply_patch')) {
    add('create_file');
    add('write_file');
  }

  for (const tool of authorized) {
    const active = options.activeTiers === null
      || options.activeTiers.has(getToolTier(tool.name, options.externalToolTiers));
    // expand_toolset only duplicates discovery in stable mode. Every other
    // top-level-only control needs a direct route, including plugin interactions.
    const directControl = !canInvokeInsideCodeExec(tool) && tool.name !== 'expand_toolset';
    if (directControl
      || (active && (PREVIEW_WORKFLOW_FLOOR.has(tool.name) || ROLE_CAPABILITY_FLOOR.has(tool.name)))
      || (options.company && isEssentialCompanyTool(tool.name, options.company.isMaster))
      || options.requiredPinnedTools?.has(tool.name)) add(tool.name);
  }
  // Paired orchestration is part of the contract, not a hotness heuristic.
  if (selected.has('spawn_agent') || selected.has('resume_agent')) {
    add('spawn_agent'); add('resume_agent'); add('collect_agents');
  }
  if (selected.has('task_complete')) add('execute_tasks');
  if (byName.has('workflow')) add('workflow'); // registered only for Ultra
  if (options.agenticChat) {
    add('create_chat');
    add('send_chat_message');
    add('reply_chat_message');
  }

  // Reduced/custom runners can disable the scripting bridge. In that case an
  // active tool cannot be deferred to a route that does not exist.
  if (!byName.has('code_exec')) {
    for (const tool of authorized) {
      if (options.activeTiers === null
        || options.activeTiers.has(getToolTier(tool.name, options.externalToolTiers))) add(tool.name);
    }
  }

  const protectedNames = new Set(selected.keys());
  if (options.hardLimit !== undefined && selected.size > options.hardLimit) {
    throw new Error(`Tool projection cannot fit required capabilities: ${selected.size} required, verified provider limit ${options.hardLimit}. Adjust the model or required tool configuration.`);
  }
  for (const group of OPTIONAL_GROUPS) {
    const additions = group.filter(name => byName.has(name) && !selected.has(name));
    if (selected.size + additions.length > options.cap) continue;
    for (const name of additions) add(name);
  }
  // Deliberately do not fill spare slots with arbitrary registry/plugin tools.
  return { tools: [...selected.values()], protectedNames };
}
