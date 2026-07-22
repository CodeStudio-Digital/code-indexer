# 02 — Orchestrator, session loop and event stream

## Summary

ClaudeOpen's session loop is effective because model interaction, tool progress, hooks, compaction and terminal results are normalized as stream events. CodeStudio already has a behavior-tree runner and a robust SSE bus, but needs a durable event log and a clearer session control-plane contract so the dashboard can observe and replay what the backend actually does.

## ClaudeOpen observations

### Prompt submission hooks are first-class

ClaudeOpen processes user input with mode, history, context, permission callback, origin and query controls in claudeopen/claude-code-src/agent/loop.js:4260-4301.

Before the model query, UserPromptSubmit hooks are streamed and can block continuation, suppress the original prompt, change the title or append context in claudeopen/claude-code-src/agent/loop.js:4302-4344.

Lesson: hooks are not just plugin callbacks; some are lifecycle decisions with stream-visible effects.

### Async generator event pump

The engine is an async-generator event pump. It emits system/init, consumes queued turns, builds query parameters and emits structured setup errors in claudeopen/claude-code-src/agent/loop.js:4804-4863.

Input from SDK consumers is also an async iterable transformed into queued turn events in claudeopen/claude-code-src/agent/loop.js:5719-5734.

Lesson: the session loop owns an event queue and a stable output envelope, not just a while-loop around provider calls.

### Progress normalization

ClaudeOpen converts internal progress into public events:

- bash/powershell progress,
- nested REPL calls,
- tool heartbeat,
- subagent API retry.

Reference: claudeopen/claude-code-src/agent/loop.js:5195-5252.

Short source excerpt from claudeopen/claude-code-src/agent/loop.js:5195-5205:

~~~js
if (Ge.type === "progress" && (Ge.data.type === "bash_progress" || Ge.data.type === "powershell_progress")) {
  yield V({
    type: "tool_progress",
    tool_use_id: Ge.toolUseID,
    tool_name: Ge.data.type === "bash_progress" ? Oo : ki,
    parent_tool_use_id: Ge.parentToolUseID || null,
    elapsed_time_seconds: Ge.data.elapsedTimeSeconds,
    task_id: Ge.data.taskId
  });
}
~~~

### Terminal result envelope

Every turn finalizes with duration, API time, token/model usage, cost, permission denials, UUID, session ID, terminal reason and success/error subtype in claudeopen/claude-code-src/agent/loop.js:5260-5327.

Lesson: a good stream is not just tokens. It is a durable execution story.

## CodeStudio current state

### Runner entrypoint

runCoder is the shared CLI/SSE entry point and obtains process-shared CodeIndexDB and SessionStore handles in codestudio_mcp-codebase/packages/code-agent/src/index.ts:400-410.

### Behavior-tree runner

Execution is driven by a behavior-tree orchestrator with explicit nodes and nextState in codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:1-6 and codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:78-97.

The machine states cover bootstrap, planning, execution, compaction, review, recovery and completion in codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/types.ts:22-53.

The transition table is centralized in codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:21-57.

### Guards

The runner has dedicated guards for repeated tuple hashes, doom loops, dominance, failure streaks, no progress, max turns, read coverage, nested calls and task mode under codestudio_mcp-codebase/packages/code-agent/src/core/runner/guards/.

This is a strength. ClaudeOpen's design should not erase these guardrails.

### SSE and stream bus

The dashboard uses POST streaming because EventSource cannot send POST bodies, with per-session isolation in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:53-65.

The client tracks highest SSE sequence per session for Last-Event-ID reattachment in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:75-89.

Token updates are batched by animation frame with a 50ms fallback; terminal/provider events flush synchronously in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:159-190.

Electron bypasses the Vite proxy for SSE because the proxy swallowed flushes, and client_msg_id makes retries idempotent in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:204-225.

The shared SSE pump supports cursor replay, heartbeat, attach replay and completion callbacks in codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-27.

It serializes writes for backpressure, aborts on disconnect and emits bus_info first in codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:43-82.

**Transport-layer caveat (added this round):** the event *model* above is sound, but the SSE *transport* carries 14 verified weaknesses (missing `X-Accel-Buffering` on the chat route, replay/subscribe race, cursor advancing before handling, silent frame drops, no backend delta coalescing, among others). Five P0 items were fixed in this round. The full evidence list lives in `08-streaming-sse-deep-dive.md`; the hooks event catalog and decision-hook semantics mapped this round live in `05-policy-permissions-mcp-sandbox-hooks.md`, and the reactive+precomputed compaction findings live in `04-memory-context-compaction.md`.

## Gaps

### Gap 1 — event stream is not yet a durable event log

The SSE bus is good for live UI and reconnects, but the product needs an append-only runtime event log with sequence, sessionId, agentRunId, eventType, redacted payload and idempotency key.

Without this, dashboard replay, crash recovery, policy audit, hook audit and subagent ownership remain partial.

### Gap 2 — missing transitions can terminate silently

Any unmapped state/event pair defaults to Done in codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:60-65.

For a control-plane architecture, this should become explicit error/fail-closed behavior, at least in strict/shadow mode.

### Gap 3 — hooks are not unified lifecycle events

RuntimeHookRegistry covers tool calls, errors, provider fallback and completion in codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:17-64, with timeout-wrapped methods in codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:64-125.

Project hooks can alter system prompt or filter tools in codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:42-87.

These are useful but fragmented compared with a single event bus where observation hooks and decision hooks are typed and replayable.

## Preserve

- Keep the behavior-tree runner and its guard system.
- Keep the current SSE transport improvements: POST streaming, cursor replay, idempotency, heartbeat and backpressure.
- Keep provider/model telemetry already surfaced in the stream.

## Recommendation

Introduce a Durable Runtime Event Log beneath SSE and dashboard state.

Suggested event model:

~~~ts
type RuntimeEventType =
  | 'session.start'
  | 'session.end'
  | 'turn.before'
  | 'turn.after'
  | 'tool.before'
  | 'tool.after'
  | 'tool.failure'
  | 'permission.request'
  | 'permission.resolved'
  | 'agent.spawn'
  | 'agent.start'
  | 'agent.stop'
  | 'workspace.create'
  | 'workspace.remove'
  | 'compact.before'
  | 'compact.after'
  | 'message.display'
  | 'file.changed'
  | 'config.changed';

interface RuntimeEvent {
  seq: number;
  sessionId: number;
  agentRunId?: string;
  type: RuntimeEventType;
  idempotencyKey: string;
  payload: unknown;
  redactionVersion: number;
  createdAt: string;
}
~~~

SSE should become a projection of this log, not the only runtime state.

## Backlog

| Priority | Item | Notes |
|---|---|---|
| S | Add RuntimeEvent contract and append-only store | No behavior change. |
| S | Mirror current tool/provider/session stream events into log | Feature-flagged. |
| S | Add replay by cursor for dashboard attach | Reuse pumpBusToSSE cursor semantics. |
| A | Make missing runner transition emit event + fail strict mode | Start in shadow/diagnostic. |
| A | Unify hook surfaces over runtime events | Observation hooks first, decision hooks later. |
| B | Add deterministic session replay harness | Required before remote/session-resume work. |

## References

- claudeopen/claude-code-src/agent/loop.js:4260-4301
- claudeopen/claude-code-src/agent/loop.js:4302-4344
- claudeopen/claude-code-src/agent/loop.js:4804-4863
- claudeopen/claude-code-src/agent/loop.js:5195-5252
- claudeopen/claude-code-src/agent/loop.js:5260-5327
- claudeopen/claude-code-src/agent/loop.js:5719-5734
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:400-410
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:1-6
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:78-97
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/types.ts:22-53
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:21-65
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:53-89
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:159-225
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-82
