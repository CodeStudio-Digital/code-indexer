# Memory System (CodeStudio)

Canonical reference for the agent's memory. Three **distinct** layers — keep them
separate. The redesign (migration 181) moved durable memory OFF the `snapshots`
table into a dedicated `agent_memory` store.

## Layers

| Layer | Purpose | Tools | Backend |
|---|---|---|---|
| **Session notes** | scratchpad for one session (survives compaction) | `save_note`, `list_notes` | `coder_session_memory` |
| **Agent Memory** | durable, single-fact, cross-session knowledge | `remember`, `recall_memory`, `forget_memory` | **`agent_memory`** (FTS5 + vectors) |
| **Snapshots** | curated/indexed context & review | `mcp__add_snapshot`, `get_snapshot`, … | `snapshots` |

`save_note` is **not** durable memory. Snapshots are **not** routine memory.

## Agent Memory model (migration 181)

One row = one durable fact, with a logical frontmatter:
`name` (kebab slug, identity) · `description` · `type` · `scope` · `created`.

- **Types (closed):** `preference | convention | procedure | architecture | gotcha | external_pointer | pattern | decision | note`.
- **Scopes:** `project` (this codebase) · `user` (global, every project, on reserved project 0) · `local` (machine-only, never syncs).
- **Logical immutability:** rows are never edited in place as the source of truth. A content change ARCHIVES the old row and CREATES a fresh one in one transaction (`superseded_by_id`), preserving the earliest `created_at`. The partial unique index `(scope, project_id, name) WHERE archived_at IS NULL` keeps one live row per identity while allowing archive + recreate.
- **Staleness:** `referenced_files` captures each path's `content_hash` at write time; recall flags a memory as stale when those files changed.

## Flow

**Read (per turn):** the runner proactively retrieves relevant project memory before assembling messages (turn 1 + on material task change), runs the conservative selector (≤5, "if unsure drop it", default-on — `CODER_MEMORY_LLM_FILTER=0` disables), and injects it as `<system-reminder>` background context. A titles-only index is injected on turn 1 / post-compaction. If the user says "ignore memory", recall **and** the index are skipped for that turn.

**Write:** the agent calls `remember` as it learns. End-of-run distillation and the idle sweeper also mint durable facts (decisions / gotchas / procedures / promoted session notes), deduped centrally.

**Maintenance (idle sweeper):** collapses exact-duplicate memories (logical archive) and prunes the telemetry events table. A one-shot embedding backfill at server boot gives migrated/legacy rows their vectors (FTS recall works immediately regardless).

## Recall ranking

Hybrid FTS + vector RRF candidates, re-scored by `relevance × (importance + recency + frequency-of-use) × staleness-discount`. The optional `minRelevance` floor (`CODER_MEMORY_MIN_RELEVANCE`) drops weak hits before the topK slice; broad `preference` memories must clear a stricter bar. The floor applies to the BLENDED score, never the raw RRF rank.

## Sync (entitlement-gated)

`agent_memory.sync` is the per-row push intent (default 1; `scope='local'` is forced to 0 by a trigger). The actual cloud push (`SyncKind: 'memory'`) is gated by the paid `features.sync` entitlement: **free = local-only**, **paid = optional** per scope/memory.

## Telemetry

`agent_memory_events` records `remember` / `recall` / `forget` (best-effort, pruned by the sweeper). `db.getAgentMemoryStats(projectId?)` returns live counts + event counts — use it to confirm memory left dormancy (saves > 0, recalls firing). End-of-run distillation also writes `memory_distill_log`.

## Migration

`scripts/migrate-snapshot-memory-to-agent-memory.ts` copies legacy snapshot-memory (`source ∈ {agent, session, compaction, distill}`, excluding `manual`/`index`) into `agent_memory`. Non-destructive (snapshots untouched), idempotent (by `source_snapshot_id`), `--dry-run` first. Run with the app closed (better-sqlite3 ABI).

## Code map

- Store: `packages/store/src/db/agent-memory.ts`, `agent-memory-consolidation.ts`, migration `181_agent_memory.ts`.
- Service: `packages/services/src/memory/agent-memory-service.ts` (embed + hybrid search), `agent-memory-retriever.ts`, `agent-memory-writer.ts`.
- Tools: `packages/code-agent/src/tools/project-memory-tools.ts` (remember/recall_memory/forget_memory), `session-drive-tools.ts` (save_note).
- Host wiring: `apps/http-api/server/deps.ts`; workers `sse/worker-memory-handlers.ts` + `workers/memory-shims.ts`; sweeper `sse/memory-sweeper.ts`.
- Prompt: `packages/code-agent/src/core/system-prompt.ts` (`memorySection`).
