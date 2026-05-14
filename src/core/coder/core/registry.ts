import type { CoderTool, ToolContext, ToolResult } from './tool.js';

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
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    // Tag the recording filesystem port with the current tool name so its
    // audit log shows the actual mutating tool (apply_patch / edit_file /
    // multi_edit / etc.) instead of a generic "write_file" default.
    const fsPort = ctx.ports?.fs as { setCurrentTool?: (n: string) => void } | undefined;
    if (fsPort && typeof fsPort.setCurrentTool === 'function') {
      try { fsPort.setCurrentTool(name); } catch { /* never let telemetry break tool dispatch */ }
    }
    try {
      return await tool.handler(args, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `Tool '${name}' failed: ${msg}`, isError: true };
    }
  }
}
