# COMPARISON: Codex / kimi-cli / claude-code vs MCP

Synthesis of three coding-agent reference implementations against `D:\MCP`.
Focus: loop control, compaction, cache, multi-agent, error recovery, editing,
plans, hooks. v2 work already shipped (active-context injection, stop-guard,
result-content dedup, task_id "did you mean", todo description rewrite,
overlayLiveState, auto-continue recap) is treated as the BASELINE — none of
the recommendations below duplicate it.

## Section 1 — Comparative Matrix

Legend: ✅ present and strong · ⚠️ partial / weaker · ❌ absent

| # | Capability | codex | kimi-cli | claude-code | **MCP** |
|---|---|---|---|---|---|
| **Loop & stop** | | | | | |
| 1 | Explicit `end_turn`/no-tool-calls stop | ✅ end_turn flag | ✅ no_tool_calls | ✅ enumerated reasons | ✅ emit('done','completed') |
| 2 | Enumerated stop reasons (>5) | ❌ binary | ❌ binary | ✅ 12+ reasons | ⚠️ 'completed' + ad-hoc |
| 3 | `state.transition` watermark (circuit-breaker) | ❌ | ❌ | ✅ `transition.reason` | ❌ |
| 4 | Per-recovery-path attempt cap | ⚠️ stream_max_retries | ⚠️ tenacity max=5 | ✅ `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3`, `hasAttemptedReactiveCompact` | ⚠️ doom-loop only |
| 5 | Strict doom-loop guard | ❌ | ❌ | ❌ | ✅ DOOM_LOOP_THRESHOLD=3 |
| 6 | Result-content hash dedup | ❌ | ❌ | ❌ | ✅ v2 RESULT_DUP_THRESHOLD=1 |
| 7 | Stop-guard nudge before final | ❌ | ❌ | ❌ | ✅ v2 (1 nudge) |
| 8 | Auto-continue with isMeta=true marker | ❌ | ❌ | ✅ `task_budget` nudge `{ isMeta:true, transition:'token_budget_continuation' }` | ⚠️ recap text only |
| **Compaction** | | | | | |
| 9 | Reactive compaction on `prompt_too_long` | ⚠️ pre-sample threshold | ⚠️ ratio only | ✅ explicit catch | ⚠️ size-based |
| 10 | Tagged-section summary template | ❌ freeform | ✅ `<current_focus>` `<environment>` `<completed_tasks>` `<active_issues>` `<code_state>` `<important_context>` | ⚠️ subtype:'compact_boundary' | ✅ CompactionSummaryV2 (9 JSON fields) |
| 11 | Preserve last N user/assistant verbatim | ❌ | ✅ last 2 turns | ⚠️ partial | ⚠️ atomic pair only |
| 12 | Read-slice dedup retire | ❌ | ❌ | ❌ | ✅ buildReadDedupKey |
| 13 | Pre-compact context carryover for budget | ❌ | ❌ | ✅ `preCompactContext` final-tokens | ❌ |
| 14 | Live-state overlay post-summary | ❌ | ❌ | ❌ | ✅ overlayLiveState |
| 15 | Cross-session memory consolidation | ❌ | ❌ | ✅ autoDream → MEMORY.md | ❌ |
| **Cache** | | | | | |
| 16 | Static/dynamic prompt boundary marker | ❌ | ❌ | ✅ `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` | ⚠️ implicit by ordering |
| 17 | Prefix-stable system prompt | ⚠️ | ✅ finalized pre-turn | ✅ explicit | ✅ repo map LAST |
| 18 | Per-query closure for prompt fetch (leak guard) | ❌ | ❌ | ✅ `dumpPromptsFetch` | ❌ |
| 19 | Active-context as tail user-msg (cache-safe) | ❌ | ❌ | ❌ | ✅ v2 |
| **Multi-agent** | | | | | |
| 20 | Forked subagent inherits policy/sandbox | ✅ | ✅ `copy_for_subagent` | ✅ runForkedAgent | ✅ spawn_subagent |
| 21 | Coordinator + INTERNAL_WORKER tools | ❌ | ⚠️ via Agent tool | ✅ TEAM_CREATE/SEND_MESSAGE/SYNTHETIC_OUTPUT | ⚠️ spawn_agents only |
| 22 | User-gated `agentDefinitions.activeAgents` | ❌ | ❌ | ✅ | ❌ |
| 23 | Custom system prompt per subagent | ⚠️ | ✅ | ✅ | ⚠️ partial |
| 24 | Subagents skip post-sampling hooks | ❌ | ❌ | ✅ `!toolUseContext.agentId` | ❌ |
| **Error recovery** | | | | | |
| 25 | OAuth refresh on 401 | ❌ | ✅ `oauth.ensure_fresh(force=True)` | ⚠️ | ⚠️ retry-once |
| 26 | Tenacity exponential+jitter on 5xx/429 | ⚠️ stream only | ✅ max=5 jitter=0.5 | ⚠️ withRetry.ts (not loop-level) | ⚠️ retry-once |
| 27 | Transport fallback (WS→HTTPS) | ✅ | ❌ | ❌ | ❌ |
| 28 | Provider fallback chain | ❌ | ❌ | ❌ | ✅ |
| 29 | Image-size strip-retry | ❌ | ❌ | ✅ mediaRecoveryEnabled | ❌ |
| 30 | task_id "did you mean" Levenshtein | ❌ | ❌ | ❌ | ✅ v2 |
| **Editing** | | | | | |
| 31 | Single unified patch tool | ✅ apply_patch (Add/Delete/Update) | ❌ | ❌ | ❌ |
| 32 | Pre-read enforcement | ⚠️ "do not re-read after" | ⚠️ | ✅ enforced | ⚠️ |
| 33 | replace_all multi-instance flag | ❌ | ❌ | ✅ | ⚠️ via multi_edit |
| 34 | Plan-file edits auto-approved | ❌ | ✅ | ❌ | ❌ |
| **Plan & preamble** | | | | | |
| 35 | update_plan tool, single in_progress | ✅ "do not let plan go stale" | ⚠️ | ⚠️ | ✅ todo_write |
| 36 | Multi-option plan w/ user pick | ❌ | ✅ ExitPlanMode `options:list[PlanOption]` | ❌ | ❌ submit_plan single |
| 37 | Explicit preamble guidance (8–12 words) | ✅ in gpt_5_1 prompt | ❌ | ❌ | ❌ |
| 38 | Persistence framing in prompt | ✅ "persist until... only stop when sure" | ❌ | ⚠️ | ⚠️ partial |

---

## Section 2 — Gap Analysis

Only gaps present in ≥2 references AND absent/weaker in MCP.

### G1. Per-recovery-path circuit breaker
- **Refs**: claude-code `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3` + `hasAttemptedReactiveCompact`; codex `stream_max_retries`.
- **MCP symptom**: when same recovery path re-enters (compact-then-retry, fallback-then-retry), we only have doom-loop on tool-use signatures, not on recovery transitions. A failed compact retried 3× spends 3× the tokens.
- **Impact**: alto — retry storms inflate billing and reproduce the original failure indefinitely.
- **Effort**: S — 1 file (`runner.ts`), ~60 LOC. Add `recoveryAttempts: Map<string, number>` keyed by recovery kind.
- **Cache risk**: Não.
- **Telemetria**: dashboard (new counter `recovery_aborted_total`).

### G2. Tagged-section compaction template
- **Refs**: kimi-cli `compact.md` fixed sections; claude-code `compact_boundary` subtype.
- **MCP state**: We have `CompactionSummaryV2` with 9 fields (partially solved). Gap: the rendered summary is markdown headers, not human-tagged blocks; re-compaction LLM may not preserve structure as deterministically as `<current_focus>...</current_focus>`.
- **Impact**: médio — improves multi-compact stability over long sessions.
- **Effort**: S — `summarizer.ts` template render only, ~40 LOC.
- **Cache risk**: Sim, parcial — one-time invalidation as summary text shape changes; stable thereafter.
- **Telemetria**: nenhuma.

### G3. Preserve last N raw turns through compact
- **Refs**: kimi-cli "last 2 user/assistant verbatim"; claude-code partial via atomic pair.
- **MCP symptom**: After compaction, model loses fine-grained user-intent detail from immediately prior turns; observed in 609-style "what was I doing" regressions.
- **Impact**: médio.
- **Effort**: M — `compaction.ts` ~120 LOC. Must update tool_use/tool_result pairing to anchor preserved tail.
- **Cache risk**: Não (tail is past the boundary).
- **Telemetria**: nenhuma.

### G4. Static/dynamic prompt boundary marker
- **Refs**: claude-code `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (scope='global' pre, session post).
- **MCP state**: Order is implicit (repo map last). Active-context v2 is in user-message tail (cache-safe), but other dynamic bits (cwd, MCP names, tier hint) sit in system prompt mid-stream. Cache hit rate is sensitive to any mid-prompt churn.
- **Impact**: alto — direct billing impact via `cache_read_input_tokens`.
- **Effort**: M — `system-prompt.ts` reorder + add explicit marker; ~150 LOC plus snapshot tests.
- **Cache risk**: Sim, parcial — one-time prefix change, then sustained gain.
- **Telemetria**: billing (cache_read ratio).

### G5. Tenacity-style exp+jitter retry on 429/5xx/timeout
- **Refs**: kimi-cli tenacity (exp jitter, max=5, jitter=0.5) on 429/500/502/503/504/timeout/empty; codex transport fallback after exhaustion.
- **MCP state**: 401/400 retry-once + provider fallback chain. Single retry is brittle for transient 5xx; no jitter, so stampedes amplify.
- **Impact**: médio — observed multi-fail cascades on rate-limited providers.
- **Effort**: S — `runner.ts` + provider invocation, ~80 LOC.
- **Cache risk**: Não.
- **Telemetria**: dashboard (retry histogram).

### G6. Persistence + preamble framing in system prompt
- **Refs**: codex `gpt_5_1_prompt.md` "persist until task is fully handled… only stop when sure the problem is solved"; codex 8–12-word preamble guidance.
- **MCP state**: agent-loop-v2 block is good but lacks explicit persistence directive (close enough but not as direct), and has no preamble length/grouping guidance.
- **Impact**: médio — reduces premature stops and chatty between-tool narration.
- **Effort**: S — `system-prompt.ts` text only, ~30 LOC.
- **Cache risk**: Sim, parcial — one-time invalidation.
- **Telemetria**: nenhuma.

### G7. User-gated subagent definitions (demoted)
- **Refs**: claude-code `agentDefinitions: { activeAgents, allAgents }`; kimi-cli template-injected types.
- **Why demoted**: low impact and tool-list cache invalidation per-config makes ROI marginal until we have a UX to expose it.

---

## Section 3 — Top Recommendations (ranked by ROI)

### R1. Per-recovery-path circuit breaker — ROI 9.0
Add `recoveryAttempts: Map<string, number>` keyed by transition kind
(compact-retry, downshift, oauth-refresh, doom-loop-recovery). Cap each path
independently, abort with structured error.
- **Files MCP**: `src/core/coder/core/runner.ts`.
- **Reference pattern**: claude-code `query.ts` — *"if state.transition?.reason !== 'collapse_drain_retry'"* prevents re-attempting same recovery path.
- **Verification metric**: synthetic compact-retry storm aborts within 3 attempts; new `recovery_aborted_total` counter increments; existing doom-loop tests stay green.

### R2. Static/dynamic prompt boundary — ROI 9.0
Introduce explicit `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker. Move all
session-mutable text (cwd, MCP names, tier hint flag) below the marker.
Static tools/instructions/agent-loop block stay above. Goal: the prefix is
byte-identical across turns of a session and across sessions of a
project.
- **Files MCP**: `src/core/coder/core/system-prompt.ts`, callers in `src/core/coder/index.ts`.
- **Reference pattern**: claude-code `src/constants/prompts.ts` — *"SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker splits scope='global' from session-scoped"*.
- **Verification metric**: 10-turn synthetic session shows `cache_read_input_tokens` stable (<5% drop turn-over-turn) after turn 2. Snapshot test on `buildSystemPrompt` byte-stability under varying session inputs.

### R3. Tagged-section compaction template — ROI 7.8
Render summarizer output with stable `<current_focus>`, `<active_issues>`,
`<code_state>` tags so re-compaction LLM preserves structure
deterministically.
- **Files MCP**: `src/core/coder/core/summarizer.ts` (`renderSummaryV2`).
- **Reference pattern**: kimi-cli `prompts/compact.md` — fixed sections `<current_focus>` `<environment>` `<completed_tasks>` `<active_issues>` `<code_state>` `<important_context>`.
- **Verification metric**: after 3 sequential compactions in eval suite, `pending_tasks` round-trips with 0 hallucinated entries; `current_focus` text stays stable across passes.

### R4. Preserve last N raw turns through compact — ROI 7.0
Keep last 2 user+assistant turn pairs verbatim past the compaction
boundary; summarize only the prefix. Atomic tool_use/tool_result pairing
must be respected at the cut.
- **Files MCP**: `src/core/coder/core/compaction.ts`.
- **Reference pattern**: kimi-cli `compaction.py:170-189` — *"preserve the last N user/assistant turns (max_preserved_messages=2)"*.
- **Verification metric**: 609-style "what was I doing" reproducer passes; user-goal-fidelity eval (% turns where final goal text matches initial request) ≥95% post-compact.

### R5. Tenacity-style exp+jitter retry on 429/5xx/timeout — ROI 7.0
Replace retry-once with bounded exp backoff + jitter for retryable
transport errors before falling through to the provider chain.
- **Files MCP**: `src/core/coder/core/runner.ts` (provider invocation block lines ~1499–1620), `src/core/coder/core/fallback.ts`.
- **Reference pattern**: kimi-cli `kimisoul.py:997-1001` — *"tenacity.retry, wait_exponential_jitter(initial=0.3, max=5, jitter=0.5), stop_after_attempt(max_retries_per_step)"*.
- **Verification metric**: synthetic 429 storm completion rate rises from <40% (retry-once) to >90%; provider-chain promotions drop ≥50%.

### R6. Persistence + preamble framing in system prompt — ROI 7.0
Add codex-style "persist until task is fully handled end-to-end" directive
plus "1–2 sentence preamble, 8–12 words quick" guidance to the
agent-loop-v2 block.
- **Files MCP**: `src/core/coder/core/system-prompt.ts` (the `agentLoopBlock`).
- **Reference pattern**: codex `gpt_5_1_prompt.md` — *"Persist until the task is fully handled end-to-end within the current turn whenever feasible…"*.
- **Verification metric**: in eval suite, premature-`'completed'` stops with unfinished todos drop ≥30% (residual after stop-guard v2). Average preamble length in sampled runs ≤15 words.

---

## Section 4 — Anti-recommendations

### A1. claude-code's `+500k task_budget` framing
**Appeal**: looks like a clean way to give the model headroom.
**Why skip**: per the input report, this is a **reactive** budget tied to API
beta `task-budgets-2026-03-13`, not the open-ended "+500k autopilot"
marketing implied. We don't have access to that beta; emulating it
client-side would require duplicating provider token-accounting logic. Our
auto-continue recap (v2) already covers the practical need.

### A2. Codex's unified `apply_patch`
**Appeal**: one tool, one mental model. ~2200-char description handles
Add/Delete/Update/Move uniformly.
**Why skip**: we already ship `edit_file`, `multi_edit`, and read-then-edit
flows tightly integrated with our hooks and result-dedup. Migration cost
(every existing edit pathway, hooks consumer, eval re-baseline) exceeds the
benefit (slightly cleaner prompt). Also: codex explicitly forbids re-reading
after patch — incompatible with our doom-loop guard, which relies on
read-after-edit confirmation in some flows.

### A3. kimi-cli's `max_steps_per_turn=1000`
**Appeal**: "never artificially cut off the agent."
**Why skip**: with our model mix (anthropic, openai, kimi-code, deepseek, glm,
gemini), failure modes differ. A 1000-step ceiling defangs our doom-loop and
result-dup guards by giving them too much rope. Our current strict=3 / dup=5
/ result-dup=1 thresholds are calibrated against observed sessions 609/622 —
raising the outer bound undoes that calibration.

### A4. claude-code's autoDream cross-session memory
**Appeal**: emergent memory across sessions, MEMORY.md auto-curation.
**Why skip**: requires (i) durable cross-session transcript-hints store, (ii)
forked-agent infra for consolidation gating on time + session count, (iii) a
`MEMORY.md` ingest path on session start, (iv) UI for users to inspect/edit
consolidated memory. Until those prereqs exist, ROI is low and the failure
mode (stale wrong "memory" injected into new sessions) is high-risk.

### A5. kimi-cli's plan-file auto-approval
**Appeal**: skip approval on plan-file edits, which the user "obviously
wants."
**Why skip**: our `submit_plan` / `submit_tasks` / `execute_task` flow runs
through `hookRegistry` and `policy.ts` — the unified approval path is what
makes hook authors' contracts predictable. A bypass for one tool category
leaks into every hook author's mental model and creates an asymmetric
edge-case to document.

---

## Section 5 — Sequencing (3 PRs)

### PR-1: Cache & framing (R2 + R6)
- **Scope**: introduce `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`; reorder
  `system-prompt.ts` so all session-mutable content trails the marker; add
  persistence + preamble paragraphs to agent-loop-v2 block.
- **LOC**: ~180.
- **Risk**: medium — one-time cache invalidation on rollout. Snapshot tests
  required to verify byte-stability under varying session inputs.
- **Verification**: 10-turn synthetic-session cache-stability test; eval-suite
  premature-stop drop ≥30%.

### PR-2: Recovery hardening (R1 + R5)
- **Scope**: per-recovery-path circuit breaker map in `runner.ts`;
  tenacity-style exp+jitter on 429/5xx/timeout in provider invocation;
  preserve provider fallback chain as outer fallback after retries exhaust.
- **LOC**: ~140.
- **Risk**: low — additive guards; existing doom-loop logic untouched.
- **Verification**: session-622 reproducer aborts within 3 attempts;
  synthetic 429 storm completion rate ≥90%.

### PR-3: Compaction quality (R3 + R4)
- **Scope**: tagged-section template in `summarizer.ts`; preserve-last-2-pairs
  in `compaction.ts` with tool_use/tool_result atomic-pairing audit.
- **LOC**: ~250.
- **Risk**: medium — touches the most cache-sensitive area; eval suite must
  catch summary regressions before rollout.
- **Verification**: 3-sequential-compaction round-trip test (0 hallucinated
  pending_tasks); 609-style goal-fidelity reproducer passes.
