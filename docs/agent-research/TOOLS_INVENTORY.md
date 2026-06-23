# TOOLS INVENTORY: Codex / kimi-cli / claude-code vs MCP

Tool-by-tool comparison across the three reference repositories and our own
coder agent. Captures **which tools each project exposes to the model**, where
they overlap, and where MCP genuinely lacks something the others have.

Counts (native tools the model directly invokes):

| Repo | Tools | Notes |
|---|---|---|
| Codex | ~28 | Heavy on multi-agent (8 tools); editing via single `apply_patch`; exploration delegated to MCP |
| kimi-cli | ~20 | Compact; unified background task API; D-Mail context revert |
| claude-code | ~44 | Largest surface; LSP + REPL + Cron + Worktree + Coordinator-mode tools |
| **MCP (us)** | **~98 across tiers** | Strong on semantic navigation (mcp__*) + snapshots + tiered exposure |

---

## Section 1 — Capability matrix

Legend: ✅ present · ⚠️ partial / different shape · ❌ absent.

### Execution

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Single shell exec | ✅ `shell` / `shell_command` | ✅ `Shell` | ✅ `Bash` | ✅ `run_command` |
| Long-running / background | ✅ `exec_command` (PTY+session_id) + `write_stdin` | ✅ `Shell{run_in_background}` + `TaskList`/`TaskOutput`/`TaskStop` | ✅ `Bash{run_in_background}` + `TaskOutput`/`TaskStop` | ⚠️ `pty_tools` (session) but no unified bg-task API |
| Python REPL / sandboxed code | ❌ | ❌ | ✅ `REPL` | ✅ `code_exec` |
| Sleep / wait | ❌ | ❌ | ✅ `Sleep` | ❌ |
| Permission elevation at runtime | ✅ `request_permissions` | ❌ (approval system handles inline) | ❌ | ❌ |

### Editing

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Unified patch (Add/Update/Delete in one call) | ✅ `apply_patch` (Lark grammar) | ❌ | ❌ | ❌ |
| Find/replace single edit | ❌ (forced via apply_patch) | ✅ `StrReplaceFile` | ✅ `Edit` (with `replace_all`) | ✅ `edit_file` |
| Batched multi-edit | ⚠️ via apply_patch | ⚠️ via list of edits in StrReplaceFile | ❌ (multiple Edit calls) | ✅ `multi_edit` |
| File create/overwrite | ⚠️ via apply_patch | ✅ `WriteFile` | ✅ `Write` | ✅ `write_file` / `create_file` |
| Notebook (.ipynb) cell edit | ❌ | ❌ | ✅ `NotebookEdit` | ❌ |
| Pre-read enforcement | ⚠️ prompt only | ⚠️ prompt only | ✅ tool-side check | ✅ pre-read cap (PR-5) |
| `replace_all` flag | ❌ | ❌ | ✅ | ⚠️ via multi_edit |

### Exploration

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| File read | ❌ (via shell) | ✅ `ReadFile` | ✅ `Read` (also images, PDFs, ipynb) | ✅ `read_file`, `mcp__read_file` |
| Image/media read | ❌ | ✅ `ReadMediaFile` | ✅ via `Read` | ✅ `view_image` |
| Glob | ❌ (via shell) | ✅ `Glob` | ✅ `Glob` | ✅ `glob` |
| Grep | ❌ (via shell) | ✅ `Grep` (ripgrep) | ✅ `Grep` (ripgrep dialect) | ✅ `grep_code` |
| File-skeleton / outline | ❌ | ❌ | ❌ | ✅ `mcp__get_file_skeleton` / `mcp__get_file_structure` |
| Symbol body extraction | ❌ | ❌ | ❌ | ✅ `mcp__get_symbol_body` |
| Find references | ❌ | ❌ | ⚠️ via `LSP` tool | ✅ `mcp__find_references` |
| Trace usage / prepare-edit context | ❌ | ❌ | ⚠️ via `LSP` | ✅ `mcp__prepare_edit`, `mcp__trace_usage` |
| LSP integration | ❌ | ❌ | ✅ `LSP` (def/refs/hover/symbols) | ✅ `lsp_tools` |
| Project overview / pulse | ❌ | ❌ | ❌ | ✅ `mcp__get_project_pulse`, `mcp__get_project_overview` |

### Coordination

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Subagent spawn (single) | ✅ `spawn_agent` | ✅ `Agent` | ✅ `Agent` (Task) | ✅ `spawn_subagent` |
| Subagent spawn (parallel) | ✅ `spawn_agents_on_csv` (bulk) | ⚠️ via multiple Agent calls | ⚠️ via Coordinator mode | ✅ `spawn_agents` |
| Send msg to running agent | ✅ `send_message` / `send_input` / `followup_task` | ❌ | ✅ `SendMessage` | ✅ `send_message`, `send_input` |
| Wait for agent | ✅ `wait_agent` (V1 status / V2 mailbox) | ⚠️ via TaskOutput on bg agent | ⚠️ via TaskOutput | ✅ `wait_agents` |
| List live agents | ✅ `list_agents` | ⚠️ via TaskList | ❌ | ✅ `list_agents` |
| Close / cleanup agent | ✅ `close_agent` + descendants | ⚠️ TaskStop | ⚠️ TaskStop | ⚠️ via abort signal |
| Agent team / swarm primitives | ❌ | ❌ | ✅ `TeamCreate` + `SyntheticOutput` (coordinator mode) | ❌ |
| Bulk worker over CSV/dataset | ✅ `spawn_agents_on_csv` | ❌ | ❌ | ❌ |
| Resume previously-closed agent | ✅ `resume_agent` | ✅ `Agent{resume}` | ❌ | ⚠️ via session resume only |

### Planning & state

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Lightweight todo list | ⚠️ via `update_plan` | ✅ `SetTodoList` | ✅ `TodoWrite` | ✅ `todo_write` |
| Update-plan with steps + status | ✅ `update_plan` | ❌ (todos only) | ❌ (todos only) | ⚠️ via todo_write |
| Plan-mode lifecycle (enter/exit, file, options) | ❌ | ✅ `EnterPlanMode` + `ExitPlanMode{options}` | ✅ `EnterPlanMode` + `ExitPlanMode` | ⚠️ `submit_plan` (single, no options) |
| Multi-option plan (user picks) | ❌ | ✅ `ExitPlanMode{options[]}` | ❌ | ❌ |
| Structured task list (approve + execute per-task) | ❌ | ❌ | ⚠️ `TaskCreate/Get/Update/List` (just tracking) | ✅ `submit_tasks` + `execute_task` + `task_complete` (curated files/refs/deps) |
| Goal (session-wide objective) | ✅ `create_goal` / `get_goal` / `update_goal` (token+time budget) | ❌ | ❌ | ✅ `create_goal` / `get_goal` / `update_goal` |
| Ask-user with options | ✅ `request_user_input` (1-3 q × 2-3 opt) | ✅ `AskUserQuestion` (1-4 q × 2-4 opt + multi-select) | ✅ `AskUserQuestion` (with preview) | ✅ `ask_user` |
| Free-form "think" / scratchpad | ❌ | ✅ `Think` | ❌ | ❌ |
| Brief message to user mid-turn | ❌ | ❌ | ✅ `Brief` | ❌ |

### Memory & long-term context

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Snapshot / decision capture | ❌ | ❌ | ❌ | ✅ `mcp__add_snapshot` + `mcp__query_snapshots` |
| Cross-session memory consolidation | ❌ | ❌ | ✅ `autoDream` (background, not a tool) | ❌ |
| Context-revert / D-Mail | ❌ | ✅ `SendDMail` | ❌ | ❌ |

### Web

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Web search | ✅ `web_search` (live or cached, configurable) | ✅ `SearchWeb` | ✅ `WebSearch` (must cite sources) | ✅ `web_search` |
| Web fetch / scrape | ❌ | ✅ `FetchURL` (Moonshot service + trafilatura fallback) | ✅ `WebFetch` (HTML→markdown via AI, 15-min cache) | ✅ `web_fetch` |
| Image generation | ✅ `image_generation` | ❌ | ❌ | ❌ |

### MCP / external

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| List MCP resources | ✅ `list_mcp_resources` / `_templates` | ❌ | ✅ `ListMcpResources` | ⚠️ via tier expansion |
| Read MCP resource by URI | ✅ `read_mcp_resource` | ❌ | ✅ `ReadMcpResource` | ❌ |
| Tool discovery (search deferred tools) | ✅ `tool_search` (BM25) | ❌ | ✅ `ToolSearch` | ✅ `find_tools` + `expand_toolset` (tier system) |
| MCP auth flow | ❌ | ❌ | ✅ `McpAuth` | ⚠️ via admin panel |
| Plugin/connector install request | ✅ `request_plugin_install` | ❌ | ❌ | ❌ |

### Git & worktree

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Git operations as dedicated tools | ❌ (via shell) | ❌ (via shell) | ❌ (via Bash) | ✅ `git_status`/`diff`/`log`/`add`/`commit`/`branch` |
| Enter/exit worktree | ❌ | ❌ | ✅ `EnterWorktree` / `ExitWorktree` | ✅ `enter_worktree` / `exit_worktree` |

### Scheduling & remote

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Cron / scheduled tasks | ❌ | ❌ | ✅ `CronCreate` / `CronDelete` / `CronList` | ❌ |
| Remote trigger (CCR API) | ❌ | ❌ | ✅ `RemoteTrigger` | ❌ |

### Skills

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Skill execution / templating | ❌ | ✅ skill module (`src/kimi_cli/skill/`) | ✅ `Skill` (`Execute skill: {skill}`) | ✅ skill discovery + invoke tools |

### Review / code-quality

| Capability | codex | kimi-cli | claude-code | MCP |
|---|---|---|---|---|
| Dedicated code-review subagent | ❌ | ❌ | ❌ | ✅ `request_review` |
| Diagnostics / typecheck pull | ❌ | ❌ | ⚠️ via LSP | ✅ `diagnostics_tools` |

---

## Section 2 — Gap analysis

Only gaps where ≥2 reference repos have it AND we don't (or our shape is materially weaker).

### G1. Notebook (.ipynb) cell edit
- **Refs**: claude-code `NotebookEdit` (replace/insert/delete cell); kimi+codex have nothing equivalent.
- **Single ref**, demoted. Skip until a user asks.

### G2. Sleep / wait primitive
- **Refs**: claude-code `Sleep` only.
- **Single ref**, demoted.

### G3. Cron / scheduled background agents
- **Refs**: claude-code only.
- **Single ref**, demoted (also requires durable scheduler infra we don't have).

### G4. Bulk worker over dataset (CSV)
- **Refs**: codex `spawn_agents_on_csv` only (others would compose via spawn_agents in a loop).
- **Single ref**, demoted. Could be a small wrapper over spawn_agents if a user case appears.

### G5. Multi-option plan with user pick (kimi-cli ExitPlanMode + claude-code partial)
- **Refs**: kimi-cli has `options:list[PlanOption]` so user picks an approach; claude-code presents the plan but with single-track approve/reject.
- **MCP state**: `submit_plan` accepts a single plan, no options.
- **Sintoma**: when the agent has 2-3 valid approaches, it currently has to pick one and hope. With options, the user decides which to execute.
- **Impacto**: médio — improves the "I'm not sure which path you want" UX.
- **Esforço**: M — submit_plan schema + dashboard UI changes.
- **Encaixe**: bootstrap tier (replaces submit_plan).

### G6. "Think" scratchpad tool
- **Refs**: kimi-cli `Think` only. Claude-code has thinking-block streaming but no dedicated tool.
- **Single ref**, demoted (we already get reasoning blocks from thinking-enabled models).

### G7. Background task management UNIFIED across shell + agents
- **Refs**: kimi-cli has `TaskList` / `TaskOutput` / `TaskStop` covering both shell and agent backgrounds. Claude-code has `TaskOutput`/`TaskStop` for agent backgrounds. Codex has `exec_command` returning session_id + `write_stdin`.
- **MCP state**: we have `pty_tools` for shell sessions. No equivalent for backgrounded agents (spawn_agents waits synchronously).
- **Sintoma**: a long-running implement-subagent (e.g. running tests for 30 min) blocks the parent. Would benefit from "fire-and-poll" pattern.
- **Impacto**: médio — only relevant for very long subagent runs.
- **Esforço**: M-L — needs a session-wide task registry + non-blocking spawn_agents variant + 3 new tools.
- **Encaixe**: navigate tier.

### G8. Inter-agent message routing (send_message to running agent)
- **Refs**: codex `send_message`/`send_input`/`followup_task`. claude-code `SendMessage` (coordinator mode). kimi-cli ❌.
- **MCP state**: we have `send_message` and `send_input` already (mapped from `tools/send-message.ts`, `tools/send-input.ts`).
- **Already covered.** No gap.

### G9. WebFetch with AI-summarization fallback
- **Refs**: claude-code `WebFetch` (HTML→markdown via cheap model, 15-min cache, copyright guards). kimi-cli `FetchURL` (Moonshot service + trafilatura fallback).
- **MCP state**: `web_fetch` exists but unclear if it does AI summarization. Worth checking.
- **Sintoma potencial**: large HTML pages bloat context if not summarized.
- **Impacto**: baixo-médio depending on current implementation.
- **Esforço**: S if we just add a flag to existing tool.

### G10. Permission elevation at runtime (`request_permissions`)
- **Refs**: codex `request_permissions` (network/filesystem scope grant mid-turn).
- **Single ref**. Codex-specific to its sandbox model.
- **Demoted** — we already have plan-mode + admin tier as our access-control surface.

### G11. MCP resource listing tools
- **Refs**: codex (`list_mcp_resources`/`_templates`/`read_mcp_resource`); claude-code (`ListMcpResources`/`ReadMcpResource`).
- **MCP state**: we expose MCP servers via tier expansion, not via dedicated resource tools. Different shape.
- **Sintoma**: when a user adds an MCP server with non-tool **resources** (templates, files), we currently can't surface them.
- **Impacto**: baixo até alguém pedir.
- **Esforço**: M — MCP bridge already speaks the protocol; just need to wrap the resource API.

### G12. Plugin/connector install request
- **Refs**: codex `request_plugin_install` only.
- **Single ref**, demoted. Codex-specific to OpenAI plugin marketplace.

### G13. Image generation tool
- **Refs**: codex `image_generation` only (uses OpenAI image API).
- **Single ref**, demoted (provider-specific, narrow use case for a coding agent).

---

## Section 3 — Top 5 recommendations (by ROI)

Each ROI = (concrete-symptom-impact × leverage-across-users) / effort.

### R1. Multi-option `submit_plan` — ROI 7.5
Let the agent submit 2–3 alternative approaches and have the user pick one
(kimi-cli's `ExitPlanMode{options:list[PlanOption]}`). The dashboard
already renders plan approval; just adds option selection.
- **Refs**: kimi-cli `tools/plan/__init__.py:81-325`. claude-code partial.
- **Files MCP**: `src/core/coder/tools/plan.ts`, schema in `submit_plan`,
  dashboard plan-modal component.
- **Sintoma real**: agent currently picks one path silently when 2-3 are
  reasonable; user can only approve/reject the chosen one.
- **Métrica**: % of plans where user revises (today) vs picks an
  alternative (after) — should drop revision rate ≥30%.

### R2. WebFetch summarization-by-default — ROI 7.0
Verify `web_fetch` already summarizes HTML → markdown via a cheap model.
If not, add it (claude-code pattern). Cap raw HTML ingestion to e.g.
8k chars; anything larger goes through the summarizer with the URL +
section headings preserved.
- **Refs**: claude-code `tools/WebFetchTool/prompt.ts:3` (HTML→markdown via
  AI, 15-min cache). kimi-cli `tools/web/fetch.py:22-189` (Moonshot service
  + trafilatura).
- **Files MCP**: `src/core/coder/tools/web.ts`.
- **Sintoma real**: a single web_fetch on a docs page can blow 50k tokens
  into context.
- **Métrica**: average web_fetch tool_result size in last 30 days; aim to
  drop ≥50% after rollout.

### R3. Notebook (.ipynb) cell edit — ROI 5.5 (only if user-base has notebooks)
Only one reference (claude-code), but the use case is real for ML / data
projects. **Don't ship until** we know we have notebook users — easy to
add after the fact.
- **Refs**: claude-code `tools/NotebookEditTool/prompt.ts:1`.
- **Files MCP**: new `src/core/coder/tools/notebook.ts`.
- **Trigger**: first user with .ipynb files in their indexed projects.

### R4. Unified background task API (TaskList / TaskOutput / TaskStop) — ROI 5.0
Lets `spawn_agents` run async + a long shell command run detached, both
managed via a unified session task registry. Today our `spawn_agents`
blocks; long shell uses `pty_tools`.
- **Refs**: kimi-cli `tools/background/__init__.py:146-318`; claude-code
  `tools/TaskOutputTool` + `tools/TaskStopTool`.
- **Files MCP**: new `src/core/coder/tools/background.ts`,
  `src/core/coder/sessions/store.ts` (new table or coder_session_inputs
  reuse), `src/core/coder/tools/spawn-agent.ts` (add async path),
  `src/core/coder/tools/shell.ts` (background flag).
- **Sintoma real**: long-running tests in spawn_agents block the parent
  for the duration.
- **Esforço**: M-L. Worth shipping only after we see real long-running
  subagent traffic.

### R5. MCP resource listing tools — ROI 4.5
Add `list_mcp_resources` / `read_mcp_resource` so projects whose external
MCP servers expose **resources** (not just tools) become visible. Today
the bridge speaks the protocol but we don't wire the resource side.
- **Refs**: codex
  `tools/handlers/mcp_resource_spec.rs`; claude-code
  `tools/ListMcpResourcesTool/prompt.ts:3`.
- **Files MCP**: `src/core/coder/tools/mcp-resources.ts` (already exists?
  audit); `src/core/coder/tools/mcp-bridge.ts`.
- **Trigger**: first user with an MCP server exposing resources.

---

## Section 4 — Anti-recommendations

### A1. Codex `apply_patch` (already in COMPARISON.md anti-rec A2)
Single unified Lark-grammar tool. Switching cost > benefit, and incompatible
with our doom-loop guard's read-after-edit verification path.

### A2. Codex `spawn_agents_on_csv`
Bulk-worker tool with CSV templating. Edge case — useful for batch
classification but our coding-agent users don't typically run CSV jobs.
Easy to compose via spawn_agents in a loop if it ever matters.

### A3. kimi-cli `D-Mail` (context revert)
Lets the model revert to a previous checkpoint and replace recent context
with a summary. Conceptually overlaps with our **summarizer overlay
(PR-3) + last-N preservation**. Adding D-Mail would create two overlapping
mechanisms with different semantics. Skip — our compaction path already
covers the practical need.

### A4. claude-code `Sleep`
A 1-line tool. The use case (pace polling, await async event) is rare in
a coding agent. We'd just be adding surface area for the model to misuse
(e.g. `Sleep` instead of resolving a real wait condition).

### A5. claude-code `CronCreate` / `RemoteTrigger`
Scheduled / remote agents need: durable scheduler (process / DB / cron
worker), auth flow for remote API, multi-tenant model. Bringing this into
MCP requires infra well beyond the agent runner. Defer until/if MCP grows
a routine-scheduling product surface.

### A6. claude-code `TeamCreate` / `SyntheticOutput` (Coordinator mode)
Multi-agent swarm primitives. Our `spawn_agents` already does
fan-out/fan-in. The team/synthetic-output abstraction is shaped around
claude-code's specific async-streaming UX. Importing it would require
a sibling runtime mode we don't have. Skip.

### A7. Codex `image_generation`
OpenAI-specific, narrow value for a coding agent. Skip.

### A8. kimi-cli `Think`
Free-form scratchpad. Our thinking-enabled providers already stream a
thinking block — exposing it as a tool just creates a place to spam.

---

## Section 5 — "Already have" (our differential)

Tools we ship that NONE of the three references have. Important context for
prioritization: when a user evaluates MCP vs codex/claude-code, these are the
features that distinguish us. We should NOT regress them, and we should
make sure they're discoverable in the docs.

| Tool family | What it does | Refs that have it |
|---|---|---|
| `mcp__find_references` / `mcp__trace_usage` / `mcp__prepare_edit` | Semantic call-graph navigation; "who calls this?", "what does this depend on?" | None (claude-code's LSP gets close but is per-LSP-server) |
| `mcp__get_file_skeleton` / `mcp__get_symbol_body` / `mcp__get_file_structure` | Tree-sitter outline + body extraction; saves vs reading entire file | None |
| `mcp__get_project_pulse` / `mcp__get_project_overview` / `mcp__get_architecture` / `mcp__get_repo_map` | Curated project introspection ("here's the shape of the codebase") | None |
| `mcp__add_snapshot` / `mcp__query_snapshots` | Long-term memory of architectural decisions, patterns, todos | None (claude-code's autoDream is opaque background, not a tool) |
| `mcp__search` / `mcp__search_global` / `mcp__search_concepts` / `mcp__search_by_kind` | Hybrid semantic + lexical search across indexed projects | None |
| `request_review` | Dedicated reviewer subagent with structured findings JSON | None |
| `expand_toolset` + tier system (bootstrap/navigate/admin) | Lazy tool exposure to keep the bootstrap turn small | claude-code has `ToolSearch` (deferred tools, similar concept) |
| `submit_tasks` + `execute_task` + `task_complete` (curated files/refs/deps + per-task approval) | Heavy structured task workflow distinct from todo_write | None (claude-code's TaskCreate/Get/Update are pure tracking) |
| Company-mode tools (master / kanban / board / qa / design-system / shared-drive / docs / env / database / sandbox / subordinate-kanban) | Multi-agent organizational layer | None |
| `enter_worktree` / `exit_worktree` integrated with sandbox | Isolated git worktree per session | claude-code has worktree (similar) |
| `mcp__index_project` / `mcp__add_snapshot` admin tools | Project-level admin operations gated by tier | None |

---

## Section 6 — Sequencing suggestion

**Now**: nothing to ship from this analysis. None of R1-R5 is urgent
relative to the open work in PRs 1-6 (which still need production
validation).

**After production validation of PR-1..6**:
1. **R2 (WebFetch summarization)** — fastest to verify and ship. ~1 day.
2. **R1 (Multi-option submit_plan)** — UX win, modest effort. ~2-3 days
   (backend + dashboard UI).

**On user demand**:
3. R3 (Notebook editing) — when first .ipynb user shows up.
4. R4 (Unified background tasks) — when first long-running spawn_agents
   complaint shows up.
5. R5 (MCP resources) — when first MCP-with-resources server is added.

**Skip definitivamente** (anti-recs A1-A8): apply_patch, spawn_agents_on_csv,
D-Mail, Sleep, Cron/RemoteTrigger, TeamCreate/SyntheticOutput,
image_generation, Think.

---

## Section 7 — Bottom line

**The tool surface is not where MCP is weakest.** We already have a richer
exploration toolkit than any reference (semantic navigation via mcp__*),
a stronger structured task workflow (submit_tasks + execute_task), and a
unique long-term-memory differentiator (snapshots).

**The two genuine actionable gaps** are:
- **R1 — multi-option plan** (kimi-cli pattern) — UX improvement.
- **R2 — WebFetch summarization** (claude-code pattern) — token economy.

Everything else is single-ref or demoted. Production-validate PR-1..6
first; revisit this list after.
