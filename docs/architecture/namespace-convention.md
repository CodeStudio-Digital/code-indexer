# Namespace Convention

> **Status:** Adopted 2026-05-22. Applies to: SQLite table names, AgentDB-style memory namespaces (when adopted), MCP tool prefixes, dashboard route segments, event-bus channel keys.

## Why this exists

D:\MCP is a multi-package monorepo (`packages/code-agent`, `packages/company`, `packages/indexer`, `packages/store`, `packages/services`, `packages/docs-agent`, ...) and each package can add tables/events/skills/namespaces. Without a convention, two packages can pick the same key by accident (e.g. both writing to a generic `pattern` namespace), or a future plugin can shadow a load-bearing internal name.

A namespace convention is **cheap insurance** against that class of bug.

## Rules

### 1. Table names — `<prefix>_<noun>[_<qualifier>]`

| Prefix | Owner | Examples |
|---|---|---|
| `coder_` | `packages/code-agent` | `coder_sessions`, `coder_messages`, `coder_tool_calls`, `coder_plans`, `coder_tasks_state` |
| `company_` | `packages/company` | `company_sessions`, `company_agent_runs`, `company_board`, `company_session_projects`, `company_role_assignments`, `company_templates` |
| `kanban_` | `packages/company` (board feature) | `kanban_cards`, `kanban_comments`, `kanban_card_agents` |
| `provider_` | `packages/services/providers` | `provider_configs`, `provider_models` |
| `oauth_` | `packages/services/providers` + `packages/services/src/services/oauth` (provider logins) | `oauth_tokens`. Legacy, no code since the inbound auth removal (tables kept): `oauth_clients`, `oauth_auth_codes`, `oauth_refresh_tokens` |
| `mcp_` | `packages/services/mcp` | `mcp_server_configs`, `mcp_server_tools`, `mcp_oauth_*` |
| `skill_` | `packages/code-agent/skills` + `packages/store/skill-store` | `skill_definitions`, `skill_session_config`, `skill_usage_log` |
| `embedding_` | `packages/indexer/embedding` | `embedding_configs` |
| `snapshot_` | `packages/services/snapshots` | `snapshot_files` |
| `vector_` | `packages/indexer/vector` | `vector_store_configs` |
| `docs_` | `packages/docs-agent` | `docs_research_sessions`, `doc_corpus`, `doc_sources`, `doc_rerank_cache` |
| `auth_` | — (legacy, no code since the inbound auth removal; table kept) | `auth_audit_log` |
| `api_` | — (legacy, no code since the inbound auth removal; table kept) | `api_tokens` |
| `quality_` | `packages/services/quality` | `quality_classifications`, `quality_interventions` |
| `pipeline_` | `packages/company/role-pipeline` | (uses `company_pipeline_*` — pipeline is a sub-domain of company) |

**New tables MUST start with one of these prefixes.** Adding a new prefix is OK — document it here in the same PR.

### 2. AgentDB-style memory namespaces — kebab-case, owner-prefixed

When introducing semantic memory namespaces (e.g. for a future trajectory-replay or pattern-store), the namespace key is **kebab-case** with an owner prefix.

| Convention | Example |
|---|---|
| `<owner>-<purpose>` | `coder-trajectories`, `worker-history`, `security-patterns`, `docs-citations` |

**Reserved (do NOT shadow):**

| Namespace | Why reserved |
|---|---|
| `default` | Catch-all; reserved to keep semantics explicit. Avoid. |
| `pattern` (singular) | If/when we adopt ReasoningBank-style pattern memory, this is the canonical fallback target. Do not write generic data here. |
| `patterns` (plural) | Same reservation as `pattern`. Pluralization gotcha: `pattern` and `patterns` are NOT the same namespace — pick one consciously. |
| `claude-memories` | If/when we bridge Claude Code's auto-memory into D:\MCP storage, this name is taken. |
| `system` | Internal system events; not user data. |

### 3. MCP tool names — `<surface>_<action>[-<qualifier>]`

| Surface | Convention | Examples (existing or planned) |
|---|---|---|
| Search / index | `search_*`, `symbol_*`, `graph_*` | `search_code`, `symbol_definition`, `graph_neighbors` |
| Coder agent | `coder_*` | `coder_run`, `coder_status` |
| Company / agents | `agent_*`, `board_*`, `kanban_*` | `agent_spawn`, `board_read`, `kanban_create_card` |
| Schedules | `schedule_*` | `schedule_list`, `schedule_create`, `schedule_delete`, `schedule_pause`, `schedule_run-now` |
| Docs | `docs_*` | `docs_search`, `docs_synthesize`, `docs_list_sources` |
| Workers (via schedules) | reuse `schedule_*` — workers are scheduled subordinates, not a separate surface | — |

Use underscore between `surface` and `action`; hyphen inside `action` if the action is multi-word (`run-now`). No camelCase.

### 4. Dashboard route segments — kebab-case, plural

`/projects`, `/agents`, `/snapshots`, `/schedules`, `/docs`, `/costs`.

Single-resource segments under a parent use kebab-case: `/agents/:sessionId/schedules`, `/projects/:id/snapshots`.

### 5. Event-bus channels — `<scope>.<verb>[_<qualifier>]`

CompanyEventBus already uses this pattern (see `packages/company/src/services/CompanyEventBus.ts`):

| Channel | Scope | Verb |
|---|---|---|
| `master.ended` | master lifecycle | ended |
| `master.resurrected` | master lifecycle | resurrected |
| `master.inbox_received` | master inbox | inbox_received (multi-word OK with underscore inside verb segment) |
| `user.message_received` | user input | message_received |
| `subordinates.changed` | subordinate set | changed |
| `schedule.fired` (new) | scheduler | fired |

Add new channels only when there's a clear cross-service consumer; same-service notifications stay direct.

## Adoption rules

- **New PRs that add tables, namespaces, MCP tools, or event channels MUST conform.** Reviewers can block on naming.
- **Renames are NOT required for existing names that predate this doc** — historical inconsistency is documented, not retroactively churned.
- **When in doubt, mirror the closest existing prefix** rather than invent a new one.
- **A new prefix is a one-line PR** to this doc. Do it before writing the code.

## See also

- `packages/store/src/migrations/index.ts` — the migration runner that processes new tables.
- `packages/company/src/services/CompanyEventBus.ts` — canonical event-bus shape.
- `docs/research/ruflo/comparison.md` §8 — the original ruflo namespace-convention reference that inspired this doc.
