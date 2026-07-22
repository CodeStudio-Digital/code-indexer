# ClaudeOpen research references

This file consolidates the code references used across the ClaudeOpen → CodeStudio analysis package.

## Existing CodeStudio research docs

- codestudio_mcp-codebase/docs/research/codex-gap-analysis.md:1-12 — existing gap-analysis structure and scope style.
- codestudio_mcp-codebase/docs/research/codex-gap-analysis.md:27-77 — inventory/recommendation/status table style and CodeStudio strengths list.
- codestudio_mcp-codebase/docs/agent-research/TOOLS_INVENTORY.md:1-15 — existing cross-agent tool inventory.
- codestudio_mcp-codebase/docs/bt-runner-refactor.md:167-185 — spawn_agent consolidation and known tier/workflow issues.

## ClaudeOpen project shape

- claudeopen/claude-code-src/README.md:1-18 — CLI bundle shape and agent domains.
- claudeopen/asar-src/README.md:1-27 — Desktop package domains including sessions, MCP, workers, plugins, VM/computer-use and skills.
- claudeopen/claude-code-src/cli/runtime.js:399-475 — CLI dispatcher and dedicated MCP/native-host/computer-use modes.

## ClaudeOpen tools/runtime

- claudeopen/claude-code-src/agent/prompts.js:5995 — built-in tool set names.
- claudeopen/claude-code-src/agent/tools.js:4385-4418 — Read tool descriptor example.
- claudeopen/claude-code-src/vendor/misc.js:83272-83278 — canonical Agent/Task and Grep names.
- claudeopen/claude-code-src/agent/tools.js:17285-17323 — descriptor contract with prompt, schemas, max result size and async call.
- claudeopen/claude-code-src/agent/tools.js:17301-17312 — Agent descriptor canonical name and alias.
- claudeopen/claude-code-src/agent/loop.js:709-738 — runtime tool filtering/composition with MCP tools.

## ClaudeOpen orchestrator/session loop

- claudeopen/claude-code-src/agent/loop.js:4260-4301 — user input processing with mode/history/context/permission controls.
- claudeopen/claude-code-src/agent/loop.js:4302-4344 — UserPromptSubmit hooks that can block/suppress/append context.
- claudeopen/claude-code-src/agent/loop.js:4804-4863 — async-generator event pump and setup errors.
- claudeopen/claude-code-src/agent/loop.js:5195-5252 — normalized public progress events.
- claudeopen/claude-code-src/agent/loop.js:5260-5327 — structured result envelope.
- claudeopen/claude-code-src/agent/loop.js:5719-5734 — SDK async iterable input to queued turn events.

## ClaudeOpen agents/subagents

- claudeopen/claude-code-src/agent/tools.js:17265-17283 — synchronous, async and remote Agent results.
- claudeopen/claude-code-src/agent/tools.js:17314-17329 — Agent call arguments including model/background/isolation/cwd.
- claudeopen/claude-code-src/agent/loop.js:580-632 — task registry, duplicate resume guard and restore.
- claudeopen/claude-code-src/agent/teams.js:45-76 — team identity/context.
- claudeopen/claude-code-src/agent/teams.js:135-153 — teammate detection/lead behavior.
- claudeopen/claude-code-src/agent/teams.js:3560-3605 — self-contained subagent prompt requirement.
- claudeopen/claude-code-src/agent/teams.js:3611-3618 — available agent types injected through reminders.

## ClaudeOpen memory/compaction

- claudeopen/claude-code-src/agent/tools.js:262-283 — continuation/handoff summary prompt.
- claudeopen/claude-code-src/agent/compaction.js:361-364 — compaction_delta normalized into compaction event.
- claudeopen/claude-code-src/agent/compaction.js:638-643 — server-side compaction direction and legacy deprecation.
- claudeopen/claude-code-src/agent/memory.js:3677-3683 — memory functionality in tool abstraction.

## ClaudeOpen permissions/MCP/sandbox layers

- claudeopen/claude-code-src/agent/permissions.js:790-805 — modes and decision reasons.
- claudeopen/claude-code-src/agent/permissions.js:832-844 — downgrade prevention `Dqt` (auto → acceptEdits exception).
- claudeopen/claude-code-src/agent/permissions.js:863-873 — mode-to-decision mapping.
- claudeopen/claude-code-src/agent/permissions.js:894-926 — privilege ordering and user-facing metadata.
- claudeopen/claude-code-src/agent/permissions.js:1032-1106 — MCP server policy parsed/merged into allow/deny/ask rule maps.
- claudeopen/claude-code-src/agent/tools.js:44964-45015 — auto-mode classifier prompt (allow/softDeny/hardDeny/environment/settingsDenyBlock).
- claudeopen/claude-code-src/agent/tools.js:71555-71596 — final `can_use_tool` approval flow.
- claudeopen/claude-code-src/agent/loop.js:1184-1205 — permission mode layer, tool restrictions and allowed agent types.
- claudeopen/claude-code-src/agent/loop.js:1212-1222 — permission and hook gates before execution.
- claudeopen/claude-code-src/agent/mcp.js:103-117 — MCP allow-rule literal prefix vs deny/ask wildcards.
- claudeopen/claude-code-src/agent/mcp.js:4846-5185 — MCP discovery/config policy filtering and allow/deny.
- claudeopen/claude-code-src/agent/hooks.js:1-2 — 30-event hook lifecycle catalog.
- claudeopen/claude-code-src/agent/hooks.js:194-199 — PreToolUse permissionDecision + updatedInput.
- claudeopen/claude-code-src/agent/hooks.js:221-224 — PostToolUse updatedToolOutput + preventContinuation.
- claudeopen/claude-code-src/agent/hooks.js:3949-4090 — layered hook sources and per-event matching.
- claudeopen/claude-code-src/agent/hooks.js:4197-4315 — timeout-wrapped hook execution.

## ClaudeOpen memory/compaction (this round)

- claudeopen/claude-code-src/agent/memory.js:120-158 — org memory discovery via `/v1/code/local/memory/mounts`.
- claudeopen/claude-code-src/agent/memory.js:183-205 — team-scope read-only org mounts.
- claudeopen/claude-code-src/agent/memory.js:400-408 — semantic memory types (user/feedback/project/reference).
- claudeopen/claude-code-src/agent/memory.js:3169-3170 — override clause header for injected instructions.
- claudeopen/claude-code-src/agent/memory.js:3246-3350 — Managed→User→Project→Local→AutoMem hierarchy loader.
- claudeopen/claude-code-src/agent/compaction.js:27052 — compaction thrashing detection.
- claudeopen/claude-code-src/agent/compaction.js:27451-27486 — text-only summarization prompts.
- claudeopen/claude-code-src/agent/compaction.js:27687-27724 — single-turn, skip transcript/cache compaction call.
- claudeopen/claude-code-src/agent/compaction.js:28337-28441 — reactive vs precomputed compaction arming.
- claudeopen/claude-code-src/agent/compaction.js:29230-29334 — threshold-triggered reactive compact / precomputed reuse.


## CodeStudio runner/orchestrator

- codestudio_mcp-codebase/packages/code-agent/src/index.ts:339-397 — Ultra execution policy resolution.
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:400-410 — runCoder entry and shared DB/store handles.
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:442-455 — ultracode single-turn activation.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:1-6 — BT orchestrator overview.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:78-97 — node loop and nextState.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/types.ts:22-53 — states/events.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:21-57 — centralized transition table.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:60-65 — unmapped state/event defaults to Done.

## CodeStudio tools/tiers/dispatch/MCP

- codestudio_mcp-codebase/packages/code-agent/src/core/registry.ts:10-48 — ToolRegistry.
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:55-75 — tier names.
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:216-519 — tier membership.
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:600-670 — profile/contextual tier resolution.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/orchestrator.ts:41-55 — active tiers and pinned hidden tools state.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/types.ts:78-83 — activeTiers null disables filtering.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:315-351 — dispatch metadata, hidden calls and gate prep.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:346-351 — hidden-by-tier execution boundary gap.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:634-703 — heartbeat/progress/abort/timeouts/serialization.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:21-38 — MCP bridge limits.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:68-142 — disabled tools/descriptions/schema cleanup.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:173-212 — indexer MCP connection.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:338-386 — MCP resources/tools lifecycle.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:1-16 — external MCP transports and tier imports.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:151-222 — external MCP aggregation and tier maps.
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:296-416 — external call wrapping/reconnect/state reporting.
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:542-575 — silent bootstrap fallback for unknown tools (`CODER_STRICT_TIERS`).
- codestudio_mcp-codebase/packages/code-agent/src/tools/expand.ts:114-140 — expand_toolset visibility takes effect next turn.
- codestudio_mcp-codebase/packages/code-agent/src/tools/runtime-tool-tiers.ts:21-45 — contributor-declared custom runtime tiers.
- codestudio_mcp-codebase/packages/code-agent/src/tools/tool-priority.ts:50-251 — cap trimming: NEVER_TRIM/HOT_RANK/selectUnderCap.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/assembly/tools.ts:148-176 — master protection context + default session cap 48.
- codestudio_mcp-codebase/packages/code-agent/src/tools/descriptions.ts:206-215 — terseDescription strips USE/DON'T routing rules.
- codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:360-369 — nativeToolsSection lists registered (not cap-visible) tools.
- codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:867-879 — toolCapBlock renders only after trimming.
- codestudio_mcp-codebase/packages/code-agent/src/core/system-prompt.ts:968-995 — unconditional ~27-line memory section.
- codestudio_mcp-codebase/packages/code-agent/src/prompts/loader.ts:73-82 — unescaped `{{key}}` interpolation.

## CodeStudio agents/workflow/Ultra

- codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:4-25 — agent presets.
- codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:29-51 — built-in agent list.
- codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:60-71 — irreversible confirmation comments.
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent.ts:1-21 — spawn_agent consolidation and read-only explore children.
- codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:44-95 — per-profile limits.
- codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:126-147 — dispatch preparation and retention mapping.
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-research-policy.ts:35-60 — research depth inference.
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-research-policy.ts:98-178 — research policy criteria/nudges.
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:26-27 — dependency digest caps.
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:104-138 — workflow dependency waves.
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:140-189 — concurrent wave execution.
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:156-185 — parent ToolContext/parentTools isolation gap.
- codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1035-1038 — run_command is allowlisted and shell path-scope remains warning-only.
- codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1282-1312 — enforce-writes blocks direct native write tools, not shell commands.
- codestudio_mcp-codebase/packages/code-agent/src/tools/__tests__/subagent-allowlist.test.ts:98-108 — current tests expect run_command scope violations to record without blocking.
- codestudio_mcp-codebase/packages/code-agent/src/tools/execute-tasks.ts:94-121 — task wave setup.
- codestudio_mcp-codebase/packages/code-agent/src/tools/execute-tasks.ts:539-716 — sequential/parallel task execution.
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-types.ts:14 — hard `WORKFLOW_MAX_STEPS = 12` wall.
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-jobs.ts:88-247 — in-memory background job singleton (no restart durability).
- codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:343-354 — stall monitor: timeout/idle/tool-count heuristics only.
- codestudio_mcp-codebase/packages/code-agent/src/tools/micro-agent-profiles.ts:100-149 — profile write-enforcement modes (implement-only enforce-writes).
- codestudio_mcp-codebase/packages/code-agent/src/tools/tasks.ts:780-794 — inline task_complete scope validation is warning-only.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner.ts:2407-2437 — extractPathsFromToolArgs fixed arg-name set.

## CodeStudio policy/hooks/workspace/memory

- codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:64-75 — unknown/external tool classification risk area.
- codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:163 — PermissionGate class.
- codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:199-270 — classification, approvals and fail-closed payload behavior.
- codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:358-371 — risk heuristics area.
- codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:426-475 — sandbox-required and plan/spec approval policy.
- codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:478-490 — strict execute/admin reserved.
- codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:42-87 — project hooks.
- codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:17-64 — runtime hook contexts.
- codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:64-125 — runtime hook timeout methods.
- codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:21-60 — explicit worktree creation.
- codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:104-241 — enter/exit worktree tools.
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:1157-1163 — sandbox adapters replace ports when bound.
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:1164-1183 — missing sandbox binding host-write warning.
- codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:17-45 — durable memory types and tools.
- codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:108-223 — durable memory implementation.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/memory-query.ts:51-153 — automatic recall query generation.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:40-53 — compaction harvest notes and limits.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:91-137 — memory promotion.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/compaction/memory-harvest.ts:77-78 — success-only toolTrail (failures not harvested).
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/assembly/dynamic-injection.ts:162-164 — DEFAULT_MAX_MEMORY=3 / MEMORY_CONTENT_CAP=300.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/assembly/dynamic-injection.ts:222-231 — recall injection at turn 1 / post-compaction only.
- codestudio_mcp-codebase/packages/code-agent/src/tools/record-memo.ts:55-85 — volatile in-memory subagent memos.
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:2523-2550 — memoryQuerySynthesizer partially wired.

## CodeStudio dashboard/session stream/control plane

- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:53-65 — POST streaming via fetch/ReadableStream.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:75-89 — Last-Event-ID reattach.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:159-190 — token batching and forced flushes.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:204-225 — Electron Hono URL and client_msg_id idempotency.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:227-268 — ordered processing and bus_info handling.
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:17 — coder stream route and pumpBusToSSE.
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-27 — cursor replay/heartbeat/attach replay callbacks.
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:43-82 — backpressure/abort/bus_info.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/handlers.ts:135-368 — chat/tool/approval/provider handlers.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/types.ts:524-592 — live session state.
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21 — right rail destinations.
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/RightPanelHost.tsx:101-118 — Session State inputs.
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:19-50 — read-only Subagents panel behavior.
- codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:589-607 — session launch model/provider/mode resolution.
- codestudio_mcp-codebase/apps/dashboard/features/chat/AgentChat.tsx:1346 — subagent abort outside dedicated panel.
- codestudio_mcp-codebase/apps/dashboard/features/chat/ToolConfigDialog.tsx:54-90 — tier grouping/control gap.
- codestudio_mcp-codebase/apps/dashboard/features/chat/ToolConfigDialog.tsx:99-172 — tool config view/dialog.
- codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:73-81 — permission icon cycling.
- codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:116-145 — pipeline/reasoning/Ultra controls.
- codestudio_mcp-codebase/apps/dashboard/lib/api-client.ts:729-745 — generic browser streaming fallback not wired.

### SSE transport audit (this round — see 08-streaming-sse-deep-dive.md)

- codestudio_mcp-codebase/packages/provider-sdk/src/adapter.ts:74 — ChatProvider.chat streaming contract.
- codestudio_mcp-codebase/packages/provider-sdk/src/wire.ts:215-240 — delta types.
- codestudio_mcp-codebase/packages/provider-sdk/src/stream-resilience.ts:53-66 — premature-close handling (post-done only).
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-stream.ts:120-182 — consumeStream delta fan-out.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-stream.ts:220-224 — tool_call_args partials dropped.
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-stream.ts:265-267 — image_generated ignored.
- codestudio_mcp-codebase/apps/http-api/workers/coder-worker.ts:508-534 — worker bus + bridge emit.
- codestudio_mcp-codebase/apps/http-api/workers/coder-worker.ts:880-908 — deferTerminalEvent until transcriptFlushed.
- codestudio_mcp-codebase/apps/http-api/sse/runnerWiring.ts:21-190 — runner event → bus publish mapping.
- codestudio_mcp-codebase/apps/http-api/sse/CoderWorkerPool.ts:609-662 — crash → terminal event.
- codestudio_mcp-codebase/apps/http-api/sse/CoderWorkerPool.ts:834-854 — worker bus mirrored to main bus.
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:67-73 — BUFFER_CAP/BUFFER_BYTE_CAP.
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:175-211 — publish/subscriber fan-out; subscriber errors swallowed.
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:285-297 — subscribe replays before registering (race, fixed this round).
- codestudio_mcp-codebase/apps/http-api/coder-bus.ts:358-397 — CODER_ATTACH_REPLAY_TRIM default + subscribeWithReplay.
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:46-107 — SSE pump (missing X-Accel-Buffering, fixed this round).
- codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:122-127 — Last-Event-ID parsing.
- codestudio_mcp-codebase/apps/http-api/sse/SSEHeartbeat.ts:19-26 — 20s ping.
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:417-430 — attach route.
- codestudio_mcp-codebase/apps/http-api/server/routes/coder/stream.ts:498-771 — messages route with idempotent client_msg_id.
- codestudio_mcp-codebase/apps/http-api/server/routes/docs-agent/index.ts:96 — X-Accel-Buffering precedent.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:75-82 — EVENT_BATCH_SIZE/yield batching.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:237-264 — bus_info handling + silent JSON.parse failures.
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:254-257 — lastSeenSeq advanced before handling (fixed this round).
- codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/openStream.ts:274-340 — stall detector / reconnect drain.
- codestudio_mcp-codebase/apps/dashboard/vite.config.ts:112-130 — dev proxy SSE mitigations.
- codestudio_mcp-codebase/packages/shared/src/sse/ReconnectingSSEClient.ts:83-195 — fetch stream + backoff.
- codestudio_mcp-codebase/packages/shared/src/sse/SSEFramer.ts:30-81 — frame parser (retry ignored, silent drops).
