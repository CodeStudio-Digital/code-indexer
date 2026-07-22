# ClaudeOpen → CodeStudio agent research

Status: documentation-only research package. No runtime code changes are implemented in this pass; the documents contain proposals for future implementation.

## Why this exists

The goal is to map ClaudeOpen feature-by-feature and compare it with the CodeStudio code-agent and dashboard so future implementation work can import the effective parts deliberately instead of cloning a large external design blindly.

The user's base direction is correct: the target should be one control plane for agents, policy, environments and sessions, not a bag of unrelated features.

## Scope

This package covers:

1. Tools and tool runtime.
2. Orchestrator, session loop and event stream.
3. Agents, subagents and Ultra/autonomy.
4. Memory, context, compaction and handoff.
5. Policy, permissions, MCP, sandbox and hooks.
6. Dashboard/session control-plane UX.
7. A phased roadmap for importing the effective ClaudeOpen ideas into CodeStudio.

## Non-goals

- Do not copy ClaudeOpen deminified source into CodeStudio.
- Do not implement runtime changes in this research pass.
- Do not treat ClaudeOpen as universally superior. CodeStudio has strong capabilities in MCP/indexer/RAG, Company Mode, skills, workflow DAGs, task approval, output recovery and durable memory.

## Existing CodeStudio research conventions

- The Codex comparison uses a clear gap-analysis format with scope, analyzed repo and status tables in codestudio_mcp-codebase/docs/research/codex-gap-analysis.md:1-12.
- It separates inventory, recommendation and parity status in codestudio_mcp-codebase/docs/research/codex-gap-analysis.md:27-77.
- The tool inventory already compares Claude Code, Codex, kimi-cli and MCP capabilities in codestudio_mcp-codebase/docs/agent-research/TOOLS_INVENTORY.md:1-15.
- Previous runner research documents exact bug classes around spawn_agent, tiers and workflow tooling in codestudio_mcp-codebase/docs/bt-runner-refactor.md:167-185.

## Document map

| File | Purpose |
|---|---|
| 01-claudeopen-tools-runtime.md | Tools, descriptors, aliases, runtime composition and CodeStudio registry/tiers gaps + verified tiers/prompt failure modes. |
| 02-orchestrator-session-loop.md | ClaudeOpen event pump vs CodeStudio BT runner/SSE and the event-log recommendation. |
| 03-agents-subagents-ultra.md | Agent/Task, background/remote/resume, CodeStudio spawn_agent/workflow/Ultra gaps (now 10 verified gaps). |
| 04-memory-context-compaction.md | ClaudeOpen handoff/compaction/memory vs CodeStudio durable memory and visibility gaps + 8 verified improvements. |
| 05-policy-permissions-mcp-sandbox-hooks.md | Permissions, policy, tiers, MCP, sandbox, hooks and fail-closed strategy + hooks catalog/classifier findings. |
| 06-dashboard-session-control-plane.md | Dashboard streaming, panels and the proposed session control-plane UX. |
| 07-roadmap-importacao-efetiva.md | Phased roadmap based on the user's base plan and verified gaps + quick wins delivered this round. |
| 08-streaming-sse-deep-dive.md | End-to-end SSE transport audit: 14 verified weaknesses, 5 P0 fixes shipped, P1/P2 backlog. |
| REFERENCES.md | Consolidated references by domain. |

## Executive TL;DR

### What ClaudeOpen does better

- It exposes a more unified tool descriptor model with runtime composition of built-ins and MCP tools; see claudeopen/claude-code-src/agent/tools.js:17285-17323 and claudeopen/claude-code-src/agent/loop.js:709-738.
- Its orchestrator behaves like an event pump with normalized public events and final result envelopes; see claudeopen/claude-code-src/agent/loop.js:4804-5327.
- Its Agent/Task abstraction has explicit background/remote launch, task identity, output metadata and resume semantics; see claudeopen/claude-code-src/agent/tools.js:17265-17329 and claudeopen/claude-code-src/agent/loop.js:580-632.
- Permission mode, tool restrictions, agent allowlists, hooks and MCP policy are separate layers; see claudeopen/claude-code-src/agent/permissions.js:790-926 and claudeopen/claude-code-src/agent/loop.js:1184-1222.
- Compaction/handoff is part of the stream rather than an afterthought; see claudeopen/claude-code-src/agent/compaction.js:361-364 and claudeopen/claude-code-src/agent/tools.js:262-283.

### What CodeStudio already does better

- Semantic navigation, indexer MCP, RAG, LSP, skills, task approval, Company Mode, output recovery and explicit tiers are strong differentiators; see codestudio_mcp-codebase/docs/research/codex-gap-analysis.md:67-77.
- The code-agent has a behavior-tree runner with explicit states and guards; see codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/types.ts:22-53 and codestudio_mcp-codebase/packages/code-agent/src/core/runner/machine/transitions.ts:21-57.
- The dashboard SSE path already supports POST streaming, per-session cursors, idempotent client message IDs, replay, heartbeat and backpressure; see codestudio_mcp-codebase/apps/dashboard/hooks/agent-stream/useAgentStream.ts:53-89 and codestudio_mcp-codebase/apps/http-api/sse/pumpBusToSSE.ts:14-82.
- Durable project/user memory has explicit tools and automatic recall/harvest; see codestudio_mcp-codebase/packages/code-agent/src/tools/project-memory-tools.ts:17-45 and codestudio_mcp-codebase/packages/code-agent/src/core/runner/memory-query.ts:51-153.

### Why our code-agent/dashboard can feel inferior

- Ultra is currently more of a host-owned execution posture than a complete autonomous agent platform with leases, background registry, isolation, replay and dashboard control-plane; see codestudio_mcp-codebase/packages/code-agent/src/index.ts:339-397 and codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:156-185. This round verified five more concrete limits: hard `WORKFLOW_MAX_STEPS=12` (workflow-types.ts:14), in-memory background jobs (subagent-jobs.ts:88-247), count/idle-only stall detection (implement-subagent.ts:343-354), implement-only write enforcement (micro-agent-profiles.ts:100-149) and warning-only inline scope checks (tasks.ts:780-794).
- Tool tiers are useful visibility controls but not an authorization boundary if hidden tools can still execute by name; see codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:346-351. This round also verified seven tier/prompt failure modes (silent bootstrap fallback, expand_toolset race, cap-48 trimming, post-hoc toolCapBlock, terseDescription stripping USE/DON'T, prompt sections listing trimmed tools, `{{ }}` loader escaping) — details in 01-claudeopen-tools-runtime.md.
- The SSE *architecture* is solid, but a transport audit verified 14 concrete weaknesses behind the "streaming feels bad" symptom (missing `X-Accel-Buffering` on the chat route, replay/subscribe race, cursor-before-handle loss, silent drops, per-token frames). Five P0 fixes shipped in this round; full evidence in 08-streaming-sse-deep-dive.md.
- Worktrees and sandbox exist, but per-agent isolation is not the default authority for mutating work; see codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:104-241 and codestudio_mcp-codebase/packages/code-agent/src/index.ts:1157-1183.
- Dashboard controls are dispersed between composer, right rail, transcript cards and global panels; see codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/types.ts:11-21 and codestudio_mcp-codebase/apps/dashboard/features/chat/composer/ComposerActionIcons.tsx:73-145.

## Target architecture

The target should be a single Session Control Plane:

~~~mermaid
flowchart TB
  UI[Dashboard / CLI / API] --> SC[Session Control Plane]
  SC --> PE[Policy Engine]
  SC --> EV[Durable Event Log]
  SC --> RS[Runtime Supervisor]
  SC --> AG[Agent Registry]
  RS --> WL[Workspace Lease]
  WL --> H[Host read-only]
  WL --> W[Git worktree]
  WL --> C[Container]
  WL --> R[Remote]
  PE --> SB[Secret and Network Broker]
  EV --> UI
  AG --> EV
~~~

## Reading order

Read in this order:

1. 01-claudeopen-tools-runtime.md
2. 02-orchestrator-session-loop.md
3. 03-agents-subagents-ultra.md
4. 04-memory-context-compaction.md
5. 05-policy-permissions-mcp-sandbox-hooks.md
6. 06-dashboard-session-control-plane.md
7. 08-streaming-sse-deep-dive.md
8. 07-roadmap-importacao-efetiva.md
9. REFERENCES.md
