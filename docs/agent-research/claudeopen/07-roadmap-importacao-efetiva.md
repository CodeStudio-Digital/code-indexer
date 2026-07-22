# 07 — Roadmap para importar efetividade do ClaudeOpen

## Summary

A decisão central é criar um plano de controle único para agentes, políticas, ambientes e sessões. Não devemos implementar tools, Ultra, memória, sandbox, hooks e dashboard como sete iniciativas independentes.

Este roadmap aproveita o plano-base fornecido pelo usuário e o ancora nas evidências dos documentos anteriores.

ClaudeOpen anchor excerpt from claudeopen/claude-code-src/agent/tools.js:17265-17283, showing why AgentRun needs durable async/remote states:

~~~js
status: S.literal("async_launched"),
agentId: S.string().describe("The ID of the async agent"),
outputFile: S.string().describe("Path to the output file for checking agent progress")
// ...
status: S.literal("remote_launched"),
taskId: S.string().describe("The ID of the remote agent task"),
sessionUrl: S.string().describe("The URL of the cloud session")
~~~

## Target architecture

~~~mermaid
flowchart TB
  UI[Dashboard / CLI / API] --> SC[Session Control Plane]
  SC --> PE[Policy Engine]
  SC --> EL[Lifecycle Event Bus]
  SC --> RS[Runtime Supervisor]
  SC --> EV[Durable Event Log]
  SC --> AR[Agent Registry]

  RS --> WL[Workspace Lease]
  WL --> H[Host readonly]
  WL --> W[Git worktree]
  WL --> C[Container / sandbox]
  WL --> R[Remote]

  PE --> SB[Network and Secret Broker]
  EL --> HK[Managed / Project / Plugin Hooks]
  AR --> WL
  EV --> UI
~~~

## Quick wins pré-Fase 0 (entregues nesta rodada)

Antes das fases estruturais, cinco correções P0 do transporte SSE do chat foram aplicadas e testadas — elas respondem diretamente à queixa de "streaming/SSE ruim" (evidência completa em `08-streaming-sse-deep-dive.md`):

| # | Fix | Arquivo | Fraqueza |
|---|---|---|---|
| B1 | Header `X-Accel-Buffering: no` no pump SSE compartilhado (cobre `/attach` + `/messages`) | `apps/http-api/sse/pumpBusToSSE.ts` | W2 |
| B2 | Subscriber registrado antes do replay + dedupe por `seq` | `apps/http-api/coder-bus.ts` | W5 |
| B3 | `lastSeenSeq` só avança após o handler processar o evento | `apps/dashboard/hooks/agent-stream/openStream.ts` | W13 |
| B4 | Reação a `bus_info.dropped_replay_events > 0` — worker-log `warn` quando o gap cobre o cursor, `info` em attach fresco; reconciliação via transcript persistido/`message_complete` | `apps/dashboard/hooks/agent-stream/openStream.ts` | W4 |
| B5 | `SSEFramer` com `onError` opcional + wiring de diagnóstico | `packages/shared/src/sse/SSEFramer.ts`, `ReconnectingSSEClient.ts` | W14/W8 |

Os itens P1/P2 (coalescência de deltas no backend, heartbeat como liveness, retry de truncamento pré-`done`, campo `retry:`, `image_generated`, args parciais, default do attach-trim) ficam para a rodada de implementação com gate próprio — mudam fluxo de eventos e exigem design.

Achados adicionais verificados nesta rodada e distribuídos nas fases abaixo:

- **Fase 1**: coalescência backend de `text` deltas (`runnerWiring.ts:21-23` publica 1 evento por token) e telemetria de erros de subscribers (`coder-bus.ts:204-209` engole exceções) passam a ser requisitos do event log.
- **Fase 4**: background jobs de subagentes vivem em singleton em memória (`subagent-jobs.ts:88-247`) — o AgentRun registry deve ser durável; `WORKFLOW_MAX_STEPS=12` (`workflow-types.ts:14`) precisa de orçamento de ondas, não parede fixa; enforce-writes só existe no profile `implement` (`micro-agent-profiles.ts:100-149`).
- **Fase 2 (Policy)**: fallback silencioso de tier para `bootstrap` em produção (`tiers.ts:573-574`) reforça que tier é visibilidade, nunca fronteira — o PolicyEngine é a fronteira real.
- **Fase 5 (Dashboard)**: painel de Tools deve absorver os modos de falha de tiers/prompts mapeados em `01-claudeopen-tools-runtime.md` (race do `expand_toolset`, cap 48, `toolCapBlock` pós-corte, `terseDescription` sem USE/DON'T).

## Phase 0 — Contracts and observability

### Objective

Create shared contracts with no behavior change.

### Contracts

- RuntimeEvent.
- ToolDescriptorV2.
- AgentRun.
- WorkspaceLease.
- PolicyDecision.
- RuntimeHook event context.

### Why first

ClaudeOpen's effective behavior comes from normalized tool/event/session contracts. CodeStudio has good pieces but they are distributed across registry, tiers, policy, runner, SSE, dashboard and memory.

### CodeStudio anchors

- runCoder entry: codestudio_mcp-codebase/packages/code-agent/src/index.ts:400-410.
- ToolRegistry: codestudio_mcp-codebase/packages/code-agent/src/core/registry.ts:10-48.
- BT state machine: codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/types.ts:22-53.
- SSE pump: codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-82.

### Gate

- Existing sessions behave identically.
- New contracts are feature-flagged or mirror-only.
- Events are redacted.
- Replay fixture can read a session log without executing tools.

## Phase 1 — Durable Event Log and Lifecycle Event Bus

### Objective

Make every meaningful runtime operation observable, replayable and auditable.

### Deliverables

- Append-only event log with seq, sessionId, agentRunId, type, redacted payload and idempotency key.
- SSE becomes a projection of event log where possible.
- Observation hooks subscribe to typed events.
- Decision hooks return allow/deny/ask/inputPatch but cannot bypass policy.

### ClaudeOpen evidence

- Async generator event pump: claudeopen/claude-code-src/agent/loop.js:4804-4863.
- Progress events: claudeopen/claude-code-src/agent/loop.js:5195-5252.
- Result envelope: claudeopen/claude-code-src/agent/loop.js:5260-5327.
- Compaction events: claudeopen/claude-code-src/agent/compaction.js:361-364.

### Gate

- Disconnect/reconnect does not lose event cursor.
- Tool start/result/failure events are ordered.
- Hook failures time out and are logged without freezing the runner.
- Redaction test suite covers secrets/env/tool inputs.

## Phase 2 — PolicyEngine shadow mode

### Objective

Evolve PermissionGate into a unified PolicyEngine without breaking current behavior.

### Deliverables

- Current ask/auto/unrestricted become presets.
- Rules by tool, capability, command, path, domain, operation, argument and workspace target.
- Precedence: organization → user → project → session → one-shot grant.
- deny always wins.
- Shadow decisions logged beside current PermissionGate decisions.

### CodeStudio anchors

- PermissionGate: codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:163.
- Current call classification: codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:199-270.
- Core policy: codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:426-490.
- Tiers not authorization: codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:346-351.

### Gate

- 100% of built-in, MCP, plugin, code_exec nested and subagent calls produce a PolicyDecision.
- Shadow mode reports mismatches without enforcement.
- Traversal, symlink, DB write, shell destructive command and hidden-tier tests exist.

## Phase 3 — WorkspaceLease and execution environment

### Objective

Make workspace target an authority, not an incidental cwd.

### Deliverables

- WorkspaceLease for host, worktree, container and remote targets.
- Tools and terminal share the same environment and cwd.
- Missing required sandbox fails closed.
- Host external roots evaluated through PolicyEngine.
- Network and secrets routed through broker/proxy for non-host targets.

### CodeStudio anchors

- Worktree creation: codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:21-60.
- enter/exit worktree as manual tools: codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:104-241.
- Sandbox adapter swap: codestudio_mcp-codebase/packages/code-agent/src/index.ts:1157-1163.
- Dangerous sandbox fallback warning: codestudio_mcp-codebase/packages/code-agent/src/index.ts:1164-1183.

### Gate

- Shell, Git, filesystem and terminal see the same workspace.
- Implement background agents never write to the checkout by accident.
- Missing sandbox binding fails closed when sandbox is required.
- Uncommitted user changes are never copied/discarded silently.

## Phase 4 — AgentRun registry and Ultra control plane

### Objective

Turn Ultra into a real durable multi-agent control plane.

### Deliverables

- AgentRun table/event projection.
- AgentRun states: creating, running, waiting, completed, failed, aborted, paused.
- Background spawn returns agent identity immediately when requested.
- Resume/attach/abort per AgentRun.
- Output artifacts for handoff instead of digest-only context.
- Default isolation by profile: readonly for explore/reviewer, worktree for mutating background agents.

### ClaudeOpen evidence

- Agent sync/async/remote result states: claudeopen/claude-code-src/agent/tools.js:17265-17283.
- Agent input supports model/background/isolation/cwd: claudeopen/claude-code-src/agent/tools.js:17314-17329.
- Registry and resume: claudeopen/claude-code-src/agent/loop.js:580-632.

### CodeStudio anchors

- spawn_agent limits and dispatch prep: codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:44-147.
- workflow waves: codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:104-189.
- Ultra mode: codestudio_mcp-codebase/packages/code-agent/src/index.ts:339-397.

### Gate

- Two implement agents cannot write to the same checkout unless explicitly configured.
- Restart can recover AgentRun status and workspace lease.
- Dashboard can attach to a running/background agent.
- Digest truncation is mitigated by artifact references.

## Phase 5 — Dashboard Session Control Plane

### Objective

Expose backend capabilities in one coherent session view.

### Deliverables

- Overview tab: stream, model/provider, mode, event cursor, usage.
- Agents tab: AgentRun, lease, branch, diff, artifacts, actions.
- Tasks tab: deps, owners, files, blockers, status.
- Workspace tab: target, cwd, branch, sandbox/container/remote.
- Policy tab: active grants, last decisions, denied calls.
- Tools tab: source, tier, capability, enabled/hidden/allowed.
- Memory tab: recalls, saves, compaction, handoff.
- Events tab: filtered event log.

### CodeStudio anchors

- Current right rail: codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21.
- Session State props: codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/RightPanelHost.tsx:101-118.
- Subagents read-only panel: codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:19-50.
- Tool config/tier UI: codestudio_mcp-codebase/apps/dashboard/features/chat/ToolConfigDialog.tsx:54-172.
- Composer mode controls: codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:73-145.

### Gate

- User can answer: where is the session running, which policy allowed a tool, which agent owns a diff, what memory was recalled and how to resume/abort.
- Stream reconnect state is visible and actionable.
- Subagent control is not transcript-only.

## Phase 6 — Hooks, plugins and enterprise controls

### Objective

Make hooks and plugins powerful without making them privileged bypasses.

### Deliverables

- Observation hooks for telemetry/logging/notifications.
- Decision hooks for allow/deny/ask/inputPatch with schema validation.
- Plugin capability declaration before install.
- Enterprise policies for allowed/blocked/required plugins and MCP servers.
- Audit export for grants/hooks/tools/environments.

### CodeStudio anchors

- Project hooks: codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:42-87.
- RuntimeHookRegistry: codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:17-125.
- Existing plugin docs: codestudio_mcp-codebase/docs/PLUGINS.md:1.

### Gate

- Hook invalid inputPatch is rejected before dispatch.
- Hooks cannot bypass PolicyEngine.
- Plugin cannot register undeclared privileged capability.
- Hook failure cannot freeze runner.

## Phase 7 — Runtime supervisor and remote sessions

### Objective

Move sensitive/unstable boundaries into supervised processes and make local/remote sessions share a contract.

### Deliverables

- Process supervisor for backend runtime, PTY host, plugin host, provider host and native services.
- Worker threads remain for pure computation such as LSP/indexing where appropriate.
- Session API: start, attach, resume, fork, background, handoff, stop.
- Short-lived attach tokens.
- Remote driver begins with existing sandbox/E2B-style driver, later SSH/cloud.

### Gate

- Killing worker/backend/connection does not lose persisted turn.
- Resume does not duplicate tool calls/messages.
- Remote runtime never receives durable provider credentials.
- Crash-loop protection and backoff exist.

## Phase 8 — Cowork/computer use

### Objective

Only after policy, leases, event log and supervisor are stable, add desktop/computer-use safely.

### Deliverables

- Host-owned broker for screenshot, click, type and application control.
- Separate grants for view, click, full control, clipboard, system keys, credentials.
- App allowlist and foreground confirmation.
- VM/desktop isolation where possible.

### Gate

- App without grant cannot be controlled.
- Clipboard is not implicit.
- Window change invalidates action batch.
- Red-team tests for password managers, prompt spoofing and visual exfiltration.

## First four concrete deliverables

1. Shared contracts and append-only event log in mirror mode.
2. PolicyEngine in shadow mode wrapping PermissionGate.
3. WorkspaceLease for host and worktree.
4. Dashboard showing target, cwd, branch, owner, policy and event cursor.

These four deliverables remove the biggest visible incoherence: backend capabilities exist, but the user cannot inspect or control them as one runtime.

## Final goals

- Every action passes through explainable policy.
- Every mutating agent works in isolated workspace by default.
- No durable secret enters executable environments.
- Every session can resume after failure.
- Plugin, PTY or provider crashes do not take down the app.
- Worktree, sandbox, remote and host are just execution targets of the same runtime contract.

## Implementation caution

Do not begin with cowork/computer-use, plugin privileges or broad sandbox lockdown. Start with contracts, event log, shadow policy and leases. The existing sandbox profile has compatibility concerns with npm/cache/preparation, and flipping all restrictions at once would create false regressions instead of a safer agent platform.
