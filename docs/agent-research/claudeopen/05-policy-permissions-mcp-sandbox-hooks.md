# 05 — Policy, permissions, MCP, sandbox and hooks

## Summary

The critical architectural upgrade is to evolve CodeStudio's PermissionGate into a PolicyEngine that evaluates tools, commands, paths, domains, MCP/plugin capabilities, workspace leases and grants. ClaudeOpen's main lesson is layering: mode resolution, per-tool checks, agent allowlists, MCP allow/deny and hooks are separate gates with explicit outcomes.

## ClaudeOpen observations

### Permission modes and reasons

ClaudeOpen modes include acceptEdits, auto, bypassPermissions, default, dontAsk and plan. Decision reasons include rule, mode, subcommand results, permission prompt tool, hook, asyncAgent, sandboxOverride, workingDir, safetyCheck, classifier and other in claudeopen/claude-code-src/agent/permissions.js:790-805.

### Mode resolution

auto maps to classify, bypass and eligible plan operations map to allow, dontAsk maps to deny and other cases ask in claudeopen/claude-code-src/agent/permissions.js:863-873.

Short source excerpt from claudeopen/claude-code-src/agent/permissions.js:863-873:

~~~js
function Lqt(e, t) {
  if (e === "auto") {
    return "classify";
  }
  if (e === "bypassPermissions" || e === "plan" && t) {
    return "allow";
  }
  if (e === "dontAsk") {
    return "deny";
  }
  return "ask";
}
~~~

### Privilege ordering

Modes form an explicit privilege ordering from plan/default through accept edits/auto to bypass in claudeopen/claude-code-src/agent/permissions.js:894-926.

### Downgrade prevention and decision reasons (verified this round)

Mode transitions are guarded: `Dqt` refuses to move from a more permissive mode to a less permissive one (returning `undefined`), with a single explicit exception — `auto → acceptEdits` is allowed in claudeopen/claude-code-src/agent/permissions.js:832-844:

~~~js
function Dqt(e, t) {
  if (!e) { return; }
  if (t === "auto" && e === "acceptEdits") { return; }
  if (SCl[e] <= SCl[t]) { return e; } else { return undefined; }
}
~~~

Decision reasons are a closed enum — `rule`, `mode`, classifier, hook and others in claudeopen/claude-code-src/agent/permissions.js:794 — which makes every allow/deny/ask explainable after the fact. The auto-mode classifier prompt composes `allow`, `softDeny`, `hardDeny`, `environment` and `settingsDenyBlock` sections, with hard-deny as an absolute barrier in claudeopen/claude-code-src/agent/tools.js:44964-45015. The final approval flow sends `can_use_tool` and resolves behavior centrally in claudeopen/claude-code-src/agent/tools.js:71555-71596.

### MCP server policy merge (verified this round)

MCP server policies are parsed into `allow`/`deny`/`ask` rule sets from `always_allow`/`always_deny`/`always_ask` config, then merged by category into the session rule maps (`alwaysAllowRules`, `alwaysDenyRules`, `alwaysAskRules`) in claudeopen/claude-code-src/agent/permissions.js:1032-1106. Allow rules for MCP tools require the literal `mcp__<server>__` prefix while deny/ask accept wildcards in claudeopen/claude-code-src/agent/mcp.js:103-117.

### Hooks: 30-event lifecycle catalog (verified this round)

ClaudeOpen's hook surface spans thirty lifecycle events in claudeopen/claude-code-src/agent/hooks.js:1-2:

~~~js
xU = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit", "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "CwdChanged", "FileChanged", "MessageDisplay"];
~~~

Hooks load from layered sources — user config, project config, plugins, managed policy and session hooks — in claudeopen/claude-code-src/agent/hooks.js:3949-4015, with per-event matching in claudeopen/claude-code-src/agent/hooks.js:4016-4090 and timeout-wrapped execution in claudeopen/claude-code-src/agent/hooks.js:4197-4315. Decision capability is real: `PreToolUse` can return `permissionDecision` (allow/deny/ask/defer) plus `updatedInput` in claudeopen/claude-code-src/agent/hooks.js:194-199; `PostToolUse` can return `updatedToolOutput` and `preventContinuation` in claudeopen/claude-code-src/agent/hooks.js:221-224.

### Layered execution gates

Subagent/observer execution appends a permission-mode layer and separately checks tool restrictions and allowed agent types in claudeopen/claude-code-src/agent/loop.js:1184-1205.

Tool execution is gated by permission decisions and managed hooks; deny/ask/defer/blocking hook results stop execution in claudeopen/claude-code-src/agent/loop.js:1212-1222.

### MCP allow/deny policy

MCP config logic separates discovery/deduplication from policy filtering and has allowed/denied server handling in claudeopen/claude-code-src/agent/mcp.js:4846-5185.

## CodeStudio current state

### PermissionGate

PermissionGate is defined in codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:163.

It classifies each call, and DB writes stay gated even in auto/unrestricted modes unless explicitly persisted in always-allow grants in codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:199-210.

Approval requests are race-safe and exact DB inputs are preserved when needed in codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:212-237.

Malformed approval payloads fail closed, and allow, persistent allow, abort, interrupt and deny are distinct in codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:240-270.

### Core policy

Centralized policy blocks sandbox-required tools without sandbox and blocks mutations until plan/spec approval in codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:426-475.

Strict execute/admin enforcement is reserved for a future phase and currently inactive when ctx.strict is falsy in codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:478-490.

### Hooks

Project hook scripts are cached by mtime and can alter system prompt or filter tools in codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:42-87.

RuntimeHookRegistry covers tool calls, errors, provider fallback and completion in codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:17-64.

Runtime handlers are wrapped with a five-second timeout in codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:64-125.

### Sandbox and workspace

Tools declaring requiresSandbox fail closed when no sandbox is bound in codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:434-442.

Builder/company sessions swap default filesystem/shell ports for sandbox adapters when a sandbox binding exists in codestudio_mcp-codebase/packages/code-agent/src/index.ts:1157-1163.

However, if a builder/company session lacks sandbox binding, the system warns that writes will land on host instead of refusing the run in codestudio_mcp-codebase/packages/code-agent/src/index.ts:1164-1183.

Explicit worktrees live under .mcp-indexer/worktrees and validate names/repository state in codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:21-60. Enter/exit are manual tools in codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:104-241.

## Gaps

### Gap 1 — PermissionGate is not yet one policy engine

PermissionGate, core policy, tiers, tool config, hooks, external roots, MCP server settings and sandbox checks all make related decisions. They need one evaluation path and one explainable result.

### Gap 2 — tier visibility can be confused with security

Tiers hide tools from the model, but hidden tools can still execute if called by name. The dispatch behavior is in codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:346-351.

This is acceptable only if PolicyEngine is the real boundary.

### Gap 3 — sandbox fallback must fail closed

The warning in codestudio_mcp-codebase/packages/code-agent/src/index.ts:1164-1183 describes a dangerous class of bug: expected sandbox missing, host writes possible. Future policy should reject this run.

### Gap 4 — hooks cannot bypass policy

Project/plugin hooks should be able to observe and sometimes ask/deny/patch validated inputs, but never circumvent PolicyEngine.

### Gap 5 — external MCP/plugin capabilities need declaration

MCP server transport and tool names are insufficient for enterprise policy. Capabilities must be declared, audited and default-denied when unknown.

## Recommendation

Evolve PermissionGate into PolicyEngine; do not create a second gate.

PolicyDecision:

~~~ts
interface PolicyDecision {
  effect: 'allow' | 'deny' | 'ask';
  reason: string;
  ruleIds: string[];
  inputPatch?: unknown;
  constraints?: Record<string, unknown>;
}
~~~

Precedence:

1. Organization policy.
2. User policy.
3. Project policy.
4. Session policy.
5. One-shot decision/grant.

Rules:

- deny always wins.
- grants are scoped to exact resource, path/domain/tool/capability and expiry.
- all built-in, MCP, plugin, code_exec nested and subagent tool calls pass through the engine.
- no background agent waits invisibly for user approval.
- shadow mode calculates new decisions without applying them until parity is proven.

## Backlog

| Priority | Item | Notes |
|---|---|---|
| S | Add PolicyEngine wrapper around PermissionGate | Shadow mode first. |
| S | Emit explainable PolicyDecision events | Include rule IDs and redaction. |
| S | Treat tier as visibility only in UI copy | Avoid false security claims. |
| S | Fail closed for required sandbox/company binding | Feature flag if necessary. |
| A | Add capability metadata to built-in and MCP tools | Needed for policy by capability. |
| A | Integrate external roots into PolicyEngine | Exact path and access mode. |
| A | Split hooks into observation and decision hooks | Decision hooks validated by schemas. |
| B | Add enterprise policy locks and plugin catalogs | After core engine is stable. |

## Tests required for future implementation

- Path traversal and symlink tests.
- Shell destructive command policy tests.
- Hidden tier tool execution tests.
- MCP external unknown capability tests.
- code_exec nested tool policy tests.
- Subagent inherited grant tests.
- Sandbox missing fail-closed tests.
- Hook timeout/reentrancy/inputPatch validation tests.

## References

- claudeopen/claude-code-src/agent/permissions.js:790-805
- claudeopen/claude-code-src/agent/permissions.js:863-873
- claudeopen/claude-code-src/agent/permissions.js:894-926
- claudeopen/claude-code-src/agent/loop.js:1184-1222
- claudeopen/claude-code-src/agent/mcp.js:4846-5185
- codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:163
- codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:199-270
- codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:426-490
- codestudio_mcp-codebase/packages/code-agent/src/core/hooks.ts:42-87
- codestudio_mcp-codebase/packages/code-agent/src/core/hook-registry.ts:17-125
- codestudio_mcp-codebase/packages/code-agent/src/index.ts:1157-1183
- codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:21-60
- codestudio_mcp-codebase/packages/code-agent/src/tools/worktree.ts:104-241
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:346-351
