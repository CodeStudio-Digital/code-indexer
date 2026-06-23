# Spec 001 — Background Worker Registry

**Effort:** M (3-5 days) · **ROI:** High · **Status:** Proposed
**Inspiration:** [ruflo-loop-workers](https://github.com/ruvnet/ruflo/blob/main/plugins/ruflo-loop-workers/README.md)

---

## Problem

D:\MCP currently has **one** scheduled task ([`packages/indexer/src/indexer/providers/scheduled-refresh.ts`](../../../packages/indexer/src/indexer/providers/scheduled-refresh.ts) — a 24h provider-model refresh). Everything else is request-driven: the user types a message, the coder agent runs, then the system idles.

This means D:\MCP misses:
- Drift detection (docs out-of-sync with code, tests with missing coverage, security issues since last audit)
- Background warm-ups (preload symbol hierarchy, prefetch likely-needed files)
- Periodic learning (consolidate memory namespaces, retrain ranking)
- Long-running investigations the user could trigger and forget

ruflo's pattern: a `WorkerRegistry` exposing N named triggers (`audit`, `testgaps`, `document`, ...) dispatched via MCP tools (`worker_dispatch --trigger X`) and optionally cron-scheduled.

---

## Solution

Add a `WorkerRegistry` package + MCP tool surface + dashboard panel that:

1. Lists 8-10 named workers (subset of ruflo's 12, mapped to D:\MCP's existing capabilities).
2. Lets the user (or a cron job, or the coder agent) dispatch a worker by name with optional `--scope` (project, file, etc.).
3. Tracks dispatch history (timestamps, durations, verdicts) in `worker_history` table.
4. Auto-detects which workers should fire based on recent activity (`worker_detect`).

### Initial worker set (8)

| Trigger | Implementation | Schedule |
|---|---|---|
| `index_refresh` | Re-index changed files since last run via `packages/indexer/` | `*/15 * * * *` |
| `audit` | Run security/policy scan via existing `packages/services/` policy engine | `*/30 * * * *` |
| `testgaps` | Find files with low coverage + propose tests via coder agent | `0 */2 * * *` |
| `document` | Detect docs drift (jsdoc vs code), regenerate via docs-agent | `0 */4 * * *` |
| `consolidate` | LSH consolidation: rebuild stale buckets, dedupe snapshots | `0 0 * * *` |
| `optimize` | Cost-tracker analysis: flag expensive sessions, suggest tier downgrades | `0 0 * * *` |
| `preload` | Warm symbol hierarchy + embeddings for active project | event (project open) |
| `deepdive` | On-demand multi-source investigation (sub-agent fan-out) | manual only |

---

## Files to touch / create

**New package:** `packages/workers/`
- `packages/workers/src/registry/WorkerRegistry.ts` — registry of `{ trigger, name, description, handler, defaultCron, scopeSchema }`
- `packages/workers/src/registry/WorkerDispatcher.ts` — `dispatch(trigger, scope)`, `cancel(runId)`, `status(runId)`, `list()`
- `packages/workers/src/registry/WorkerHistory.ts` — persists to `worker_history` table
- `packages/workers/src/workers/{indexRefresh,audit,testGaps,document,consolidate,optimize,preload,deepdive}.ts` — one file per worker
- `packages/workers/src/cron/CronScheduler.ts` — wrapper over `node-cron` (or roll own setInterval-based for portability)

**Reuse:** `apps/http-api/sse/CoderWorkerPool.ts` for the actual worker-thread spawning (do not duplicate)

**Modify:**
- [`packages/store/src/migrations/`](../../../packages/store/src/migrations/) — new migration `096_worker_history.ts` (see schema below)
- [`apps/http-api/server/routes/`](../../../apps/http-api/server/routes/) — add `routes/workers/` with REST endpoints + SSE for live status
- [`apps/mcp-server/src/`](../../../apps/mcp-server/) — register 5 new MCP tools: `worker_list`, `worker_dispatch`, `worker_status`, `worker_detect`, `worker_cancel`
- [`apps/dashboard/features/`](../../../apps/dashboard/features/) — new `workers/` feature with WorkerPanel showing live + history
- [`packages/code-agent/src/skills/`](../../../packages/code-agent/src/skills/) — new `worker-dispatch.md` skill teaching the coder agent when to invoke workers

---

## Schema

Migration `095_worker_history.ts`:

```sql
CREATE TABLE worker_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger       TEXT NOT NULL,                  -- e.g. 'audit', 'testgaps'
  scope         TEXT,                           -- JSON: { project_id, file, query }
  dispatched_at INTEGER NOT NULL,               -- unix ms
  started_at    INTEGER,                        -- unix ms (null until pool picks it up)
  finished_at   INTEGER,                        -- unix ms (null until done)
  status        TEXT NOT NULL,                  -- 'pending' | 'running' | 'success' | 'failure' | 'cancelled'
  duration_ms   INTEGER,                        -- finished_at - started_at
  result_summary TEXT,                          -- short text or JSON
  error         TEXT,                           -- non-null on failure
  source        TEXT NOT NULL DEFAULT 'manual'  -- 'manual' | 'cron' | 'agent' | 'event'
);

CREATE INDEX idx_worker_history_trigger ON worker_history(trigger, dispatched_at DESC);
CREATE INDEX idx_worker_history_status  ON worker_history(status) WHERE status IN ('pending','running');
```

---

## MCP tool surface

```typescript
// apps/mcp-server/src/tools/workers.ts
{
  name: "worker_list",
  description: "List available workers and their default schedules",
  input: z.object({}),
  output: WorkerInfo[]
}

{
  name: "worker_dispatch",
  description: "Dispatch a worker run. Returns runId.",
  input: z.object({
    trigger: z.enum(["index_refresh","audit","testgaps","document","consolidate","optimize","preload","deepdive"]),
    scope: z.record(z.any()).optional()
  }),
  output: { runId: string, dispatchedAt: number }
}

{
  name: "worker_status",
  description: "Get status of a worker run by runId",
  input: z.object({ runId: z.string() }),
  output: WorkerRunStatus
}

{
  name: "worker_detect",
  description: "Suggest which workers should fire given current project context",
  input: z.object({ projectId: z.string() }),
  output: { suggested: string[], reasons: Record<string, string> }
}

{
  name: "worker_cancel",
  description: "Cancel a pending or running worker",
  input: z.object({ runId: z.string() }),
  output: { cancelled: boolean }
}
```

---

## 270s heartbeat pattern (for `/loop`-style workers)

For workers triggered via Claude Code's `/loop`, use `ScheduleWakeup({ delaySeconds: 270, ... })` — under the 5-min prompt-cache TTL. This is documented in ruflo's [autopilot ADR-0001](https://github.com/ruvnet/ruflo/blob/main/plugins/ruflo-autopilot/docs/adrs/0001-autopilot-contract.md). Add this guidance to the new `worker-dispatch.md` skill.

---

## Tasks

| # | Task | Est |
|---|---|---|
| T1 | Migration `095_worker_history.ts` + verify with existing migration runner | 2h |
| T2 | `packages/workers/` skeleton (`WorkerRegistry`, `WorkerDispatcher`, `WorkerHistory`) | 6h |
| T3 | `CronScheduler` wrapper (start/stop/list, persistent across restarts via re-reading registry) | 4h |
| T4 | Implement 4 workers first: `index_refresh`, `audit`, `testgaps`, `consolidate` (reuse existing services) | 1d |
| T5 | Implement remaining 4: `document`, `optimize`, `preload`, `deepdive` | 1d |
| T6 | HTTP API routes (`apps/http-api/server/routes/workers/`) + SSE live updates | 4h |
| T7 | MCP tools registration (`apps/mcp-server/src/tools/workers.ts`) | 3h |
| T8 | Dashboard panel (`apps/dashboard/features/workers/`) — list, dispatch button, history, live runs | 1d |
| T9 | Skill `worker-dispatch.md` (when to invoke each worker) | 1h |
| T10 | Vitest coverage: registry + dispatcher + history + 2 representative workers | 4h |
| T11 | E2E test: dispatch via MCP → verify worker history row + dashboard live update | 3h |

**Total:** ~5 days

---

## Test plan

1. **Unit**: `WorkerRegistry.register/list/get` + `WorkerDispatcher.dispatch/cancel/status` with mocked CoderWorkerPool.
2. **Integration**:
   - Dispatch `audit` worker via MCP → assert `worker_history` row in 'success' state within 30s.
   - Cancel a running `deepdive` worker → assert status='cancelled', finished_at set.
   - Cron-fire `index_refresh` after `*/15` → assert single run, no overlap if previous still running.
3. **E2E (dashboard)**:
   - Open `WorkerPanel`, click "Dispatch audit" → see live status, then 'success' verdict.
   - Open project → verify `preload` fires automatically (event-triggered).
4. **Regression**:
   - Existing `scheduled-refresh.ts` provider refresh keeps working (registered as the `index_refresh` worker, not duplicated).
   - No new permission prompts triggered on existing flows.
5. **Smoke (à la ruflo `scripts/smoke.sh`)**:
   - `node packages/workers/scripts/smoke.mjs` exits 0 if all 8 workers list, dispatch returns runId, status reaches a terminal state within timeout.

---

## Out of scope (defer)

- Distributed cron across machines — out of scope; cron lives in-process for now.
- ML-driven worker selection — `worker_detect` uses heuristics (file change count, time since last audit, etc.), not learned policy.
- IPFS cross-project pattern transfer — separate spec if needed.

---

## Open questions

1. Should `optimize` run automatically or stay manual? (User cost surprise risk.)
2. `deepdive` invokes the coder agent — does it count against user's session budget? Likely yes.
3. Does `preload` need a kill switch for low-end machines? Probably; expose via env var.

Resolve in design review before T2.
