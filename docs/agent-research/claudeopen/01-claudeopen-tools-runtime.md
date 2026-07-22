# 01 — ClaudeOpen tools and tool runtime

## Summary

ClaudeOpen's tool surface is effective because tool metadata, tool execution and runtime composition are treated as one contract. CodeStudio already has a strong ToolRegistry and a much larger capability surface, but the tiers/tool-visibility model is mixed with policy expectations and external MCP tools need stronger structured capability metadata.

## ClaudeOpen observations

### Built-in tool surface

ClaudeOpen exposes a broad built-in set. The prompt layer lists tools such as Read, Glob, Grep, NotebookRead, Skill, AskUserQuestion, Task, Agent, task-management tools and TodoWrite at claudeopen/claude-code-src/agent/prompts.js:5995.

This matters because the model sees a coherent action vocabulary, not a pile of unrelated host functions.

### Unified descriptor contract

The Agent tool is defined through the same descriptor abstraction as other tools. The descriptor includes:

- dynamic prompt/description,
- canonical name,
- aliases,
- input/output schemas,
- maximum result sizing,
- async call implementation.

Reference: claudeopen/claude-code-src/agent/tools.js:17285-17323.

The Agent descriptor specifically uses a canonical name with legacy alias Task and search metadata for delegation in claudeopen/claude-code-src/agent/tools.js:17301-17312.

Short source excerpt from claudeopen/claude-code-src/agent/tools.js:17301-17312:

~~~js
name: No,
searchHint: "delegate work to a subagent",
aliases: [Vj],
maxResultSizeChars: 100000,
async description() {
  return "Launch a new agent";
},
get inputSchema() {
  return dps();
},
get outputSchema() {
  return G7g();
}
~~~

### Runtime composition

ClaudeOpen does not appear to rely only on a single static registry. The session loop carries options.tools, filters them and merges MCP-provided tools at runtime in claudeopen/claude-code-src/agent/loop.js:709-738.

This gives it a clean place to combine:

- built-in tools,
- MCP tools,
- permission-filtered tools,
- agent-mode-specific tools,
- possible dynamic/remote tools.

### MCP separation

MCP discovery/configuration is separate from policy filtering and ordinary tool execution. Deduplication and allow/deny logic appear in claudeopen/claude-code-src/agent/mcp.js:4846-5185.

This separation is important: tool availability, transport config and permission policy are different concepts.

## CodeStudio current state

### ToolRegistry

CodeStudio has a central registry for registration, lookup, listing, filtering and invocation in codestudio_mcp-codebase/packages/code-agent/src/core/registry.ts:10-48.

This is a solid base and should not be discarded.

### Tiers

Tools are divided into bootstrap, navigate, master, admin, preview, API, DB, diagram, browser, sprite-studio and contextual/custom tiers in codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:55-75 and codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:216-519.

Profiles and contextual tiers are resolved in codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:600-670.

### Dispatch

Dispatch resolves metadata, normalizes inputs, classifies interactivity and handles hidden calls before executing gates in codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:315-351.

Tool calls receive heartbeats, progress reporting, abort propagation, timeouts and serialization for mutating/non-parallel-safe tools in codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:634-703.

### MCP/indexer bridge

The built-in MCP bridge has real strengths:

- read-size limits,
- pathological-output guards,
- disabled-tool loading,
- terse descriptions,
- removal of injected projectName from exposed schemas.

References: codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:21-38 and codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:68-142.

The indexer MCP connection and resources/tools lifecycle are in codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:173-212 and codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:338-386.

External MCP servers support stdio, SSE and Streamable HTTP in codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:1-16, with aggregation/tier mapping in codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:151-222.

## Gaps

### Gap 1 — tiers are not policy

The most important boundary issue: tier-hidden or cap-hidden tools can still execute if the model calls their name; only disabled/special goal-gated tools hard-block. This is documented by dispatch behavior in codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:346-351.

Implication: tier is currently a discovery/visibility mechanism, not an authorization boundary. That is acceptable only if UI and policy copy never imply otherwise.

### Gap 2 — external tool risk classification is heuristic-heavy

Unknown/external tool risk classification partly relies on patterns in tool names rather than structured capability declarations. The risk area spans codestudio_mcp-codebase/packages/code-agent/src/core/permission-gate.ts:64-75 and codestudio_mcp-codebase/packages/code-agent/src/core/policy.ts:358-371.

Implication: MCP/plugin tools need declared capabilities such as filesystem.read, filesystem.write, shell.execute, network.egress, db.write and secret.access.

### Gap 3 — tool descriptors are spread across registry, tiers, policy and dashboard metadata

ClaudeOpen's descriptor contract is easier to reason about because name, prompt, schema, result sizing and call behavior sit together. CodeStudio separates concerns for good reasons, but lacks a single normalized ToolDescriptor view for the control plane.

## Tiers failure modes (verified this round)

These are concrete defects/frictions observed in the current tier system, beyond the architectural Gap 1 above:

1. **Silent bootstrap fallback in production** — unknown/dynamically-registered tools default to the `bootstrap` tier unless `CODER_STRICT_TIERS=1` (`tiers.ts:542-575`, specifically `tiers.ts:573-574`), inflating turn-1 visibility instead of failing closed. The `write_stdin`-without-`write_file` incident documented in `tiers.ts:357-369` is an example of this class.
2. **`expand_toolset` visibility race** — `runner.promoteTier(tier)` takes effect, but the response itself states the expanded list is "visible starting next turn" (`expand.ts:114-140`). A model that expands and immediately calls the new tool in the same turn fails; if the session ends, the expansion is wasted.
3. **Cap 48 applied even to large-catalog models** — `sessionCap = Math.min(modelMaxTools, 48)` (`core/runner/assembly/tools.ts:173-176`) forces aggressive trimming (`selectUnderCap` in `tool-priority.ts:50-251`) even when the model supports 200+ tools, cutting cold-but-needed tiers.
4. **Master protection depends on ambient context** — `isMasterRunner` reads `toolContext.companyContext?.isMaster` (`core/runner/assembly/tools.ts:148-159`); a master runner spawned outside company context loses `MASTER_TOOLS` trimming protection.
5. **`HOT_RANK` × tier-set misalignment** — `todo_write` is hot-ranked (`tool-priority.ts:156`) but demoted to `NAVIGATE_TOOLS` as a `task_list` alias (`tiers.ts:282-284`), so trimming priority and tier membership disagree.
6. **Contextual tiers confuse `expand_toolset`** — the enum includes auto-activated tiers like `preview`/`browser` (`expand.ts:39-41`), but runtime auto-activation (`tiers.ts:635-659`) means the model can request an "unlock" of an already-active tier and get a confusing "already active" answer.
7. **No validation for custom runtime tiers** — `collectRuntimeToolTiers` accepts contributor-declared `runtimeTier` (`runtime-tool-tiers.ts:21-45`) with only id/displayName checks; there is no central policy on what tier an external tool should land in besides the bootstrap fallback.

## Prompt-layer failure modes (verified this round)

1. **Zero few-shot examples** — `prompts/*.txt` and `system-prompt.ts` contain no input/output examples for high-friction tools (`edit_file`, `find_tools`, `decision_gate`); ClaudeOpen's subagent prompts, by contrast, embed worked examples (claudeopen/claude-code-src/agent/teams.js:3560-3605).
2. **Contradictory stop instructions** — "Persist until the user's request is fully resolved end-to-end" (`system-prompt.ts:748-756`) vs "Don't add features… report it and STOP" (`base.txt:15-16`); ambiguous tasks oscillate between over-eager and under-eager behavior.
3. **`toolCapBlock` informs only after the cut** — the cap warning renders only when tools were already trimmed (`system-prompt.ts:867-879`); the model learns about hidden tools after not using them.
4. **`terseDescription` strips USE/DON'T routing rules** — truncation at the first sentence (`descriptions.ts:206-215`) drops the anti-pattern guidance exactly in the compact catalogs (cap ≤ 64) where routing hints matter most.
5. **Prompt sections can list trimmed tools** — `nativeToolsSection`/`mcpSection` filter by *registered*, not by *visible under cap* (`system-prompt.ts:360-369`, `system-prompt.ts:913-947`), so the prompt can instruct the model to prefer a tool the catalog cut.
6. **Prompt loader does not escape `{{ }}`** — direct `{{key}}` replacement (`prompts/loader.ts:73-82`) can mangle prompts containing literal template syntax in code examples.
7. **Memory section is long and unconditional** — ~27 lines on four memory layers render in every prefix (`system-prompt.ts:968-995`), even in sessions where memory rarely fires; worth compressing into the dynamic injection instead.

## Preserve

Preserve these CodeStudio advantages:

- MCP code indexer and semantic tools.
- RAG doc tools.
- LSP diagnostics/references/symbol tools.
- Skills framework.
- Output recovery through get_tool_output.
- Tiered exposure as UX affordance, as long as it is not treated as security.

The prior Codex comparison already identifies many of these as things other agents do not have in codestudio_mcp-codebase/docs/research/codex-gap-analysis.md:67-77.

## Recommendation

Introduce a normalized ToolDescriptor contract used by registry, policy, dashboard and event log.

Suggested shape:

~~~ts
interface ToolDescriptorV2 {
  name: string;
  aliases?: string[];
  source: 'builtin' | 'mcp' | 'plugin' | 'skill' | 'company' | 'contextual';
  tier?: string;
  schema: unknown;
  description: string;
  promptHints?: string[];
  capabilities: ToolCapability[];
  resultPolicy: {
    maxBytes?: number;
    reduction?: 'none' | 'smart' | 'artifact';
  };
  execution: {
    mutatesWorkspace: boolean;
    requiresApproval?: boolean;
    requiresSandbox?: boolean;
    parallelSafe: boolean;
  };
}
~~~

This should wrap existing tools instead of rewriting them immediately.

## Backlog

| Priority | Item | Notes |
|---|---|---|
| S | Add ToolDescriptorV2 adapter over existing CoderTool | No behavior change. |
| S | Add capability metadata for built-in tools | Start with fs/shell/db/network/memory/mcp/agent. |
| S | Extend MCP aggregation to carry declared capabilities | Fall back to conservative unknown capability. |
| A | Make dashboard show source/tier/capability/policy separately | Avoid saying tier equals permission. |
| A | Add tests for hidden-by-tier execution semantics | Lock current behavior before changing. |
| B | Later enforce policy on capability, not name heuristic | Requires PolicyEngine shadow mode first. |

## References

- claudeopen/claude-code-src/agent/prompts.js:5995
- claudeopen/claude-code-src/agent/tools.js:17285-17323
- claudeopen/claude-code-src/agent/tools.js:17301-17312
- claudeopen/claude-code-src/agent/loop.js:709-738
- claudeopen/claude-code-src/agent/mcp.js:4846-5185
- codestudio_mcp-codebase/packages/code-agent/src/core/registry.ts:10-48
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:55-75
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:216-519
- codestudio_mcp-codebase/packages/code-agent/src/tools/tiers.ts:600-670
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:315-351
- codestudio_mcp-codebase/packages/code-agent/src/core/runner/nodes/executing-dispatch.ts:634-703
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:21-38
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:68-142
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:173-212
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-bridge.ts:338-386
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:1-16
- codestudio_mcp-codebase/packages/code-agent/src/tools/mcp-server-manager.ts:151-222
