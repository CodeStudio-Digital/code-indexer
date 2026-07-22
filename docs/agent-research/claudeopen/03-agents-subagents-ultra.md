# 03 — Agents, subagents and Ultra

## Summary

ClaudeOpen's Agent/Task system feels effective because background, remote, identity, output files, model choice, cwd/isolation and resume are all part of the agent contract. CodeStudio has stronger multi-agent primitives in some ways, especially workflow DAGs and Company Mode, but Ultra currently lacks automatic workspace leases, a durable agent registry/control-plane and cohesive dashboard operations.

## ClaudeOpen observations

### Agent result states

The Agent tool distinguishes synchronous completion, async launch and remote launch. Results can include agent/task IDs, output files, models used and cloud session URL in claudeopen/claude-code-src/agent/tools.js:17265-17283.

Short source excerpt from claudeopen/claude-code-src/agent/tools.js:17265-17283:

~~~js
status: S.literal("async_launched"),
agentId: S.string().describe("The ID of the async agent"),
outputFile: S.string().describe("Path to the output file for checking agent progress"),
canReadOutputFile: S.boolean().optional().describe("Whether the calling agent has Read/Bash tools to check progress")
// ...
status: S.literal("remote_launched"),
taskId: S.string().describe("The ID of the remote agent task"),
sessionUrl: S.string().describe("The URL of the cloud session")
~~~

### Agent launch input

Agent calls accept prompt, subtype, model, background flag, isolation and cwd. Nesting depth is explicitly capped in claudeopen/claude-code-src/agent/tools.js:17314-17329.

### Agent registry and resume

Subagents are persisted in a task registry, duplicate resume is guarded and stored state can be restored in claudeopen/claude-code-src/agent/loop.js:580-632.

### Self-contained prompts

ClaudeOpen's team/subagent docs emphasize that spawned agents start without parent conversation context, so prompts must be self-contained. Background completion arrives in a later turn. See claudeopen/claude-code-src/agent/teams.js:3560-3605.

### Team identity and lead/follower behavior

Team/context code exposes dynamic team identity, teammate detection, lead detection and teammate plan-mode expectations around claudeopen/claude-code-src/agent/teams.js:45-76 and claudeopen/claude-code-src/agent/teams.js:135-153.

## CodeStudio current state

### Agent presets

CodeStudio agents are presets over the same runner/tier system. Built-ins include explore, research, plan, build, admin, spec, app, builder, API and diagram roles in codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:4-25 and codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:29-51.

### spawn_agent consolidation

Deprecated sequential/parallel subagent tools were consolidated into spawn_agent. Explore children are read-only and cannot recursively spawn agents in codestudio_mcp-codebase/packages/code-agent/src/tools/subagent.ts:1-21.

The core spawn path normalizes agents, workspace briefings, prompts, retention data and profile-specific limits in codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:44-95 and codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:126-147.

Research depth is inferred and converted into completion criteria and synthesis nudges in codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-research-policy.ts:35-60 and codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-research-policy.ts:98-178.

### Workflow DAG

CodeStudio workflows execute dependency-ready steps in waves and persist state between waves in codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:104-138.

Each wave exposes provider/model/budget telemetry and runs agents concurrently with prompt, allowlist, path scope, limits and abort signal in codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:140-189.

### Task execution waves

execute-tasks builds dependency waves and supports sequential or parallel groups in codestudio_mcp-codebase/packages/code-agent/src/tools/execute-tasks.ts:94-121 and codestudio_mcp-codebase/packages/code-agent/src/tools/execute-tasks.ts:539-716.

### Ultra

Ultra is a host-owned durable session execution mode; legacy reasoningEffort=ultra rows are migrated without passing the sentinel to providers in codestudio_mcp-codebase/packages/code-agent/src/index.ts:339-397.

A turn keyword ultracode can activate the Ultra posture for one run in codestudio_mcp-codebase/packages/code-agent/src/index.ts:442-455.

## Gaps

### Gap 1 — Ultra is posture, not yet full autonomous control plane

Ultra currently changes execution posture and orchestration behavior, but does not by itself create a durable per-agent workspace lease, background registry, remote identity, event log and dashboard control surface.

This is why it can feel inferior to ClaudeOpen's Agent/Task model even though CodeStudio has powerful workflow primitives.

### Gap 2 — workflow children share parent context/tools

Workflow children receive parentTools and the parent ToolContext; isolation is allowlist plus optional path scope, not a mandatory worktree/container lease. See codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:156-185.

This is not enough for mutating background agents.

### Gap 3 — dependency digest cap can erase important context

Dependency context between workflow steps is capped at 3,500 characters per digest and 10,500 total in codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:26-27.

This is efficient but can make multi-agent reasoning feel lossy unless paired with artifacts/output files/event-log references.

### Gap 4 — implement subagent scope is not a true sandbox

This is verified in current code, not just a historical concern. `run_command` is in the implement allowlist, and the code explicitly says shell path-scope remains warning-only until shell write detection is hardened in codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1035-1038. The path-scope checker blocks only direct native write tools in enforce-writes mode, not shell commands, in codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1282-1312. The current test suite locks this behavior by expecting run_command violations to be recorded without blocking in codestudio_mcp-codebase/packages/code-agent/src/tools/__tests__/subagent-allowlist.test.ts:98-108.

### Gap 5 — dashboard control is split

The dedicated SubagentsPanel is read-only in codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:19-50, while abort/control lives elsewhere in the transcript. This weakens perceived autonomy and control.

### Gap 6 — workflow step cap is a hard wall

`WORKFLOW_MAX_STEPS = 12` is a hard constant in codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-types.ts:14, and `validateWorkflowSteps` rejects larger DAGs outright. Tasks that naturally decompose into more than 12 steps must be manually split by the model, which breaks the "declare the whole DAG" mental model and makes Ultra feel constrained on large migrations/audits.

### Gap 7 — background agent jobs live in process memory only

Background subagent jobs are held in an in-memory singleton with per-job `AbortController` in codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-jobs.ts:88-247. A backend/worker restart loses job identity, status and the ability to collect or abort; there is no durable AgentRun registry behind them (compare ClaudeOpen's persisted task registry in claudeopen/claude-code-src/agent/loop.js:580-632).

### Gap 8 — stall detection is count/idle heuristics only

The subagent monitor watches `timeoutMs`, `stallMs`, tool-call count and idle time in codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:343-354, but never evaluates semantic progress (is the answer converging?). Agents that spin "productively" (repeated reads with no plan movement) are indistinguishable from healthy ones until the hard timeout.

### Gap 9 — write enforcement is implement-only

`MICRO_AGENT_PROFILES` sets `explore: 'warn'`, `verify: 'warn'`, `review: 'warn'`, `full: 'warn'`; only `implement` gets `enforce-writes` in codestudio_mcp-codebase/packages/code-agent/src/tools/micro-agent-profiles.ts:100-149. A `full` child inherits the parent registry with no write fence at all, so the most capable profile is also the least constrained.

### Gap 10 — scope checks outside spawn are warning-only

Inline `task_complete` validates `files_modified` against the task scope but only records `sandbox_violations` in the result in codestudio_mcp-codebase/packages/code-agent/src/tools/tasks.ts:780-794. Path extraction for scopes recognizes only a fixed set of arg names (`path`, `file_path`, `target`, `destination`, `from_path`, `to_path`, `paths`) plus limited shell patterns in codestudio_mcp-codebase/packages/code-agent/src/core/runner.ts:2407-2437, so MCP/external tools with differently-named path args escape scoping entirely.

## Preserve

- Keep spawn_agent as the single ephemeral delegation tool.
- Keep workflow DAGs; they are a CodeStudio advantage over simple spawn-and-wait systems.
- Keep Company Mode/master-subordinate orchestration separate where it has richer board ownership.
- Keep research depth contracts and completion criteria.
- Keep task approval gates for multi-file implementation work.

## Recommendation

Introduce AgentRun and WorkspaceLease as first-class contracts.

Suggested contract:

~~~ts
type AgentIsolation = 'inherit' | 'readonly' | 'worktree' | 'container' | 'remote';

type AgentRunStatus =
  | 'creating'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'paused';

interface WorkspaceLease {
  id: string;
  sessionId: number;
  agentRunId?: string;
  target: 'host' | 'worktree' | 'container' | 'remote';
  root: string;
  branch?: string;
  baseSha?: string;
  sandboxId?: string;
  status: 'creating' | 'ready' | 'paused' | 'failed' | 'released';
}

interface AgentRun {
  id: string;
  parentSessionId: number;
  parentAgentRunId?: string;
  profile: string;
  model?: string;
  promptHash: string;
  isolation: AgentIsolation;
  workspaceLeaseId?: string;
  status: AgentRunStatus;
  outputArtifactIds: string[];
  createdAt: string;
  updatedAt: string;
}
~~~

Policy:

- explore/reviewer can share readonly workspace.
- implement/build background agents default to worktree.
- container/remote sessions fail closed if lease cannot be created.
- no silent fallback to host writes.

## Backlog

| Priority | Item | Notes |
|---|---|---|
| S | Add AgentRun model backed by event log | No behavior change; mirror spawn_agent runs. |
| S | Add WorkspaceLease contract for host and worktree | Start without containers. |
| S | Show AgentRun/lease in dashboard Subagents panel | Include cwd, branch, status, diff count. |
| A | Default implement background agents to worktree | Feature flag first. |
| A | Add output artifacts for dependency handoff | Avoid digest-only context. |
| A | Add resume/attach/abort operations per agent in panel | Move from transcript-only control. |
| B | Extend leases to container/remote | After policy and secrets are ready. |
| A | Durable AgentRun registry behind background jobs | Jobs currently in-memory only (`subagent-jobs.ts:88-247`); restart loses identity/status. |
| A | Semantic stall detection for subagents | Complement count/idle heuristics (`implement-subagent.ts:343-354`). |
| B | Raise/uncap `WORKFLOW_MAX_STEPS` with wave budgeting | Hard 12-step wall (`workflow-types.ts:14`). |
| B | Extend enforce-writes beyond `implement` profile | Other profiles are warn-only (`micro-agent-profiles.ts:100-149`). |
| B | Harden scope path extraction for MCP/external tools | Fixed arg-name set is evadable (`runner.ts:2407-2437`). |

## References

- claudeopen/claude-code-src/agent/tools.js:17265-17283
- claudeopen/claude-code-src/agent/tools.js:17314-17329
- claudeopen/claude-code-src/agent/loop.js:580-632
- claudeopen/claude-code-src/agent/teams.js:45-76
- claudeopen/claude-code-src/agent/teams.js:135-153
- claudeopen/claude-code-src/agent/teams.js:3560-3605
- codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:4-25
- codestudio_mcp-codebase/packages/code-agent/src/agents/index.ts:29-51
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent.ts:1-21
- codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:44-95
- codestudio_mcp-codebase/packages/code-agent/src/tools/spawn-agent-core.ts:126-147
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-research-policy.ts:35-60
- codestudio_mcp-codebase/packages/code-agent/src/tools/subagent-research-policy.ts:98-178
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:26-27
- codestudio_mcp-codebase/packages/code-agent/src/tools/workflow/workflow-run.ts:104-189
- codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1035-1038
- codestudio_mcp-codebase/packages/code-agent/src/tools/implement-subagent.ts:1282-1312
- codestudio_mcp-codebase/packages/code-agent/src/tools/__tests__/subagent-allowlist.test.ts:98-108
- codestudio_mcp-codebase/packages/code-agent/src/tools/execute-tasks.ts:94-121
- codestudio_mcp-codebase/packages/code-agent/src/tools/execute-tasks.ts:539-716
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:339-397
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:442-455
- codestudio_mcp-codebase/apps/dashboard/features/chat/right-panel/SubagentsPanel.tsx:19-50
