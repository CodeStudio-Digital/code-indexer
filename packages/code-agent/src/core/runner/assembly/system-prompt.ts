/**
 * System prompt assembly — placeholder for Commit 2.
 *
 * Today the runner concatenates `this.opts.systemPrompt` with the quality
 * feedback suffix produced by `buildQualityFeedbackSuffix`. That helper
 * has side-effects (writes to QualityInterventionStore) and depends on
 * mutable runner state — refactoring it into a pure function requires
 * threading the intervention-store callbacks through args, which is
 * properly the work of Commit 4/5.
 *
 * For now this file only exposes the trivial concatenation helper so the
 * BT's `Executing` node can use a single import point once the quality
 * feedback path is migrated.
 */

/**
 * Version stamp embedded in every `coder_task_run_items.inputs_fingerprint`
 * (PR-D). Bump manually whenever the master/subagent system prompts change
 * in a way that should invalidate the skip-stale cache — adding a new
 * tool to the bootstrap list, changing the implement subagent's framing,
 * tightening sandboxing rules, etc.
 *
 * Format: YYYYMMDD.NN (NN counts changes inside the same day, starting 1).
 */
// Frente D bump — `execute_task` (singular) removed from the registry,
// `update_task` promoted to BOOTSTRAP_TOOLS. Old fingerprints must
// invalidate so PR-D's skip-stale gate re-runs anything that depended
// on the old tool surface.
// P1 bump — goal tools (create_goal/get_goal/update_goal) + update_todo
// promoted from silent bootstrap fallback to explicit BOOTSTRAP_TOOLS.
// 2026-06-05.2 bump — prompt accuracy/consistency pass: product name (MCP IDE),
// memory via save_memory (navigate), execute_tasks flow, current kanban tool
// names, master-vs-subordinate builder scoping, refreshed bootstrap tier-hint
// list. Static prefix changed → invalidate stale fingerprints.
// 2026-06-05.3 bump — added the gated "Session working memory" section
// (save_note/list_notes/read_plan/recall_investigations) for non-company sessions.
// 2026-06-12.1 bump — Fase 1 da redução do prompt: re-read/preambles enxutos
// (runner já enforça dedup), plan.txt sem allowlist enumerada e sem duplicar
// o lifecycle de tasks, subagents/overlay/tierHint/not-indexed comprimidos,
// memória unificada ({{memorySection}}), "Images & vision" condicional a
// modelCanSeeImages. Static prefix mudou → invalida fingerprints stale.
// 2026-06-16.1 bump — agente de planejamento especialista: plan.txt reescrito
// (protocolo de investigação + formato de documento de plano + right-sizing)
// e novo bloco de calibração por profundidade (## Plan depth, simple/normal/
// complex) injetado na seção de plan mode. Static prefix mudou → invalida
// fingerprints stale.
// 2026-06-22.1 bump — decision gate: plan.txt step 5 now runs a `decision_gate`
// questionnaire over genuine forks before the plan, the depth block gates it
// per simple/normal/complex, and the plan document gains a **Decisions**
// section. Static prefix mudou → invalida fingerprints stale.
// 2026-06-24.1 bump — todos/tasks merge: ONE `task_list` tool (gate track|approve)
// replaces the todo_write+submit_tasks selection fork; Interactive-tools section
// and plan.txt rewritten around the gate. Static prefix mudou → invalida stale.
// 2026-06-24.2 bump — Track G prompt-hygiene (vs Claude Code audit): balanced
// anti-stop + plan/spec gate override in buildAgentLoopBlock; subagent framing
// gains task-restatement + no-sub-fork + analysis-vs-change carve-out;
// destructive-action evidence directive in build.txt/admin.txt/IMPLEMENT &
// EXPLORE/REVIEW no-fork lines; explore.txt unindexed fallback pointer. Static
// prefix mudou → invalida fingerprints stale.
// 2026-06-27.1 bump — docs_claude audit adoption: skill BLOCKING/anti-invent
// wording (prompt-injector); memory-staleness caveat in memorySection; new
// session-fixed directives (G1 # Language / G8 output style / G3 # Operating
// autonomously) above the boundary; ask_user recommended-first + write-tool
// docs/emoji guardrails. Static prefix mudou → invalida fingerprints stale.
// 2026-06-28.1 bump — Agent Memory overhaul (migration 181): memorySection
// rewritten into three behaviour-triggering layers (recall-first / save-as-you-
// learn / ignore-memory), recall_memory promoted to the bootstrap tier. Static
// prefix changed → invalidates stale fingerprints.
// 2026-06-28.2 bump — prompt/tier alignment: mcpSection no longer advertises the
// navigate-tier mcp__query_snapshots / mcp__get_context_for as "always visible"
// (they were demoted from bootstrap in Phase B); explore.txt + base.txt reworded
// to match the real turn-1 surface. Static prefix changed → invalidates stale
// fingerprints.
// 2026-07-02.1 bump — prompt-audit batch: base.txt Style gains parallel-batching
// + result-honesty bullets and Native tools gains the no-invented-tool-names
// rule; build.txt verify bullet teaches command DISCOVERY (package.json /
// Makefile / "Known verify commands" dynamic block); plan.txt right-size gains
// the null-plan case; agent-loop + subagent framing differentiate broken-tool
// retry vs Unknown-tool → find_tools; mcpSection drops the mcp__search_memory
// paragraph on sessionDrive sessions (recall_memory covers the same store);
// EXPLORE subagent gains the memory-staleness caveat, IMPLEMENT gains the
// files-scope rule. Static prefix changed → invalidates stale fingerprints.
// 2026-07-02.2 bump — tool description audit (docs/audit/TOOL_AUDIT.md):
// terseDescription() aligned to the bridge's [.\n] sentence cut (the '. '
// matcher hard-cut every '.\n'-styled description mid-word); 16 weak MCP-server
// descriptions rewritten to the house style; 11 terse-unsafe first sentences
// fixed across code-agent/company. Tool array bytes changed → invalidates
// stale fingerprints.
// 2026-07-02.3 bump — audit follow-ups: six 0-call MCP tools retired
// (get_file_structure, search_concepts, search_by_kind, get_class_members,
// get_symbol_details, get_architecture — see tier-contract retired list);
// prepare_edit adoption fix (description + build.txt/builder.txt route edits
// through it before get_symbol_body); base.txt overlay line and master
// company prompt drop retired tool names. Tool surface + static prefix
// changed → invalidates stale fingerprints.
// 2026-07-02.4 bump — memory incentives: concrete save examples in
// memorySection, recall step 0 in plan.txt, recall-first reword in
// explore.txt + spec.txt, toolCap memory line, remember/recall description
// tweaks. Static prefix changed → invalidates stale fingerprints.
export const SYSTEM_PROMPT_VERSION = '20260702.4';

export interface AssembleSystemPromptArgs {
  basePrompt: string;
  qualitySuffix: string;
}

export function assembleSystemPrompt(args: AssembleSystemPromptArgs): string {
  if (!args.qualitySuffix) return args.basePrompt;
  return `${args.basePrompt}${args.qualitySuffix}`;
}
