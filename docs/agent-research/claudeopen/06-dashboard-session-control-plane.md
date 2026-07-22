# 06 — Dashboard and session control plane

## Summary

CodeStudio's dashboard streaming **architecture** is stronger than the user's symptom suggests — run/client decoupling, replay cursors, idempotency, heartbeat and backpressure all exist. However, a transport-layer audit this round verified **14 concrete SSE weaknesses** that do explain the "streaming feels bad" symptom in dev/proxy environments (missing `X-Accel-Buffering` on the chat route, replay/subscribe race, cursor advancing before handling, silent drops, per-token frames). Five P0 fixes shipped in this round; the full evidence lives in `08-streaming-sse-deep-dive.md`.

The deeper product weakness remains: session, tools, tiers, permissions, memory, subagents, runtime environment and task state are not presented as one control plane. ClaudeOpen's lesson is that the UI should reflect the agent runtime as structured events and controllable entities.

ClaudeOpen anchor excerpt from claudeopen/claude-code-src/agent/loop.js:5282-5320:

~~~js
let Bn = {
  duration_ms: Date.now() - Ce,
  duration_api_ms: u1(),
  num_turns: Pt,
  stop_reason: Ft,
  total_cost_usd: Bv(),
  usage: UXs(),
  modelUsage: sM(),
  permission_denials: at,
  session_id: W,
  terminal_reason: Sr
};
~~~

## Current streaming strengths

### POST stream

Chat messages stream through POST /api/coder/sessions/:id/messages using fetch plus a ReadableStream parser because EventSource cannot send POST bodies. Streaming state is isolated by session ID in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:53-65.

### Reattach cursor

The client tracks the highest SSE sequence per session for Last-Event-ID reattachment. Unmounting closes the client stream but not the server run, and a new mount reconnects in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:75-89.

### Token batching

Token updates are batched to animation frames with a 50ms fallback, and terminal/provider events force synchronous flushes in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:159-190.

### Electron proxy bypass and idempotency

Electron bypasses the Vite proxy with an absolute Hono URL because the proxy swallowed SSE flushes; POSTs receive stable client_msg_id values so retries replay instead of duplicating side effects in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:204-225.

### Ordered processing

Events are processed strictly in arrival order. bus_info identifies bus instances, sequence cursors reset when bus changes and malformed JSON is ignored with diagnostics in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:227-268.

### SSE pump

The coder stream route uses pumpBusToSSE and parses Last-Event-ID in codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:17.

pumpBusToSSE supports cursor replay, heartbeat, attach replay and completion callbacks in codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-27.

It serializes writes for backpressure, aborts on disconnect and emits a non-buffered bus_info preamble in codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:43-82.

## Current dashboard surfaces

### Live state

Per-session live state includes streaming status, current turn, terminal/error state, usage, reattachment state, todos, context/index health, pending interaction and pipeline runtime in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/types.ts:524-552.

It also tracks active runtime processes and refresh counters for sidebar state, persisted task lists and live snapshot changes in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/types.ts:553-578.

Pending approvals and lastEventAt are mirrored at session level in codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/types.ts:580-592.

### Right rail destinations

Coder-session tool windows include Session State, Drive, Chapters, Configuration, Subagents, Insights, Plans, Diagram, Notifications and Worker Log in codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21.

Session State receives todos, pipeline runtime, active processes, project files and skills in codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/RightPanelHost.tsx:101-118.

### Subagents panel

The Subagents panel is read-only and combines live agent groups with persisted spawn-call groups in codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:19-27.

It separates active/recent groups and selects a running agent by default in codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:29-50.

Per-subagent abort is wired elsewhere in chat rows, not in the dedicated panel, around codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:1346.

### Tool and tier configuration

ToolConfigDialog and ToolConfigView share controls for session tool configuration in codestudio_mcp-codebase/apps/dashboard/features/chat/ToolConfigDialog.tsx:99-172.

Tool config uses tiers mainly as labels/grouping and enable switches; it does not show current unlocked-tier status or explicit escalation path in codestudio_mcp-codebase/apps/dashboard/features/chat/ToolConfigDialog.tsx:54-90.

### Permission and reasoning controls

Permission mode is changed by cycling a composer icon, with only a short pulse for mid-run confirmation in codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:73-81.

Pipeline selection and extended reasoning are composer controls; Ultra-managed reasoning disables manual Think while preserving Standard preference in codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:116-145.

Session launch resolves provider, model, agent, reasoning effort, execution mode, thinking and max turns in codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:589-607.

### Generic streaming gap

Generic apiStream supports Electron MessagePort, but the browser SSE fallback is explicitly not wired yet in codestudio_mcp-codebase/apps/dashboard/lib/api-client.ts:729-745.

## Gaps

### Gap 1 — control plane is scattered

Runtime controls are spread across composer, Configuration panel, Session State, Insights, transcript cards and global memory surfaces. This makes powerful backend features feel less coherent.

### Gap 2 — subagent control is split

The dedicated Subagents panel is read-only, while abort/control is elsewhere. Users need one operational view for agent status, workspace, branch, diff, output artifacts, logs, blockers and actions.

### Gap 3 — memory is absent from coder-session rail

Memory affects behavior but is not a first-class session panel. Users should see what was recalled, saved and harvested.

### Gap 4 — tiers are displayed as toggles, not policy explanation

Users need to understand:

- visible vs hidden,
- enabled vs disabled,
- allowed vs denied,
- tier unlocked vs locked,
- policy rule responsible.

### Gap 5 — tasks are not a dedicated operational surface

Tasks are nested under Session State and transcript interactions. For Ultra/multi-agent work, tasks need a first-class panel with dependencies, owners, status, files, artifacts and blockers.

## Recommendation

Create a Session Control Plane panel group backed by the Durable Runtime Event Log.

Suggested tabs:

| Tab | Shows | Actions |
|---|---|---|
| Overview | current mode, provider/model, stream status, token usage, event cursor | reconnect, stop, export log |
| Agents | AgentRun rows, status, model, prompt hash, workspace lease, output artifacts | abort, attach, resume, inspect, integrate diff |
| Tasks | approved tasks, deps, owner agent, files, blockers | execute next, cancel, mark blocked |
| Workspace | target, cwd, branch, baseSha, sandbox/container/remote | open diff, integrate, discard with confirmation |
| Policy | permission mode, active grants, last decisions, denied calls | revoke grant, inspect rule |
| Tools | source, tier, capability, enabled/hidden/allowed state | enable/disable visibility, request unlock |
| Memory | recalls, saves, compaction, handoff, stale warnings | forget, correct, pin |
| Events | append-only event log with filters | replay from cursor, export |

This should not replace the transcript. It should make the hidden runtime state inspectable.

## Backlog

| Priority | Item | Notes |
|---|---|---|
| S | Add session rail Memory tab | Uses existing memory APIs/events. |
| S | Move subagent abort/inspect actions into Subagents panel | Keep transcript controls as shortcuts. |
| S | Add Runtime/Policy summary card | Mode, tool policy, grants, active tiers. |
| A | Add task rail destination | Dependencies, owners, files and status. |
| A | Display workspace lease/branch/cwd | Requires WorkspaceLease contract. |
| A | Add event-log viewer | Requires Durable Runtime Event Log. |
| B | Wire generic browser apiStream fallback | Improves non-Electron parity. |

## References

- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:53-89
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:159-268
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:17
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-82
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/types.ts:524-592
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/RightPanelHost.tsx:101-118
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:19-50
- codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:589-607
- codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:1346
- codestudio_mcp-codebase/apps/dashboard/features/chat/ToolConfigDialog.tsx:54-172
- codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:73-145
- codestudio_mcp-codebase/apps/dashboard/lib/api-client.ts:729-745
