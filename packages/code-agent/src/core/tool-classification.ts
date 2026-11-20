import type {
  CoderTool,
  ToolExecutionClass,
  ToolRepeatPolicy,
  ToolRiskLevel,
} from '@mcp/code-agent/core/tool.js';
/**
 * Built-in classification for native tools whose definitions don't yet
 * carry explicit metadata. Lets us light up policy resolution everywhere
 * before every tool file has been annotated. As tools are migrated to
 * declare their own metadata, entries here can be removed — the resolver
 * picks the explicit field over this map.
 */
export const BUILTIN_CLASSIFICATION: Record<
  string,
  Pick<CoderTool, 'mutates' | 'parallelSafe' | 'riskLevel' | 'scopeAware' | 'interactive' | 'repeatPolicy' | 'executionClass'>
> = {
  // ─── Filesystem reads ─────────────────────────────────────────
  read_file:        { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  list_directory:   { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  glob:             { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  get_diagnostics:  { mutates: true, parallelSafe: false, riskLevel: 'execute', repeatPolicy: 'volatile' },
  get_tool_output:  { mutates: false, parallelSafe: true,  riskLevel: 'read' },

  // ─── Filesystem writes (path-scoped) ──────────────────────────
  write_file:       { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  edit_file:        { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  manage_path:      { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },
  apply_patch:      { mutates: true, parallelSafe: false, riskLevel: 'write', scopeAware: true },

  // ─── Shell ────────────────────────────────────────────────────
  // `mutates: false` here is deliberate: shell tools SELF-GATE inside
  // their handler (see `tools/shell.ts` `isReadOnlyCommand` allowlist
  // for plan mode). If we marked them as mutating at the policy level
  // we'd double-block — even read-only commands like `ls` and `git
  // status` would refuse during plan mode, which is the opposite of
  // what the agent needs to explore the workspace before submitting a
  // plan. `parallelSafe: false` because shell side effects make
  // parallel dispatch unsafe regardless of how the gate resolves.
  run_command:      { mutates: false, parallelSafe: false, riskLevel: 'execute', repeatPolicy: 'volatile', executionClass: 'execute' },
  code_exec:        { mutates: false, parallelSafe: true,  riskLevel: 'read',    repeatPolicy: 'volatile', executionClass: 'execute' },

  // ─── Git ──────────────────────────────────────────────────────
  git_status:       { mutates: false, parallelSafe: true,  riskLevel: 'read', repeatPolicy: 'volatile' },
  git_diff:         { mutates: false, parallelSafe: true,  riskLevel: 'read', repeatPolicy: 'volatile' },
  git_log:          { mutates: false, parallelSafe: true,  riskLevel: 'read', repeatPolicy: 'volatile' },
  git_add:          { mutates: true,  parallelSafe: false, riskLevel: 'admin' },
  git_commit:       { mutates: true,  parallelSafe: false, riskLevel: 'admin' },
  git_branch:       { mutates: true,  parallelSafe: false, riskLevel: 'admin' },

  // ─── Web / external IO (read-only) ────────────────────────────
  web_fetch:        { mutates: false, parallelSafe: true,  riskLevel: 'read', repeatPolicy: 'volatile' },
  web_search:       { mutates: false, parallelSafe: true,  riskLevel: 'read', repeatPolicy: 'volatile' },

  // ─── LSP (read) ───────────────────────────────────────────────
  lsp_definition:   { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  lsp_references:   { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  lsp_hover:        { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  lsp_diagnostics:  { mutates: false, parallelSafe: true,  riskLevel: 'read', repeatPolicy: 'volatile' },

  // ─── Worktree (admin) ─────────────────────────────────────────
  enter_worktree:   { mutates: true, parallelSafe: false, riskLevel: 'admin' },
  exit_worktree:    { mutates: true, parallelSafe: false, riskLevel: 'admin' },

  // ─── Skills ───────────────────────────────────────────────────
  invoke_skill:     { mutates: false, parallelSafe: false, riskLevel: 'read' },

  // ─── Interactive (pause for human) ────────────────────────────
  ask_user:         { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  decision_gate:    { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_plan:      { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  // task_list: interactive because gate:'approve' pauses for approval (must opt
  // out of the NORMAL tool timeout). gate:'track' returns immediately, for which
  // the interactive flag is a harmless no-op.
  task_list:        { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_spec:      { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  list_tasks:        { mutates: false, parallelSafe: true,  riskLevel: 'read' },
  cancel_tasks:      { mutates: false, parallelSafe: false, riskLevel: 'read' },
  delete_tasks:      { mutates: false, parallelSafe: false, riskLevel: 'read' },
  archive_task_list: { mutates: false, parallelSafe: false, riskLevel: 'read' },
  // Frente D — `execute_task` (singular) removed; only `execute_tasks`
  // (plural) and `task_complete` (inline-scope closer) remain.
  task_complete:    { mutates: false, parallelSafe: false, riskLevel: 'read' },
  update_task:      { mutates: false, parallelSafe: false, riskLevel: 'read' },

  // ─── Subordinate company variants (master-directed) ───────────
  ask_master:               { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_plan_to_master:    { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  submit_tasks_to_master:   { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  // send_to_master / send_to_agent block on `inboxWait` (own 20-min deadline)
  // when wait=true — same "block for a reply" nature as ask_master, so they
  // must opt OUT of the runner's 5-min NORMAL timeout. With wait=false they
  // return immediately, so the Infinity timeout is a harmless no-op.
  send_to_master:           { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
  send_to_agent:            { mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true },
};


/**
 * Resolved metadata after applying the precedence chain:
 *   1. explicit field on the tool definition;
 *   2. `BUILTIN_CLASSIFICATION` lookup by tool name;
 *   3. conservative fallback by source.
 *
 * Always returns a fully populated record so callers don't need to
 * second-guess defaults.
 */
export interface ResolvedToolMetadata {
  mutates: boolean;
  parallelSafe: boolean;
  riskLevel: ToolRiskLevel;
  requiresSandbox: boolean;
  scopeAware: boolean;
  interactive: boolean;
  repeatPolicy: ToolRepeatPolicy;
  executionClass: ToolExecutionClass;
}


export function resolveToolMetadata(tool: CoderTool): ResolvedToolMetadata {
  const builtin = BUILTIN_CLASSIFICATION[tool.name];

  // Native/internal tools retain the legacy read default. External MCP tools
  // without an explicit contract are conservative: their remote side effects
  // are unknowable, so they default to write/non-parallel. This matches the
  // CoderTool contract and prevents an unannotated mutation from bypassing
  // lifecycle, permission and ledger gates.
  const unclassifiedExternal =
    tool.source === 'mcp_external'
    && !builtin
    && tool.mutates === undefined
    && tool.riskLevel === undefined;
  const sourceDefault = {
    mutates: unclassifiedExternal,
    parallelSafe: !unclassifiedExternal,
    riskLevel: (unclassifiedExternal ? 'write' : 'read') as ToolRiskLevel,
  };

  const mutates = tool.mutates ?? builtin?.mutates ?? sourceDefault.mutates;
  const parallelSafe =
    tool.parallelSafe
    ?? builtin?.parallelSafe
    ?? (mutates ? false : sourceDefault.parallelSafe);
  const riskLevel = tool.riskLevel ?? builtin?.riskLevel ?? sourceDefault.riskLevel;
  const requiresSandbox = tool.requiresSandbox ?? false;
  const scopeAware = tool.scopeAware ?? builtin?.scopeAware ?? false;
  const interactive = tool.interactive ?? builtin?.interactive ?? false;
  const repeatPolicy: ToolRepeatPolicy = tool.repeatPolicy
    ?? builtin?.repeatPolicy
    ?? (tool.repeatable ? 'pollable' : mutates ? 'mutating' : 'stable');
  const executionClass: ToolExecutionClass = tool.executionClass
    ?? builtin?.executionClass
    ?? (interactive || riskLevel === 'admin' ? 'control'
      : riskLevel === 'execute' ? 'execute'
        : mutates ? 'write' : 'read');

  return {
    mutates,
    parallelSafe,
    riskLevel,
    requiresSandbox,
    scopeAware,
    interactive,
    repeatPolicy,
    executionClass,
  };
}


/** Scheduling requires an affirmative declaration. Legacy metadata defaults
 * retain their policy compatibility but cannot authorize concurrent dispatch. */
export function isExplicitlyParallelSafeRead(tool: CoderTool): boolean {
  const declared = tool.parallelSafe ?? BUILTIN_CLASSIFICATION[tool.name]?.parallelSafe;
  const metadata = resolveToolMetadata(tool);
  return declared === true && metadata.parallelSafe && !metadata.mutates
    && metadata.executionClass === 'read' && metadata.riskLevel === 'read'
    && !metadata.interactive && tool.effectBoundary === undefined && tool.riskOf === undefined;
}


/**
 * Resolve metadata for one concrete invocation. `riskOf` is authoritative for
 * input-sensitive tools (for example db_query SELECT vs INSERT) and fails
 * closed as a write when it throws or returns an invalid value; `repeatPolicyOf`
 * does the same for repetition and keeps the derived policy on a bad answer.
 */
export function resolveToolInvocationMetadata(
  tool: CoderTool,
  input: unknown,
): ResolvedToolMetadata {
  const resolved = resolveInvocationRisk(tool, input);
  const repeatPolicy = invocationRepeatPolicy(tool, input);
  return repeatPolicy ? { ...resolved, repeatPolicy } : resolved;
}

const REPEAT_POLICIES: ReadonlySet<string> = new Set(['stable', 'volatile', 'pollable', 'mutating']);

function invocationRepeatPolicy(tool: CoderTool, input: unknown): ToolRepeatPolicy | null {
  if (typeof tool.repeatPolicyOf !== 'function') return null;
  try {
    const policy = tool.repeatPolicyOf(input);
    return REPEAT_POLICIES.has(policy) ? policy : null;
  } catch {
    return null;
  }
}

/**
 * The tool itself declares a polling primitive (static `repeatPolicy`
 * pollable). Failures of such tools are exempt from the failure-streak guard;
 * an input-derived pollable call (an empty write_stdin) is not.
 */
export function declaresPolling(tool: CoderTool): boolean {
  return resolveToolMetadata(tool).repeatPolicy === 'pollable';
}

function resolveInvocationRisk(tool: CoderTool, input: unknown): ResolvedToolMetadata {
  const metadata = resolveToolMetadata(tool);
  if (typeof tool.riskOf !== 'function') return metadata;

  let riskLevel: ToolRiskLevel;
  try {
    const classified = tool.riskOf(input);
    riskLevel = classified === 'read'
      || classified === 'write'
      || classified === 'execute'
      || classified === 'admin'
      ? classified
      : 'write';
  } catch {
    riskLevel = 'write';
  }

  const mutates = riskLevel === 'write'
    ? true
    : riskLevel === 'read'
      ? false
      : metadata.mutates;
  const executionClass: ToolExecutionClass = metadata.interactive || riskLevel === 'admin'
    ? 'control'
    : riskLevel === 'execute'
      ? 'execute'
      : riskLevel === 'write'
        ? 'write'
        : 'read';
  return {
    ...metadata,
    riskLevel,
    mutates,
    parallelSafe: riskLevel === 'read' ? metadata.parallelSafe : false,
    executionClass,
    repeatPolicy:
      riskLevel === 'write' && metadata.repeatPolicy === 'stable'
        ? 'mutating'
        : metadata.repeatPolicy,
  };
}
