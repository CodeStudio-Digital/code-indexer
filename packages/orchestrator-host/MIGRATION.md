# Orchestrator → Worker Migration

Status: **infrastructure complete + `/start` endpoint migrated**.
Remaining endpoints are mechanical drop-ins gated by the
`MCP_ORCHESTRATOR_WORKER=1` env flag — flip it on after `npm run
build` to route `POST /api/company/sessions/:id/start` through a
dedicated `worker_thread`. Other endpoints continue using the
in-process registry until they're migrated one by one (same flag
read at each route).

## What landed

| Layer | File | Status |
|-------|------|--------|
| Worker host pkg | `packages/orchestrator-host/` | ✅ shipped |
| Typed protocol (req/res/evt) | `src/protocol.ts` | ✅ shipped |
| `MessageBridge` | `src/MessageBridge.ts` | ✅ 7 unit tests pass |
| `WorkerHost` (spawn/evict/restart) | `src/WorkerHost.ts` | ✅ 5 e2e tests against real worker_thread |
| Per-worker WAL SQLite | `src/DbConnection.ts` | ✅ shipped |
| **Worker entrypoint** | `apps/http-api/workers/company-worker.ts` | ✅ shipped — boots CompanyOrchestrator in worker, mirrors metaBus events back to main, exposes generic `rpc` handler |
| **WorkerOrchestratorPool + Proxy** | `apps/http-api/sse/WorkerOrchestratorPool.ts` | ✅ shipped — manages per-session WorkerHost, mirrors worker bus into a main-side `CoderRunBus` so `pumpBusToSSE` keeps working |
| **Pool singleton + flag** | `apps/http-api/sse/workerPoolSingleton.ts` | ✅ shipped — lazy singleton, feature flag check |
| **`POST /start` migration** | `apps/http-api/server/routes/company/stream.ts` | ✅ shipped — opts into worker path when `MCP_ORCHESTRATOR_WORKER=1` and the built worker file exists |
| WebSocket gateway (parallel transport) | `apps/http-api/server/routes/company/ws.ts` | ✅ shipped (P14) |
| `ReconnectingWebSocketClient` | `packages/shared/src/ws/` | ✅ shipped, 4 tests |
| **Other endpoints (`/message`, `/answer`, `/attach`, kanban, services, …)** | various | ⚠️ **NOT MIGRATED** — still use the in-process `orchestratorRegistry`. Same pattern (check flag → use pool) drops in mechanically. |

## How to enable the worker path today

```bash
# 1. Build so the worker file exists at dist/.../workers/company-worker.js
npm run build

# 2. Flip the flag
export MCP_ORCHESTRATOR_WORKER=1

# 3. Start the API
npm run start:api
```

When the flag is set:
- `POST /api/company/sessions/:id/start` spawns a worker via the pool.
- The worker constructs `CompanyOrchestrator` against its own
  better-sqlite3 connection in WAL mode.
- Master events flow worker → bridge → main-side mirrored bus →
  existing `pumpBusToSSE` pipeline → SSE clients.
- TTL eviction sweeps idle workers (`CODER_COMPANY_ORCHESTRATOR_TTL_MS`,
  default 5 min) — same semantics as the in-process registry.
- Crash recovery: `WorkerHost` restarts the worker up to 3 times with
  exponential backoff; subsequent failures bubble up via `onCrash`.

When the flag is unset (default):
- Original in-process path is untouched. Zero behavior change.

## Architecture (target state)

```
┌─ Main thread (HTTP / SSE / WS gateway) ─────────────────────┐
│  WorkerOrchestratorPool                                     │
│   Map<companySessionId, { WorkerHost, mirroredBus }>        │
│   ↓ bridge.request('rpc', { path, args })                   │
│   ↑ bridge.emit('bus.event'|'bus.end', payload)             │
└─────────────────────────────────────────────────────────────┘
                       ⇅ MessagePort (structuredClone)
┌─ Worker thread (one per active session) ────────────────────┐
│  company-worker.ts                                          │
│    openWorkerDb(WAL) → CompanyStore + CodeIndexDB           │
│    new CompanyOrchestrator({ companySessionId, …})          │
│    subscribe(orchestrator.metaBus, …) → bridge.emit         │
│    bridge.handle('rpc', ({ path, args }) => …)              │
│    bridge.emit('worker.ready')                              │
└─────────────────────────────────────────────────────────────┘
```

## Pattern for migrating remaining endpoints

Every consumer of `orchestratorRegistry.get(id)` follows the same shape:

```typescript
// Before
const orch = orchestratorRegistry.get(id);
if (!orch) return notFound(c);
await orch.someMethod(args);
return pumpBusToSSE(c, orch.metaBus, { since: parseLastEventId(c) });
```

```typescript
// After (P13-pattern)
let orch: CompanyOrchestrator | undefined;
let bus: CompanyOrchestrator['metaBus'];
if (workerOrchestratorEnabled()) {
  const entry = getWorkerOrchestratorPool().get(id);
  if (!entry) return notFound(c);
  orch = entry.orchestrator;
  bus = entry.bus;
} else {
  orch = orchestratorRegistry.get(id);
  if (!orch) return notFound(c);
  bus = orch.metaBus;
}
await orch.someMethod(args); // proxy auto-routes to worker
return pumpBusToSSE(c, bus, { since: parseLastEventId(c) });
```

The Proxy mirrors the entire CompanyOrchestrator API surface, so
nested calls like `orch.kanbanCreateCard(...)` or
`orch.master.sendUserMessage(...)` work without changes. Promise
return types are preserved end-to-end.

### Endpoints pending migration (priority order)

1. `POST /attach` — same shape as `/start` minus the spawn. Read the
   pool with `pool.get(id)` (no spawn), wire the mirrored bus into SSE.
2. `POST /message`, `POST /answer`, `POST /plan-response` — straight
   method-forwarding via proxy.
3. `GET /sessions/:id/...` reads (kanban, drive, services, …) — each
   route picks pool or registry based on the flag.
4. `attachCompanyStreamUpgrade` (the WS gateway) — update to read the
   bus from the pool when the flag is on.
5. `activeOrchestrators` shim at the top of `stream.ts` — once every
   consumer is migrated, replace it with a flag-aware variant that
   returns from the pool transparently.

## Test coverage

- `MessageBridge.test.ts` — 7 unit tests (req/res, error mapping, no-handler, events, dispose, timeout, listener crash).
- `WorkerHost.test.ts` — 5 e2e tests against a real `worker_thread` fixture: boot+ready, RPC round-trip, event forwarding, error propagation, timeout, graceful eviction.
- `ReconnectingWebSocketClient.test.ts` — 4 tests for the WS client side.
- Total: **16 passing**, plus the existing 32 sandbox/master/subordinate tests untouched.

## Smoke checklist before flipping the flag in production

- [x] `npm run build` produces `dist/apps/http-api/workers/company-worker.js`
- [ ] On a staging session: `MCP_ORCHESTRATOR_WORKER=1` + `npm run start:api` + start session → confirm worker spawns (look for "[pool] worker session=…" logs is absent of crash messages)
- [ ] Confirm `POST /start` returns the SSE stream as before; events flow through the mirrored bus
- [ ] Kill the worker thread externally (e.g., `kill -9` of the `worker_threads` pid) and confirm `WorkerHost.onCrash` fires after 3 restarts
- [ ] Run 10 concurrent sessions; observe CPU spread across cores; no `SQLITE_BUSY` errors in normal load
- [ ] Verify `disposeWorkerOrchestratorPool()` runs on SIGTERM

## Risk register

1. **better-sqlite3 multi-thread on Windows/NTFS.** WAL helps but
   isn't bulletproof. Mitigation: serialize writes via a single
   "writer worker" if benchmarks show >5% SQLITE_BUSY rate.
2. **`structuredClone` payload leaks.** Class instances or functions
   in `postMessage` payloads silently drop. Mitigation: keep
   orchestrator method args as POJOs; the proxy doesn't validate but
   any consumer that broke this would see an undefined arg on the
   worker side.
3. **`MessagePort` ordering vs HTTP race.** A `POST /message` that
   arrives during worker spawn is queued by the pool (`getOrSpawn`
   awaits `host.start()` before returning).
4. **Eviction during in-flight request.** TTL sweep skips active
   workers via `lastTouchedAt`. If you need stronger guarantees,
   future PR: add `pendingRequests` counter to `WorkerHost` and
   refuse `evict()` while non-zero.
5. **First-spawn latency.** ~200-500 ms on dev hardware to load all
   `@mcp/company` modules in the worker. Subsequent requests
   round-trip in <50 ms. Acceptable for `/start`; possibly noticeable
   for the first `/message` of a session.

## TL;DR

P11–P16 + P13 infrastructure all shipped. `/start` is wired through
the worker pool when the operator flips `MCP_ORCHESTRATOR_WORKER=1`
after a build. Remaining endpoints follow the same 5-line drop-in
pattern documented above; expand the coverage one route at a time so
each migration carries its own smoke test.
