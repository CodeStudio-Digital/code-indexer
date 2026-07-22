# 04 — Memory, context, compaction and handoff

## Summary

CodeStudio's memory architecture is already one of its advantages, but it is not visible enough in the live session. ClaudeOpen's useful lesson is not that its memory is necessarily richer; it is that handoff, compaction and memory-like operations are part of the execution stream and tool abstraction.

## ClaudeOpen observations

### Handoff summary

ClaudeOpen has dedicated continuation handling with a prompt asking for a compact handoff summary another instance can use to resume work in claudeopen/claude-code-src/agent/tools.js:262-283.

This gives agent continuation a clear artifact rather than relying only on transcript length.

### Compaction event

compaction_delta records are normalized into a compaction event carrying compacted content in claudeopen/claude-code-src/agent/compaction.js:361-364.

Short source excerpt from claudeopen/claude-code-src/agent/compaction.js:361-364:

~~~js
case "compaction_delta":
  {
    if (n.type === "compaction" && n.content) {
      this._emit("compaction", n.content);
~~~

### Server-side compaction direction

ClaudeOpen recognizes both legacy compactionControl and newer server-side compaction edits, and marks the legacy parameter deprecated in claudeopen/claude-code-src/agent/compaction.js:638-643.

### Memory as tool abstraction

Memory functionality participates in the same tool abstraction via concurrency-safety and input-schema methods in claudeopen/claude-code-src/agent/memory.js:3677-3683.

### Instruction hierarchy (verified this round)

ClaudeOpen loads instruction memory in a strict hierarchy — **Managed** (organization policy) → **User** (`~/.claude/CLAUDE.md`) → **Project** (`./CLAUDE.md`, `./.claude/CLAUDE.md`, `.claude/rules`) → **Local** (`./CLAUDE.local.md`) → **AutoMem** — memoized per session and invalidated on `session_start` in claudeopen/claude-code-src/agent/memory.js:3246-3350. Organization memory is discovered via `/v1/code/local/memory/mounts` and mounted read-only for `team` scope in claudeopen/claude-code-src/agent/memory.js:120-158 and claudeopen/claude-code-src/agent/memory.js:183-205. Every injected block is prefixed with scope metadata and an override clause ("These instructions OVERRIDE any default behavior…") in claudeopen/claude-code-src/agent/memory.js:3169-3170.

Semantic memory types are explicitly declared for the model: `user`, `feedback`, `project`, `reference` in claudeopen/claude-code-src/agent/memory.js:400-408.

### Compaction: reactive + precomputed (verified this round)

ClaudeOpen runs two compaction layers: a **reactive** compact triggered at the token threshold (`Fas`/`blo` in claudeopen/claude-code-src/agent/compaction.js:28337-28354 and claudeopen/claude-code-src/agent/compaction.js:29230-29334) and a **precomputed** compact armed in the background as context approaches the limit (`Uas` in claudeopen/claude-code-src/agent/compaction.js:28355-28441), so the threshold hit often reuses an already-paid summary. The summarization call is text-only (no tools), single-turn, and skips transcript/cache writes in claudeopen/claude-code-src/agent/compaction.js:27451-27486 and claudeopen/claude-code-src/agent/compaction.js:27687-27724. It also detects compaction thrashing ("context refilled to the limit within 3 turns … 3 times in a row") in claudeopen/claude-code-src/agent/compaction.js:27052.

## CodeStudio current state

### Durable memory tools

CodeStudio exposes durable project/user memory through explicit remember, recall and forget operations with typed categories in codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:17-45.

The implementation bounds recall result counts and provides durable recall/remember/forget behavior in codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:108-223.

### Automatic recall

Automatic recall derives a substantive task query from conversation history while filtering meta/filler prompts in codestudio_mcp-codebase/packages/code-agent/src/core/runner/memory-query.ts:51-153.

### Memory harvest during compaction

Compaction harvest promotes decisions, gotchas, conventions and procedures into durable project memory in codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:40-53 and codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:91-137.

The current harvest limit is at most ten notes and a 30-second timeout in codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:51-53.

## Gaps

### Gap 1 — memory is strong in backend but weak in session UX

The dashboard has memory panels in company/project surfaces, but project/user memory is not a first-class coder-session rail destination. The right panel destinations are session state, drive, chapters, configuration, subagents, insights, plans, diagram, notifications and worker log in codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21.

Memory therefore affects agent behavior without enough live explanation.

### Gap 2 — recall decisions are not fully auditable to the user

The agent can recall memory automatically, but the dashboard should show:

- query used,
- memories returned,
- why they were injected,
- whether they are stale,
- whether the user can forget/correct them.

Without this, stable memory can feel mysterious or wrong.

### Gap 3 — compaction output is not a first-class replay artifact

CodeStudio compaction exists and memory harvest is good, but the roadmap should make compacted summaries, handoff summaries and memory promotions RuntimeEvents so replay/resume can explain them.

### Gap 4 — memory quality cap

The harvest cap of ten notes and 30 seconds is pragmatic, but in very long multi-agent sessions it can miss important decisions. This is not a bug; it is a capacity limitation that should be visible and tunable.

### Gap 5 — recall/injection is conservative to a fault (verified this round)

Eight concrete improvement opportunities, each with code evidence:

1. **Query synthesis is only partially wired** — `memoryQuerySynthesizer` exists but only fires for continuation/meta messages (codestudio_mcp-codebase/packages/code-agent/src/index.ts:2523-2550); it should run for every substantive task query.
2. **Injection caps are very tight** — `DEFAULT_MAX_MEMORY=3` items and `MEMORY_CONTENT_CAP=300` chars (codestudio_mcp-codebase/packages/code-agent/src/core/runner/assembly/dynamic-injection.ts:162-164); standard windows could carry 5 items / 500 chars without cache pressure.
3. **Recall fires only at milestones** — relevant memory is injected at turn 1 and post-compaction only (dynamic-injection.ts:222-231); a mid-session topic change never re-triggers recall.
4. **Harvest ignores failures** — `toolTrail` collection only considers successful commands (codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:77-78), yet `errorsAndFixes` is exactly where durable `gotcha`/`procedure` memories live.
5. **Staleness is detected but never acted on** — `referenced_files` hashes mark memories stale (docs/memory-system.md:25-26), but there is no active verification, auto-supersede or user prompt on recall.
6. **Note→memory promotion is narrow** — only pinned/decision/gotcha/convention/procedure notes are promoted, and only at compaction time (memory-harvest.ts:50-53); end-of-successful-run promotion of ordinary high-quality notes is missed.
7. **Subagent memos are volatile** — `record_memo` is in-memory only (codestudio_mcp-codebase/packages/code-agent/src/tools/record-memo.ts:55-85); intermediate subagent findings vanish unless repeated in the final summary.
8. **Recall exposes no scores** — `recall_memory` returns items without relevance/staleness scores (codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:108-187), so the model cannot weigh trust, and there is no useful/not-useful feedback signal for ranking.

## Preserve

- Keep four distinct memory layers: session notes, durable agent memory, conversation chapters and recent raw context.
- Keep explicit remember/recall/forget tools.
- Keep automatic recall, but expose it.
- Keep compaction harvest, but make its decisions auditable.

## Recommendation

Make memory and compaction event-backed.

Suggested events:

~~~ts
type MemoryEvent =
  | 'memory.recall.requested'
  | 'memory.recall.returned'
  | 'memory.remember.requested'
  | 'memory.remember.saved'
  | 'memory.forget.requested'
  | 'memory.forget.completed'
  | 'compact.before'
  | 'compact.after'
  | 'handoff.created';
~~~

Dashboard should show a Session Memory panel with:

- automatic recalls for this turn,
- durable memories injected,
- memories saved during this session,
- compaction summaries,
- stale-memory warnings,
- user actions to forget/correct memory.

## Backlog

| Priority | Item | Notes |
|---|---|---|
| S | Emit memory recall/save/harvest events | Redacted payload; no raw secrets. |
| S | Add Session Memory panel under coder right rail | Link to global memory management. |
| S | Add compaction/handoff artifacts to event log | Enables replay and resume. |
| A | Show memory provenance in transcript/system cards | “Recalled because…” explanation. |
| A | Make harvest limits visible in diagnostics | Surface skipped/timeout counts. |
| A | Wire `memoryQuerySynthesizer` for every substantive task | Currently continuation/meta-only (`index.ts:2523-2550`). |
| A | Raise injection caps for standard windows | 3→5 items, 300→500 chars (`dynamic-injection.ts:162-164`). |
| A | Re-trigger recall on mid-session topic change | Turn-1/post-compaction only today (`dynamic-injection.ts:222-231`). |
| B | Harvest gotchas/procedures from failed commands too | Success-only trail (`memory-harvest.ts:77-78`). |
| B | Active staleness handling on recall | Verify hashes; offer forget/correct/auto-supersede. |
| B | Persist subagent memos beyond the run | `record_memo` is volatile (`record-memo.ts:55-85`). |
| B | Expose relevance/staleness scores in `recall_memory` | Enables trust-weighting + feedback loop. |
| B | Add memory quality review flow | Detect duplicates, stale facts and contradictions. |

## References

- claudeopen/claude-code-src/agent/tools.js:262-283
- claudeopen/claude-code-src/agent/compaction.js:361-364
- claudeopen/claude-code-src/agent/compaction.js:638-643
- claudeopen/claude-code-src/agent/memory.js:3677-3683
- codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:17-45
- codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:108-223
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/memory-query.ts:51-153
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:40-53
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:91-137
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21
