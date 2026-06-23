# Prompts in CodeStudio — a maintainer's guide

How the agent system prompts are built, where each one lives, and how to edit
them without breaking the model's behavior or the parsers that read its output.

This is the companion to [ARCHITECTURE.md](ARCHITECTURE.md) and
[INDEXER.md](INDEXER.md) — read those for the delivery layer and the tool-tier
system; this doc is specifically about the prompt strings.

> **The two rules that matter most**
> 1. **Never rename or drop a JSON field a parser reads.** Four prompts emit a
>    strict JSON/tagged contract (snapshot review, review subagent, summarize
>    v1/v2). Changing a field name silently breaks parsing.
> 2. **Never move `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` or put session-varying text
>    above it.** Everything above the boundary is the cache-stable prefix; volatile
>    text above it destroys cross-session prompt-cache hits.

---

## 1. Overview — two families of prompt

| Family | What it is | Examples |
| --- | --- | --- |
| **Composed** | The main coding agent's system prompt, assembled per session from layered fragments (provider preamble + base + mode + tier/MCP hints + company blocks). Optimized so a stable prefix stays in the model provider's prompt cache. | base + mode prompts, provider preambles, tier hints, company master/subordinate blocks |
| **Functional / standalone** | A single string for one job, run on its own LLM call. Several carry a **strict output contract** parsed by code. | snapshot review, review subagent, summarizers, DocsAgent, vision describer |

The composed prompt is split at a single marker, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`:

- **Static prefix** — fixed at session creation (provider, project, OS, profile,
  mode, flags). Byte-identical across sessions that share those inputs, so the
  provider's prompt cache (Anthropic ephemeral, OpenAI prefix, ZAI auto) hits.
- **Dynamic suffix** — may vary across sessions of the same tuple (registered
  external MCP tiers, project hook output, repo map). Lives below the boundary so
  it never pollutes the cached prefix.

Per-turn volatile state (live goal, todos, active task scope, recently edited
files, retrieved memory) is **not** in the system prompt at all — it's appended
to the trailing user message each turn (see §5).

---

## 2. The assembly pipeline (composed prompt)

Primary builder: **`buildSystemPrompt(ctx)`** in
[`packages/code-agent/src/core/system-prompt.ts`](../packages/code-agent/src/core/system-prompt.ts).

Concatenation order (one `return` at the end of `buildSystemPrompt`):

```
┌─ STATIC PREFIX (cache-stable) ────────────────────────────────┐
│  preamble          providerPreamble(family)                   │
│  base              prompts/base.txt  + {{interpolation}}       │
│  planSection       prompts/plan.txt  (planMode && !spec)       │
│  agentSection      prompts/<agentId>.txt (explore|build|admin| │
│                                            spec|builder)        │
│  interactionSection  inline (ask_user / submit_* / tasks)      │
│  sessionDriveSection inline (non-company sessions only)        │
│  agentLoopBlock    buildAgentLoopBlock() (agentLoopV2)         │
│  agentlessHint     inline (CODER_AGENTLESS_MODE=1)             │
├─ SYSTEM_PROMPT_DYNAMIC_BOUNDARY ──────────────────────────────┤
│  dynamicSuffix     customTiersBlock + project hook + repoMap   │
└───────────────────────────────────────────────────────────────┘
```

Fragment sources:

- **provider preamble** — `providerPreamble(family)`. One short block per
  `ProviderFamily`: `anthropic` · `openai`/`openrouter` · `zai` · `gemini` ·
  `deepseek` · `kimi-code` · `generic`.
- **base body** — [`prompts/base.txt`](../packages/code-agent/src/prompts/base.txt)
  via `loadPrompt` + `interpolate`. Placeholders: `{{projectName}}`,
  `{{projectRoot}}`, `{{os}}`, `{{tierHint}}`, `{{mcpSection}}`.
- **mode identity** — [`prompts/<agentId>.txt`](../packages/code-agent/src/prompts/)
  for `explore` / `build` / `admin` / `spec` / `builder`. `plan` is loaded
  separately via `planSection`; `spec` deliberately does **not** also load
  `plan.txt` (it has its own `submit_spec` gate).
- **tier hint** — `tierHint(profile)`: `bootstrap` / `navigate` text; `full`
  emits nothing. Lists the visible tools and how to unlock more.
- **MCP section** — `mcpSection(mcpAvailable, isIndexed)`: three variants
  (full semantic-nav guide / project-not-indexed fallbacks / native-only).
- **session drive** — `sessionDriveSection`, emitted only when `ctx.sessionDrive`
  (set from `!companyContext`). Introduces the single-session working-memory tools
  (`save_note` / `list_notes` / `read_plan` / `recall_investigations`). Gated so
  company subordinates, which don't have those tools, never see it.
- **dynamic suffix** — `customTiersBlock(customTiers)` (external MCP groups),
  the `.mcp-indexer/hooks/system-prompt.js` project hook, and the repo map.

Then for **company sessions** the master/subordinate block is appended (§4), and
the **operational rules** are appended last as a mandatory, verbatim block.

---

## 3. Company layer (multi-agent orchestration)

Built in [`packages/company/src/system-prompts.ts`](../packages/company/src/system-prompts.ts),
assembled via [`services/master/prompt-builder.ts`](../packages/company/src/services/master/prompt-builder.ts):

- **`buildMasterCompanyBlock(ctx)`** — the orchestrator: project index, team
  roster, allowed-models pool, tool surface, session-keeping rules. The master
  delegates; it has no code-reading or code-writing tools.
- **`buildSubordinateCompanyBlock(ctx)`** — a worker bound to one project:
  deliverable requirement, tool surface, focus, optional role override.
- **`buildBuilderInstructions(b)`** — container-environment facts for
  service-bound subordinates (reserved files, dev server, env store, peers).
- **`buildSddMasterBlock()`** — [`prompts/sdd-master-block.ts`](../packages/company/src/prompts/sdd-master-block.ts);
  routes work through the SDD pipeline (`list_pipelines` → `start_pipeline`).

**Operational rules** (operator-authored, per session) are read by
`readOperationalRules(config_json)` in
[`services/master/config-loader.ts`](../packages/company/src/services/master/config-loader.ts)
and injected **verbatim** into the master AND every subordinate (on spawn and
resume). The same helper + same `config_json` source guarantees byte-identical
text on both sides, so the policy survives compaction (it lives in the system
prompt, not turn history). The master ENFORCES the rules; subordinates OBEY and
escalate conflicts via `ask_master`.

The crash-recovery briefing
[`prompts/master-recovery.txt`](../packages/code-agent/src/prompts/master-recovery.txt)
is **not** loaded by the composer — it's read from disk by
[`apps/http-api/server/routes/company/reestablish-master.ts`](../apps/http-api/server/routes/company/reestablish-master.ts)
when a master session is re-established.

---

## 4. Per-turn dynamic injection

Separate from the system prompt: `computeDynamicInjection(...)` in
[`packages/code-agent/src/core/runner/assembly/dynamic-injection.ts`](../packages/code-agent/src/core/runner/assembly/dynamic-injection.ts)
builds a `<system-reminder>` block appended to the **trailing user message** each
turn. It surfaces newly registered skills, recently edited files, relevant
retrieved memory, compaction markers, and the "reviewable changes" nudge
(`self_review`, gated by `CODER_SELF_REVIEW`). In non-company sessions it also
*reactively* surfaces Session Drive state — the active plan (with a `read_plan`
pointer), notes saved via `save_note`, and a `recall_investigations` nudge once
prior investigations exist. Because it never touches the cached prefix, it's free
to change every turn.

---

## 5. Prompt inventory

| Prompt | File | Purpose | Lang | Contract? |
| --- | --- | --- | --- | --- |
| base body | `code-agent/src/prompts/base.txt` | Core coding-agent identity + tools | EN | No (carries `{{vars}}`) |
| mode: explore/plan/build/admin/spec/builder | `code-agent/src/prompts/{explore,plan,build,admin,spec,builder}.txt` | Per-mode behavior & gates | EN | No |
| master recovery | `code-agent/src/prompts/master-recovery.txt` | Master crash-recovery briefing | EN | No |
| provider preambles | `code-agent/src/core/system-prompt.ts` (`providerPreamble`) | Per-family steering | EN | No |
| tier hint / MCP section | `code-agent/src/core/system-prompt.ts` | Visible tools + unlock guidance | EN | No |
| session working memory | `code-agent/src/core/system-prompt.ts` (`sessionDriveSection`, gated on `ctx.sessionDrive`) | Surfaces `save_note`/`list_notes`/`read_plan`/`recall_investigations` in non-company sessions | EN | No |
| company master block | `company/src/system-prompts.ts` (`buildMasterCompanyBlock`) | Orchestration framing | EN | No |
| company subordinate block | `company/src/system-prompts.ts` (`buildSubordinateCompanyBlock`) | Worker framing | EN | No |
| builder instructions | `company/src/system-prompts.ts` (`buildBuilderInstructions`) | Container facts (service-bound subordinates) | EN | No |
| SDD master block | `company/src/prompts/sdd-master-block.ts` | Spec-driven pipeline | EN | No |
| **snapshot review** | `services/src/services/snapshot-review-prompt.ts` | Pre-commit diff review | EN | **YES** — `findings[]` (parser: `snapshot-review-pipeline.ts`) |
| **review subagent** | `code-agent/src/tools/review-subagent.ts` | Fresh-eyes reviewer | EN | **YES** — `<review>{findings[]}` (parser: same file) |
| **summarize v1 / v2** | `code-agent/src/prompts/summarize{,-v2}.txt` | Compaction summary | EN | **YES** — 6 / 9 keys (parser: `core/summarizer.ts`) |
| DocsAgent | `docs-agent/src/prompts/system-prompt.ts` | Docs retrieval orchestrator | EN | Tool-call + `{{collections}}` |
| vision describer | `apps/http-api/server/vision-describer-impl.ts` | Image→text for blind models | EN | No (free text) |

---

## 6. Tier / tool vocabulary

Defined in [`packages/code-agent/src/tools/tiers.ts`](../packages/code-agent/src/tools/tiers.ts).

| Tier | Adds | Activation |
| --- | --- | --- |
| `bootstrap` | read/search, planning, delegation | default |
| `navigate` | write/edit/shell, git-read, deep nav, LSP, `save_memory` | `expand_toolset({tier:"navigate"})` |
| `admin` | git_commit, index/snapshot mutations, deletes | `expand_toolset({tier:"admin"})` — only when the user asks |
| `master` | spawn/coordinate subordinates, kanban write | auto when `isMaster` |
| `preview` | live-app DevTools (`preview_*`) | when a preview backend is attached |

`getToolTier(name)` falls back to `bootstrap` for any unlisted tool. Agents
discover hidden tools with `find_tools` and unlock with `expand_toolset`. When
naming a tool in a prompt, use the exact registered name (MCP tools keep the
`mcp__` prefix the model must emit).

Canonical vocabulary the prompts share:

- **Memory** — write `mcp__save_memory` (navigate), read `mcp__search_memory`
  (bootstrap), categories `decision | convention | gotcha | architecture`.
  Snapshots (`mcp__add_snapshot`, admin) are a *separate* concept.
- **Session notes** — `save_note` / `list_notes` (bootstrap, single-session only)
  capture working notes that survive compaction *within* this session; `read_plan`
  re-reads the submitted plan; `recall_investigations` reuses prior sub-agent
  findings. Distinct from project Memory above — session-local, not cross-session.
- **Tasks** — `submit_tasks` → `execute_tasks` (call **once**; wave-based) →
  inline tasks close with `task_complete`, then `execute_tasks` again. The
  singular `execute_task` is **removed** — never reference it.
- **Kanban** — current names only: `kanban_post_comment`,
  `kanban_update_objectives`, `kanban_read_my_card`, `kanban_move_to_review`
  (subordinate); `kanban_create_card`/`kanban_move_card`/… (master). The
  old `kanban_my_*` / `kanban_add_comment` / `kanban_update_checklist` /
  `kanban_update_card` aliases were removed — never reference them.

---

## 7. Conventions for editing prompts safely

- **Don't break a JSON contract.** For the four contract prompts, change only the
  surrounding prose — never the field names, the `<review>` tags, or the
  "strict JSON, no markdown" demand. The snapshot contract is pinned by
  `services/src/services/__tests__/snapshot-review-prompt.test.ts`; run it.
- **Two severity vocabularies coexist on purpose** — snapshot review uses
  `filePath` / `body` / `suggestedFix`; the review subagent uses `file` / `issue`
  / `suggested_fix`. Each matches its own parser. Do **not** harmonize them.
- **Keep the boundary in place.** Don't move `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` and
  don't add session-varying text above it.
- **Gate non-company-only tools.** Tools registered only for single sessions
  (e.g. the Session Drive tools, via `if (!opts.companyContext)`) must be surfaced
  through a section gated on the *same* condition (`ctx.sessionDrive`) — never via
  the shared `base.txt` or `tierHint`, which company subordinates also receive.
  Keying the prompt gate off the same flag as the registration keeps the prompt
  and the real tool surface from drifting.
- **Bump `SYSTEM_PROMPT_VERSION`** in
  [`core/runner/assembly/system-prompt.ts`](../packages/code-agent/src/core/runner/assembly/system-prompt.ts)
  whenever you change the static prefix or the tool surface. Format `YYYYMMDD.NN`.
  It invalidates the skip-stale fingerprint cache.
- **Keep `{{interpolation}}` valid.** Only `\w+` tokens that `base.txt` actually
  receives; the loader warns on unknown keys and renders them empty. Assemble
  conditional sections in code and pass them in as one rendered string.
- **English only** in prompt bodies. The provider preambles already tell the
  model to answer in the user's language.
- **No markdown fences around JSON output** in contract prompts.
- **Product naming** — the product is **CodeStudio**; "MCP Code Indexer" refers only
  to the indexing/search subsystem.
- **Dev workflow** — set `CODER_PROMPTS_WATCH=1` to hot-reload `.txt` prompts on
  a new session while iterating.

---

## 8. How to add a new mode or role prompt

**New built-in agent mode** (e.g. a `refactor` mode):
1. Add `code-agent/src/prompts/<mode>.txt`.
2. Register `<mode>` in the `AgentId` union / `AGENTS` map in
   [`code-agent/src/agents/index.ts`](../packages/code-agent/src/agents/index.ts)
   (profile, plan-mode, temp, max-turns). `buildSystemPrompt` already loads
   `prompts/<agentId>.txt` for any non-`plan` mode.
3. Add any mode-specific interactive-tool gating in `interactionSection`.
4. Bump `SYSTEM_PROMPT_VERSION`.

**New functional prompt with a JSON contract:** colocate prompt + parser + a
pinning test, mirroring `snapshot-review-prompt.ts` ↔ `parseFindings` ↔
`snapshot-review-prompt.test.ts`. Add it to the inventory (§5) marked
"Contract? YES".

**New company role block:** extend `buildMasterCompanyBlock` /
`buildSubordinateCompanyBlock`. Operational rules are injected centrally — do not
re-paste them per task. If the role names a tool, confirm it survives the master
filter (`master-filter.ts`) before telling the master to use it.

**Before you finish — checklist:** every referenced tool name exists in
`tiers.ts`? interpolation vars valid? boundary untouched? `SYSTEM_PROMPT_VERSION`
bumped? contract fields unchanged (+ test passing)? English-only?
