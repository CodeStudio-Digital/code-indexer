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
// 2026-07-02.5 bump — Codex-parity Onda 1: new static `# Permissions & sandbox`
// block (concrete writable root + tool-approval mode) and `# Project
// instructions (AGENTS.md)` block (hierarchical AGENTS.md, finally read back).
// Both above the dynamic boundary → static prefix changed → invalidate stale
// fingerprints.
// 2026-07-11.1 bump — capability-aligned prompt composition, truthful local
// shell boundary, single-load App Studio specialist prompts, static extension
// insertion before the cache boundary, and Company tool metadata hardening.
// Static prefix + tool behavior changed → invalidate stale fingerprints.
// 2026-07-12.1 bump — progressive App Studio reads and Markdown-first native
// tool results with a hidden structured channel. Specialist prompt behavior and
// the tool surface changed → invalidate stale fingerprints.
// 2026-07-14.1 bump — request-scoped App Studio workflow reads. Tool-result
// continuations no longer restart coordination, and the workflow snapshot opts
// into an active unchanged-result loop break.
// 2026-07-16.1 bump — prompt-driven subagent research depth, completion
// criteria, and soft synthesis checkpoints. Static prefix changed so cached
// runs cannot retain the previous unbounded-research framing.
// 2026-07-24.1 bump — goal state is optional telemetry; completion evidence
// and independent review are advisory instead of execution gates.
// 2026-08-02.1 bump — restore public progress commentary around substantial
// tool work and distinguish it from reasoning summaries and the final answer.
// Configuration investigations must prove consumers/overrides before concluding.
// Session Meta removed from the tool catalog and prompt.
// 2026-11-11.2 bump — "# Tool contract" deduplicated against "# Tool
// discovery" and the tool contracts; batching and exit-code rules condensed.
// 2026-11-19.1 bump — scope Git checks to the request and reuse fresh results.
// 2026-11-19.2 bump — reopen approval for revisions to an approved plan.
// 2026-11-19.3 — align mode transitions, discovery, roles and review contracts.
// 2026-11-19.4 bump — the dynamic "# Tool visibility" block (a duplicate of
// "# Tool discovery") was removed with the non-stable catalog projection.
export const SYSTEM_PROMPT_VERSION = '20261119.4';
