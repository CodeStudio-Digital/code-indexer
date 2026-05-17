/**
 * Build a baseline tool registry for chat pipeline stages.
 *
 * Returns a flat `CoderTool[]` that the executor passes to `runSubagent`
 * as `parent.tools`. Each stage's own allowlist (validator: only
 * `submit_verdict`; agent: `EXPLORE_ALLOWLIST ∪ IMPLEMENT_ALLOWLIST`)
 * filters this set per stage.
 *
 * What's included (the native subset that doesn't need an MCP bridge,
 * sandbox container, or kanban service):
 *   - fs: read/write/edit/create_file, list_directory
 *   - shell: run_command
 *   - git: status/diff/log/add/commit/branch (read + safe writes)
 *   - web: fetch/search
 *   - glob, lsp, diagnostics — code-navigation aids
 *   - tool-output, todo, goal — workflow helpers
 *
 * What's NOT included:
 *   - Interactive tools (`ask_user`, `submit_plan`, `submit_tasks`) —
 *     subagents have no `ctx.runner` reference and these would no-op.
 *   - MCP-bridged tools — would require booting the McpToolBridge per
 *     pipeline run; reserved for a future enhancement.
 *   - Sandbox/database/docs/env tools — only valid inside builder
 *     sessions with a live container.
 *   - Subordinate/master tools — orchestrator-specific.
 *   - `expand_toolset` — pipelines are statically-allowlisted by stage,
 *     no on-demand promotion.
 */
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { shellTools } from '@mcp/code-agent/tools/shell.js';
import { gitTools } from '@mcp/code-agent/tools/git.js';
import { webTools } from '@mcp/code-agent/tools/web.js';
import { globTools } from '@mcp/code-agent/tools/glob.js';
import { lspTools } from '@mcp/code-agent/tools/lsp.js';
import { diagnosticsTools } from '@mcp/code-agent/tools/diagnostics.js';
import { todoTools } from '@mcp/code-agent/tools/todo.js';
import { toolOutputTools } from '@mcp/code-agent/tools/tool-output.js';

export function buildPipelineTools(): CoderTool[] {
  return [
    ...fsTools,
    ...shellTools,
    ...gitTools,
    ...webTools,
    ...globTools,
    ...lspTools,
    ...diagnosticsTools,
    ...todoTools,
    ...toolOutputTools,
  ];
}
