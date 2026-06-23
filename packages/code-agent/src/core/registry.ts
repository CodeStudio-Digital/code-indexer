import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { aliasNormalizationEnabled, normalizeToolArgs } from '@mcp/code-agent/core/tool-arg-aliases.js';
import { suggestToolName } from '@mcp/code-agent/core/tool-name-suggest.js';

/**
 * In-memory registry that holds the union of native + MCP tools available
 * in a coder session. The runner queries it to (a) build the tools array
 * sent to the provider and (b) dispatch tool calls returned by the model.
 */
export class ToolRegistry {
  private tools = new Map<string, CoderTool>();

  register(tool: CoderTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: CoderTool[]): void {
    for (const t of tools) this.register(t);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): CoderTool | undefined {
    return this.tools.get(name);
  }

  list(): CoderTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Remove all tools that do not satisfy the predicate.
   * Used by the Master agent filter to strip code-level tools.
   */
  filterInPlace(predicate: (tool: CoderTool) => boolean): void {
    for (const [name, tool] of this.tools) {
      if (!predicate(tool)) {
        this.tools.delete(name);
      }
    }
  }

  async invoke(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      // Deterministic recovery breadcrumbs: a close-name suggestion (telemetry
      // caught `grep_code` for `mcp__grep_code`) and the discovery tool when
      // this session actually has it registered.
      const suggestion = suggestToolName(name, Array.from(this.tools.keys()));
      const didYouMean = suggestion ? ` Did you mean \`${suggestion}\`?` : '';
      const discovery = this.tools.has('find_tools')
        ? ' Call find_tools to list available tools.'
        : '';
      return { content: `Unknown tool: ${name}.${didYouMean}${discovery}`, isError: true };
    }
    // Tag the recording filesystem port with the current tool name so its
    // audit log shows the actual mutating tool (apply_patch / edit_file /
    // multi_edit / etc.) instead of a generic "write_file" default.
    const fsPort = ctx.ports?.fs as { setCurrentTool?: (n: string) => void } | undefined;
    if (fsPort && typeof fsPort.setCurrentTool === 'function') {
      try { fsPort.setCurrentTool(name); } catch { /* never let telemetry break tool dispatch */ }
    }
    // Silently repair common wrong argument names (e.g. `file_path` → `path`)
    // against the tool's own schema before dispatch. Invisible to the model;
    // see tool-arg-aliases.ts. This is the single chokepoint for ALL tool
    // calls — the runner loop, subagents, and code_exec's nested calls.
    const finalArgs = aliasNormalizationEnabled() ? normalizeToolArgs(tool.parameters, args) : args;
    try {
      return await tool.handler(finalArgs, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `Tool '${name}' failed: ${msg}`, isError: true };
    }
  }
}
