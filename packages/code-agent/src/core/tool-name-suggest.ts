/**
 * Closest-match suggestion for unknown tool names.
 *
 * Models occasionally invent or shorten a tool name — telemetry caught
 * `grep_code` for the real `mcp__grep_code`. A bare "Unknown tool: X" gives
 * the model nothing to recover with; a deterministic "did you mean" pointer
 * turns the failure into a one-turn fix.
 *
 * Matching tiers, in order:
 *   1. case-insensitive exact;
 *   2. namespace-blind match — compare the last `__`-segment of both names,
 *      covering `grep_code` ↔ `mcp__grep_code` ↔ `mcp__<server>__grep_code`
 *      and `ext_<plugin>__` tools in either direction;
 *   3. banded Levenshtein (≤2 for names under 10 chars, ≤3 otherwise).
 *
 * Ties resolve to the lexicographically smallest candidate so the output is
 * deterministic (markers/refusals must stay prefix-cache stable).
 */

/**
 * Retired tool names and what replaces each. A call to one of these fails
 * with the instruction below; it is never silently rerouted, because the
 * replacement takes different arguments. Consulted only when the name is not
 * registered (top-level dispatch, code_exec's `tools.<name>` and bare globals).
 */
const AGENT_RUN_API_RETIRED = 'The agent-run API was removed together with the MCP server; there is no replacement tool.';

export const RETIRED_TOOL_REPLACEMENTS: Readonly<Record<string, string>> = {
  multi_edit: 'Use edit_file with `edits: [{ old_string, new_string, replace_all? }]` — all edits to one file apply atomically.',
  create_file: 'Use write_file — it creates a new file, and refuses to replace an existing one this session has not read.',
  todo_write: 'Use task_list with `items` (the full checklist).',
  update_todo: 'Use task_list with `updates` ({ id, status }) to flip checklist items.',
  submit_tasks: "Use task_list with `items` and gate:'approve' (Plan mode only).",
  poll_session: 'Use write_stdin with the session_id and empty (or omitted) `chars` — an empty write is the poll.',
  expand_toolset: 'Use find_tools to discover a tool and its schema; call hidden non-interactive tools inside code_exec. The visible catalog never changes mid-run.',
  capability_catalog: 'Use find_tools for tools; for skills use get_skills_list and get_skill_content.',
  // Application/CLI actions; the index tools the agent registers leave them out.
  mcp__index_project: 'Indexing is an application/CLI action, not an agent tool: the application maintains the project index. Check its coverage with mcp__get_project_overview; files missing from the index can still be read directly.',
  mcp__export_docs: 'Documentation export is an application/CLI action, not an agent tool. For a structural summary use mcp__get_project_overview and mcp__get_repo_map.',
  // The code index's MCP resources were retired together with the MCP bridge.
  mcp_list_resources: 'The code index no longer publishes MCP resources. For the project overview and repo map use mcp__get_project_overview and mcp__get_repo_map.',
  mcp_read_resource: 'The code index no longer publishes MCP resources. For the project overview and repo map use mcp__get_project_overview and mcp__get_repo_map.',
  // Agent-run reads, answered by the application's agent-run API.
  mcp__list_agents: AGENT_RUN_API_RETIRED,
  mcp__list_agent_runs: AGENT_RUN_API_RETIRED,
  mcp__get_agent_run: AGENT_RUN_API_RETIRED,
  mcp__get_agent_result: AGENT_RUN_API_RETIRED,
};

/**
 * The per-project form `mcp__<slug>__<tool>` of the retired index tools: a
 * Company master and a global session's secondary projects only have that
 * form. The slug may contain `_`.
 */
const PREFIXED_RETIRED_INDEX_TOOL =
  /^mcp__(.+)__(index_project|export_docs|list_agents|list_agent_runs|get_agent_run|get_agent_result)$/;

/** The error text for a retired tool name, or null when the name was never retired. */
export function retiredToolInstruction(name: string): string | null {
  const replacement = Object.hasOwn(RETIRED_TOOL_REPLACEMENTS, name) ? RETIRED_TOOL_REPLACEMENTS[name] : undefined;
  if (replacement) return `${name} was retired. ${replacement}`;
  const prefixed = PREFIXED_RETIRED_INDEX_TOOL.exec(name);
  if (!prefixed) return null;
  // Point at the same project's tools, which carry the same prefix.
  const text = RETIRED_TOOL_REPLACEMENTS[`mcp__${prefixed[2]}`].split('mcp__').join(`mcp__${prefixed[1]}__`);
  return `${name} was retired. ${text}`;
}

/**
 * Primary-bridge MCP twins of native tools. The twin is registered only when
 * its native tool is unavailable (internal-mcp-exposure.ts); a habitual or
 * historical call to an unregistered twin names the native tool instead.
 */
export const NATIVE_TWIN_OF: Readonly<Record<string, string>> = {
  mcp__read_file: 'read_file',
  mcp__list_directory: 'list_directory',
  mcp__rag_search_docs: 'rag_search_docs',
  mcp__rag_read_doc: 'rag_read_doc',
  mcp__rag_doc_outline: 'rag_doc_outline',
};

const NATIVE_TWIN_USAGE: Readonly<Record<string, string>> = {
  read_file: ' (`path`; `start_line`/`end_line` or `symbol` for part of a file)',
  list_directory: ' (`path`)',
};

/**
 * What to tell the model about an unregistered name that has a known
 * replacement: a retired tool, or a primary twin whose native tool serves.
 * Never an alias — the call fails with this text.
 */
export function toolReplacement(
  name: string,
  /** Names a run replaced (the registry's own map, e.g. child chats), before the global table. */
  replacedInRun?: Readonly<Record<string, string>>,
): { code: 'RETIRED_TOOL' | 'USE_NATIVE_TOOL'; text: string } | null {
  if (replacedInRun && Object.hasOwn(replacedInRun, name)) {
    return { code: 'RETIRED_TOOL', text: `${name} was retired. ${replacedInRun[name]}` };
  }
  const retired = retiredToolInstruction(name);
  if (retired) return { code: 'RETIRED_TOOL', text: retired };
  const native = Object.hasOwn(NATIVE_TWIN_OF, name) ? NATIVE_TWIN_OF[name] : undefined;
  return native
    ? { code: 'USE_NATIVE_TOOL', text: `${name} is not available in this session. Use ${native}${NATIVE_TWIN_USAGE[native] ?? ''}.` }
    : null;
}

/** Every name `toolReplacement` answers for. */
export const REPLACED_TOOL_NAMES: readonly string[] = [
  ...Object.keys(RETIRED_TOOL_REPLACEMENTS),
  ...Object.keys(NATIVE_TWIN_OF),
];

/** Last `__`-separated segment, lowercased — the namespace-blind "bare" name. */
function bareName(name: string): string {
  const segments = name.toLowerCase().split('__');
  return segments[segments.length - 1] ?? name.toLowerCase();
}

/**
 * Levenshtein distance with a cutoff: returns `cutoff + 1` as soon as the
 * distance provably exceeds `cutoff` (cheap row-minimum early exit).
 */
function boundedLevenshtein(a: string, b: string, cutoff: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cutoff) return cutoff + 1;
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Best registered-tool suggestion for an unknown name, or null when nothing
 * is plausibly close. Pure and deterministic over its inputs.
 */
export function suggestToolName(unknown: string, known: ReadonlyArray<string>): string | null {
  if (!unknown || known.length === 0) return null;
  const sorted = [...known].sort();
  const lower = unknown.toLowerCase();

  for (const k of sorted) {
    if (k.toLowerCase() === lower) return k;
  }

  const bare = bareName(unknown);
  for (const k of sorted) {
    if (bareName(k) === bare) return k;
  }

  const cutoff = unknown.length < 10 ? 2 : 3;
  let best: string | null = null;
  let bestDist = cutoff + 1;
  for (const k of sorted) {
    const d = boundedLevenshtein(lower, k.toLowerCase(), cutoff);
    if (d < bestDist) {
      bestDist = d;
      best = k; // sorted iteration → first hit at a distance is the lexicographic smallest
    }
  }
  return bestDist <= cutoff ? best : null;
}
