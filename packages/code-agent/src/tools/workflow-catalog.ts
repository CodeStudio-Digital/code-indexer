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
  /** Budget of the workflow surface (base selection + optional groups). */
  cap: number;
  /** Ceiling on the final catalog: model tool limit and verified provider limit. */
  maxTotal?: number;
  hardLimit?: number;
  /**
   * The surface optional groups are budgeted on, when it is not `authorized`:
   * with child chats, the switch-off surface (child-chat tools out, the tools
   * they replace in). Which groups fit is then decided as with the switch
   * off, so swapping the delegation tools moves no other tool; a freed slot
   * stays empty.
   */
  budgetSurface?: readonly CoderTool[];
}

/**
 * Contextual floors depend on the surface the session runs in (preview, a
 * specialist role, Company, host pins). They are added on top of the workflow
 * and never consume the budget of its optional groups.
 */
function isContextFloor(tool: CoderTool, options: WorkflowCatalogOptions): boolean {
  const active = options.activeTiers === null
    || options.activeTiers.has(getToolTier(tool.name, options.externalToolTiers));
  return (active && (PREVIEW_WORKFLOW_FLOOR.has(tool.name) || ROLE_CAPABILITY_FLOOR.has(tool.name)))
    || (!!options.company && isEssentialCompanyTool(tool.name, options.company.isMaster))
    || !!options.requiredPinnedTools?.has(tool.name);
}

function selectRequired(
  authorized: readonly CoderTool[], byName: ReadonlyMap<string, CoderTool>,
  options: WorkflowCatalogOptions, withContextFloors: boolean,
): Map<string, CoderTool> {
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
  if (!byName.has('apply_patch')) add('write_file'); // creates and replaces

  for (const tool of authorized) {
    // expand_toolset only duplicates discovery in stable mode. Every other
    // top-level-only control needs a direct route, including plugin interactions.
    const directControl = !canInvokeInsideCodeExec(tool) && tool.name !== 'expand_toolset';
    if (directControl || (withContextFloors && isContextFloor(tool, options))) add(tool.name);
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
  return selected;
}

export function selectWorkflowCatalog(
  authorized: readonly CoderTool[], options: WorkflowCatalogOptions,
): { tools: CoderTool[]; protectedNames: ReadonlySet<string> } {
  const byName = new Map(authorized.map(tool => [tool.name, tool]));
  const selected = selectRequired(authorized, byName, options, true);
  const protectedNames = new Set(selected.keys());
  if (options.hardLimit !== undefined && selected.size > options.hardLimit) {
    throw new Error(`Tool projection cannot fit required capabilities: ${selected.size} required, verified provider limit ${options.hardLimit}. Adjust the model or required tool configuration.`);
  }
  // Optional groups are budgeted against the workflow alone (what would be
  // selected without contextual floors); the total ceiling still binds.
  const budgetTools = options.budgetSurface ?? authorized;
  const budgetByName = options.budgetSurface ? new Map(budgetTools.map(tool => [tool.name, tool])) : byName;
  const budgetSelected = options.budgetSurface ? selectRequired(budgetTools, budgetByName, options, true) : selected;
  const base = selectRequired(budgetTools, budgetByName, options, false);
  const maxTotal = options.maxTotal ?? Infinity;
  for (const group of OPTIONAL_GROUPS) {
    const present = group.filter(name => budgetByName.has(name));
    const baseAdditions = present.filter(name => !base.has(name)).length;
    const additions = present.filter(name => !budgetSelected.has(name)).length;
    if (base.size + baseAdditions > options.cap || budgetSelected.size + additions > maxTotal) continue;
    for (const name of present) {
      base.set(name, budgetByName.get(name)!);
      budgetSelected.set(name, budgetByName.get(name)!);
      const tool = byName.get(name);
      if (tool) selected.set(name, tool);
    }
  }
  // Deliberately do not fill spare slots with arbitrary registry/plugin tools.
  return { tools: [...selected.values()], protectedNames };
}

/**
 * The surface to budget optional groups on, with catalog stand-ins (child
 * chats): the authorized tools without the ones the stand-ins replace, plus
 * the stand-ins this session's disabled lists keep. The caller applies the
 * read-only authority to the result, as to `authorized`.
 */
export function catalogBudgetSurface(authorized: readonly CoderTool[],
  standIns: { tools: readonly CoderTool[]; replacing: ReadonlySet<string> }, disabled: (name: string) => boolean): CoderTool[] {
  const byName = new Map(authorized.filter(tool => !standIns.replacing.has(tool.name)).map(tool => [tool.name, tool]));
  for (const tool of standIns.tools) if (!byName.has(tool.name) && !disabled(tool.name)) byName.set(tool.name, tool);
  return [...byName.values()];
}
