/**
 * Tool survival priority — which tools live when a model's catalog cap
 * (`getModelMaxTools`) is smaller than the tier-filtered tool list.
 *
 * Before this module the cap trimmed the ALPHABETICAL tail of the
 * non-essential bucket: `write_file` died while colder tools survived
 * purely by name. Weak models (GLM flash class, cap 32) need the opposite:
 * keep the hot working core + the discovery tools, drop the long tail.
 *
 * Selection here is utility-ordered; PRESENTATION stays alphabetical (the
 * caller re-sorts the survivor union), so prompt-cache byte-stability is
 * preserved: same inputs → same survivors → same serialized order.
 *
 * Pin interplay (P3): a pinned tool is protected by the caller (joins the
 * never-trim bucket). At cap, pinning therefore SWAPS the lowest-priority
 * survivor out — deterministic, one prefix-cache miss, then stable.
 */
import { CORE_TIER_NAMES, type ToolTier } from '@mcp/code-agent/tools/tiers.js';

/**
 * Tools that must NEVER be trimmed by the model cap. The discovery core
 * (find_tools/expand_toolset/code_exec), the minimal read pair, the
 * interaction/lifecycle tools a session cannot function without, and
 * `update_goal` (a bootstrap session with an in-progress goal and no
 * update_goal is deadlocked — see tiers.ts goal-tools note).
 *
 * `task_list` is the ONE always-on task/checklist tool (the todos+tasks
 * merge — see BOOTSTRAP_TOOLS in tiers.ts). The pre-merge solo aliases
 * `submit_tasks`/`todo_write` are now navigate-tier back-compat shims, so
 * they are NOT floored here: a direct caller is covered by pinning, and the
 * merge means the live task tool the cap must keep is `task_list`. The
 * subordinate `*_to_master` variants below are distinct live tools and stay.
 *
 * Company orchestration essentials are protected separately via
 * `isEssentialCompanyTool` (company-essentials.ts) — this set is the
 * session-class-agnostic floor.
 */
export const NEVER_TRIM: ReadonlySet<string> = new Set([
  'find_tools',
  'expand_toolset',
  'code_exec',
  'read_file',
  'glob',
  'ask_user',
  'ask_master',
  'task_complete',
  'submit_plan',
  'task_list',
  'submit_plan_to_master',
  'submit_tasks_to_master',
  'update_goal',
]);

/**
 * Hot-tool ranking, hottest first. Seeded from the 12k-turn audit evidence
 * encoded in tiers.ts (code_exec is the #1 tool at 16.7% of all calls; the
 * Phase B demotions mark the cold tail). Tools not listed rank after every
 * listed one, alphabetical tiebreak — determinism is the contract here, the
 * exact ordering of the tail is not.
 */
const HOT_RANK: readonly string[] = [
  'code_exec',
  'read_file',
  'mcp__search',
  'mcp__grep_code',
  'mcp__read_file',
  'edit_file',
  'write_file',
  'run_command',
  'mcp__get_file_skeleton',
  'list_directory',
  'mcp__list_directory',
  'glob',
  'git_status',
  'git_diff',
  'multi_edit',
  'create_file',
  'get_diagnostics',
  'mcp__get_project_pulse',
  'todo_write',
  'lsp_diagnostics',
  'git_log',
  'mcp__find_references',
  'web_search',
  'web_fetch',
  'mcp__get_symbol_body',
  'mcp__prepare_edit',
  'exec_command',
  'write_stdin',
  'list_sessions',
  'mcp__save_memory',
  'manage_path',
  'rag_search_docs',
  'rag_read_doc',
  'spawn_agent',
  'invoke_skill',
  'get_tool_output',
];

const HOT_INDEX: ReadonlyMap<string, number> = new Map(HOT_RANK.map((n, i) => [n, i]));

/**
 * Survival group — higher survives longer. Drop order (first to go → last):
 * custom/external MCP tier → preview → admin → master (non-essential) →
 * navigate-cold → bootstrap-cold → navigate-hot → bootstrap-hot.
 * "Hot" = membership in HOT_RANK. Company/builder tools resolve to
 * 'bootstrap' in getToolTier, so they compete in the bootstrap groups.
 */
function survivalGroup(tier: ToolTier, hot: boolean): number {
  if (!CORE_TIER_NAMES.has(tier)) return 0;
  switch (tier) {
    case 'preview':
      return 1;
    case 'admin':
      return 2;
    case 'master':
      return 3;
    case 'navigate':
      return hot ? 6 : 4;
    case 'bootstrap':
      return hot ? 7 : 5;
    default:
      return 0;
  }
}

/** Compare two tool names by keep-priority (best-kept first). Deterministic. */
export function compareByKeepPriority(
  a: string,
  b: string,
  tierOf: (name: string) => ToolTier,
): number {
  const ha = HOT_INDEX.get(a);
  const hb = HOT_INDEX.get(b);
  const ga = survivalGroup(tierOf(a), ha !== undefined);
  const gb = survivalGroup(tierOf(b), hb !== undefined);
  if (ga !== gb) return gb - ga;
  const ra = ha ?? Number.MAX_SAFE_INTEGER;
  const rb = hb ?? Number.MAX_SAFE_INTEGER;
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

/**
 * Pick the `cap` highest-priority tools out of `tools`. Pure + deterministic:
 * same input set (any order) → same kept set. Returned `kept` is in priority
 * order — callers re-sort alphabetically for presentation; `dropped` names
 * are for the once-per-trim log.
 */
export function selectUnderCap<T extends { name: string }>(
  tools: readonly T[],
  cap: number,
  tierOf: (name: string) => ToolTier,
): { kept: T[]; dropped: string[] } {
  const room = Math.max(0, cap);
  if (tools.length <= room) return { kept: [...tools], dropped: [] };
  const ranked = [...tools].sort((a, b) => compareByKeepPriority(a.name, b.name, tierOf));
  return {
    kept: ranked.slice(0, room),
    dropped: ranked.slice(room).map((t) => t.name),
  };
}
