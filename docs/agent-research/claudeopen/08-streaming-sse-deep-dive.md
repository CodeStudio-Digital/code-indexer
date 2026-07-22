# 08 — Streaming/SSE deep-dive (chat-session)

## Summary

The chat-session SSE **architecture** is sound: run/client decoupling, replay buffer, Last-Event-ID cursors, idempotent `client_msg_id`, heartbeat and backpressure all exist. The reason the stream *feels* bad in practice is a set of **14 concrete transport-level weaknesses**, five of which (P0) are fixed in this delivery round. The highest-impact culprits behind the user-visible "buffering" symptom are: the missing `X-Accel-Buffering: no` header on the chat route (W2), the Vite dev proxy swallowing flushes in browser dev (W1), no backend-side coalescing of per-token deltas (W3), and full replay on fresh attach by default (W7).

This document is the transport-layer companion to `02-orchestrator-session-loop.md` (event model) and `06-dashboard-session-control-plane.md` (UX control plane).

## End-to-end flow (verified)

```text
Provider (OpenAI/Anthropic/Gemini/…)
  └─ packages/provider-sdk/src/adapter.ts:74            ChatProvider.chat(req) -> AsyncIterable<ChatDelta>
     packages/provider-sdk/src/wire.ts:215-240          delta types (text_delta, tool_call_*, done, …)
     packages/provider-sdk/src/stream-resilience.ts:53-66   withStreamResilience: premature close after done only

Runner / code-agent
  └─ packages/code-agent/src/core/runner/nodes/executing-stream.ts:120-182
     consumeStream() accumulates deltas, calls onTextDelta/onThinkingDelta/onToolCallStart
  └─ packages/code-agent/src/core/runner/events.ts:15-64    runner event vocabulary
  └─ packages/code-agent/src/core/runner/nodes/executing-stream.ts:265-267
     image_generated is silently ignored (see W9)

Coder worker
  └─ apps/http-api/workers/coder-worker.ts:508-534      createActiveRun(): local bus + bridge.emit('bus.event')
  └─ apps/http-api/workers/coder-worker.ts:880-882      wireRunnerEventsToBus(runner, bus, { deferTerminalEvent: true })
  └─ apps/http-api/sse/runnerWiring.ts:21-190           maps every runner event -> bus publish

Main process (http-api)
  └─ apps/http-api/sse/CoderWorkerPool.ts:834-854       mirrors worker bus.event / bus.end onto the main CoderRunBus
  └─ apps/http-api/coder-bus.ts:175-211                 publish(): seq, ring buffer, subscribers, sinks
  └─ apps/http-api/sse/pumpBusToSSE.ts:46-107           streamSSE(): consumes bus, writes SSE frames
  └─ apps/http-api/sse/pumpBusToSSE.ts:122-127          parseLastEventId() (Last-Event-ID)
  └─ apps/http-api/sse/SSEHeartbeat.ts:19-26            ping every 20s

Chat routes
  └─ apps/http-api/server/routes/coder/stream.ts:417-430
     GET /api/coder/sessions/:id/attach -> pumpBusToSSE(c, bus, { since, trimReplay: true })
  └─ apps/http-api/server/routes/coder/stream.ts:498-771
     POST /api/coder/sessions/:id/messages -> fresh/attach/replay decision + pumpBusToSSE

Dashboard (React)
  └─ apps/dashboard/features/chat/AgentChat.tsx:370-399           consumes useAgentStream()
  └─ apps/dashboard/hooks/agent-stream/useAgentStream.ts:62-144   starts/manages streams per session
  └─ apps/dashboard/hooks/agent-stream/openStream.ts:118-190      opens connection, queue + rAF coalescing
  └─ apps/dashboard/hooks/agent-stream/openStream.ts:323-340      ReconnectingSSEClient wiring, drain
  └─ packages/shared/src/sse/ReconnectingSSEClient.ts:83-195      fetch + ReadableStream + backoff
  └─ packages/shared/src/sse/SSEFramer.ts:32-81                   SSE frame parser
  └─ apps/dashboard/hooks/agent-stream/handlers.ts:71-…           per-event-type handlers
```

## Strengths (keep)

1. **Run/client decoupling** — the worker keeps running when the dashboard disconnects; the main bus is mirrored and re-attachable via `GET /attach` (`coder-bus.ts:6-13`, `CoderWorkerPool.ts:834-854`).
2. **Bounded replay buffer** — `BUFFER_CAP=2000` and `BUFFER_BYTE_CAP=8MB` (`coder-bus.ts:67-73`).
3. **Cursor resume** — `Last-Event-ID` parsed and honored (`pumpBusToSSE.ts:122-127`, `ReconnectingSSEClient.ts:134-137`).
4. **Idempotent re-POST** — `client_msg_id` + `recentMessageKeys` dedupe retried messages on reconnect (`stream.ts:710-744`).
5. **Heartbeat** — `ping` every 20s (`SSEHeartbeat.ts:19-26`).
6. **Frontend batching** — event queue with `EVENT_BATCH_SIZE=50` + `yieldToEventLoop()` keeps render responsive (`openStream.ts:75-82`, `openStream.ts:302-321`).
7. **Visual token coalescing** — `requestAnimationFrame` batches `currentTurn` updates (`openStream.ts:159-172`).
8. **Provider premature-close resilience** — `withStreamResilience` swallows `ERR_STREAM_PREMATURE_CLOSE` *after* `done` (`stream-resilience.ts:53-66`).
9. **Worker crash → terminal event** — `onCrash` publishes `error` + `markEnded` (`CoderWorkerPool.ts:609-662`).
10. **Terminal deferred until persisted** — worker waits for `transcriptFlushed` before publishing `done` (`coder-worker.ts:887-908`).

## Weaknesses (verified, with evidence)

### W1 — Vite dev proxy can still swallow SSE flushes

`openStream.ts:204-211` documents that the Vite proxy was observed swallowing flushes even with `x-accel-buffering` disabled; the Electron workaround prefixes `apiBaseUrl()`, but **browser dev** still uses the relative URL through the proxy. `apps/dashboard/vite.config.ts:112-130` mitigates but the comment admits remaining failures.

- **Severity:** high in browser dev; none in Electron.
- **Symptom:** tokens arrive in bursts or only at the end.

### W2 — Chat route does not send `X-Accel-Buffering: no` ✅ fixed this round

`pumpBusToSSE.ts:46-107` uses `hono/streaming` without anti-buffer headers. Other SSE routes in the same codebase do set it: `apps/http-api/server/routes/docs-agent/index.ts:96`, `apps/http-api/server/routes/docs/index.ts:53`, `apps/http-api/server/routes/coder/pipelines.ts:397`. The chat route — the highest-traffic one — was the only one unprotected.

- **Severity:** high behind any buffering proxy (nginx/Cloudflare/dev proxy); invisible locally.
- **Fix:** B1 below.

### W3 — One SSE frame per token: no backend coalescing

`runnerWiring.ts:21-23` publishes a `text` event for **every** `text_delta`; `executing-stream.ts:177-182` calls `onTextDelta` per provider chunk; `pumpBusToSSE.ts:89-94` writes one frame per event. The only coalescing is frontend `rAF`, but each event still costs JSON.parse + handler + store update.

- **Severity:** medium-high (CPU, network chatter, battery on long generations).
- **Fix:** P1 — time-boxed (e.g. 30–50 ms) text-delta coalescing in `runnerWiring` or the bus, preserving ordering and flush on non-text events.

### W4 — Replay eviction is invisible to the client

`coder-bus.ts:187-203` evicts when `BUFFER_CAP`/`BUFFER_BYTE_CAP` is exceeded; `pumpBusToSSE.ts:82-85` reports `dropped_replay_events` in `bus_info`; but `openStream.ts:237-249` only extracts `bus_id` from `bus_info` and never reacts. The client can receive non-contiguous sequences and never know it lost deltas.

- **Severity:** medium (silent state corruption after long runs / slow reconnects).
- **Fix:** B4 below.

### W5 — Replay/subscribe race can drop live events ✅ fixed this round

`coder-bus.ts:285-297` (`subscribe`) and `coder-bus.ts:387-397` (`subscribeWithReplay`) replay the buffer first and **only then** add the subscriber to the `Set`. Events published during the replay loop are never delivered to the new subscriber.

- **Severity:** medium (rare, timing-dependent; worst exactly at attach time when the run is hot).
- **Fix:** B2 below.

### W6 — Unbounded server-side write chain under backpressure

`pumpBusToSSE.ts:55-61` enqueues every `stream.writeSSE()` into `drainChain`, but the producer (`publish` → `sub()`) is synchronous and never waits. A slow client/proxy grows the Promise chain without ceiling in server memory.

- **Severity:** medium (memory pressure under pathological clients).
- **Fix:** P1 — high-water mark: if `drainChain` depth exceeds N, coalesce pending `text` events into a single frame.

### W7 — Fresh attach replays everything by default

`coder-bus.ts:358-360`: `CODER_ATTACH_REPLAY_TRIM` defaults **OFF**. `stream.ts:427-429` passes `trimReplay: true`, but the env flag disables trimming. A fresh attach can resend up to 2000 events / 8MB at once; the frontend yields to stay responsive, but it is still a CPU/network spike.

- **Severity:** medium (first-open jank on long sessions).
- **Fix:** P2 — flip the default after measuring replay-trim correctness in production-like runs.

### W8 — Subscriber/sink errors and malformed frames are swallowed

`coder-bus.ts:204-209`: `try { sub(ev) } catch { /* ignore */ }` for subscribers and sinks. `SSEFramer.ts:30-31`: malformed blocks silently dropped. `openStream.ts:259-264`: failed `JSON.parse` returns silently. No log/telemetry for corruption-driven event loss.

- **Severity:** medium (debuggability; hides real bugs).
- **Fix:** B5 below (framer error surfacing); bus-side error telemetry is P1.

### W9 — `image_generated` is silently ignored

`executing-stream.ts:265-267`: `case 'image_generated'` with a "currently ignored" comment. Images from models supporting `image_generation` never reach the frontend.

- **Severity:** low-medium (feature gap, not corruption).
- **Fix:** P2 — route to an artifact/attachment event.

### W10 — `tool_call_args` (partial_json) is dropped

`executing-stream.ts:220-224` discards partial tool-call args; only `tool_call_end` is authoritative. If an adapter ever fails to emit `end`, the tool call vanishes; the UI also cannot show progressive arg streaming.

- **Severity:** low (contract requires `end`; fragility, not a current bug).
- **Fix:** P2 — accumulate partial args as a fallback and surface progressive display.

### W11 — Heartbeat ping does not reset the stall detector

`SSEHeartbeat.ts:19-26` emits `event: ping` every 20s; `ReconnectingSSEClient.ts:180` discards `ping` without `onEvent`; `openStream.ts:274-279` only updates `lastEventAt` on semantic events. A live but idle connection can still look "stalled" in UI.

- **Severity:** low-medium (false "travado" perception during long thinking/tool runs).
- **Fix:** P1 — treat `ping` as liveness (update `lastEventAt`, not the transcript).

### W12 — Provider stream resilience is too narrow

`stream-resilience.ts:53-66` only handles `ERR_STREAM_PREMATURE_CLOSE` **after** `done`. Real truncations before `done` and other stream errors propagate to the runner; if recovery fails, the turn aborts without retry.

- **Severity:** medium (turn loss on flaky networks/providers).
- **Fix:** P1 — classify retryable pre-done truncation; one bounded resume/retry at the provider adapter.

### W13 — `lastSeenSeq` advances before handling ✅ fixed this round

`openStream.ts:254-257` updates `lastSeenSeq` when the event **arrives**, before the handler runs. If the `AbortController` fires while the queue still holds "seen" events, they are discarded (`openStream.ts:310-314`) but the cursor never rolls back; the next reconnect never asks for them again.

- **Severity:** medium-high (permanent event loss on unmount/disconnect timing).
- **Fix:** B3 below.

### W14 — `SSEFramer` ignores `retry` and exposes no errors

`SSEFramer.ts:30-31, 75` ignore the SSE `retry:` field and drop invalid blocks silently. The backend cannot steer client reconnect interval, and parse failures are invisible.

- **Severity:** low (standards compliance, debuggability).
- **Fix:** B5 below (error surfacing); honoring `retry:` is P1.

## Fix backlog

### P0 — delivered in this round

| ID | Fix | Files |
|---|---|---|
| B1 | Send `X-Accel-Buffering: no` from the shared SSE pump (covers `/attach` + `/messages`) | `apps/http-api/sse/pumpBusToSSE.ts` |
| B2 | Register subscriber before replay; dedupe live events by `seq` | `apps/http-api/coder-bus.ts` |
| B3 | Advance `lastSeenSeq` only after the handler processed the event | `apps/dashboard/hooks/agent-stream/openStream.ts` |
| B4 | React to `bus_info.dropped_replay_events > 0` — worker-log `warn` on cursor-overlapping gaps, `info` on fresh attach; in-flight deltas reconcile at `message_complete` and completed turns via the persisted transcript | `apps/dashboard/hooks/agent-stream/openStream.ts` |
| B5 | Optional `onError` on `SSEFramer`; diagnostic wiring in `ReconnectingSSEClient` | `packages/shared/src/sse/SSEFramer.ts`, `ReconnectingSSEClient.ts` |

### P1 — next implementation round (needs own gate)

- Time-boxed backend coalescing of `text` deltas (W3) with a high-water mark on the write chain (W6).
- Treat `ping` as liveness in the stall detector (W11).
- Retryable pre-`done` truncation with one bounded resume (W12).
- Honor SSE `retry:` field; bus-side subscriber-error telemetry (W14, W8).

### P2 — later

- Flip `CODER_ATTACH_REPLAY_TRIM` default after production-like measurement (W7).
- Route `image_generated` to an artifact event (W9).
- Accumulate `tool_call_args` partials as fallback + progressive display (W10).

## Open questions

- Where is the pain felt — Electron (absolute URL), browser dev (Vite proxy), or production (which proxy)? W1 vs W2 weight depends on it.
- Is `CODER_ATTACH_REPLAY_TRIM` enabled in production? If not, W7 is critical on long sessions.
- Is there an nginx/Cloudflare layer between dashboard and http-api in production? If yes, W2 was very likely the main visible culprit.

## References

- codestudio_mcp-codebase/packages/provider-sdk/src/adapter.ts:74
- codestudio_mcp-codebase/packages/provider-sdk/src/wire.ts:215-240
- codestudio_mcp-codebase/packages/provider-sdk/src/stream-resilience.ts:53-66
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-stream.ts:120-182
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-stream.ts:220-224
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-stream.ts:265-267
- codestudio_mcp-codebase/apps/http-api/workers/coder-worker.ts:508-534
- codestudio_mcp-codebase/apps/http-api/workers/coder-worker.ts:880-908
- codestudio_mcp-codebase/apps/http-api/sse/runnerWiring.ts:21-190
- codestudio_mcp-codebase/apps/http-api/sse/CoderWorkerPool.ts:609-662
- codestudio_mcp-codebase/apps/http-api/sse/CoderWorkerPool.ts:834-854
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:6-13
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:67-73
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:175-211
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:285-297
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:358-397
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:46-107
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:122-127
- codestudio_mcp-codebase/apps/http-api/sse/SSEHeartbeat.ts:19-26
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:417-430
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:498-771
- codestudio_mcp-codebase/apps/http-api/server/routes/docs-agent/index.ts:96
- codestudio_mcp-codebase/apps/http-api/server/routes/docs/index.ts:53
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/pipelines.ts:397
- codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:370-399
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:62-144
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:75-82
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:159-190
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:204-264
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:274-340
- codestudio_mcp-codebase/apps/dashboard/vite.config.ts:112-130
- codestudio_mcp-codebase/packages/shared/src/sse/ReconnectingSSEClient.ts:83-195
- codestudio_mcp-codebase/packages/shared/src/sse/SSEFramer.ts:30-81
