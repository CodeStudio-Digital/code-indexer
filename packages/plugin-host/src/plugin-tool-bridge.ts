/**
 * Synthesize agent tools from a plugin's declared tool contributions. Each
 * becomes a `CoderTool` named `plugin__<namespace>__<name>` whose handler
 * dispatches to an injected invoker (the plugin worker in Phase 2b). The
 * invoker seam keeps this pure + unit-testable with no worker spawn.
 */
import type { CoderTool, JsonSchema, ToolResult } from '@mcp/code-agent/core/tool.js';
import type { PluginToolDecl } from '@mcp/plugin-sdk';

export interface EnabledPlugin {
  namespace: string;
  tools: PluginToolDecl[];
}

/** Per-invocation context forwarded to the worker (it builds the handler ctx). */
export interface PluginInvokeContext {
  projectName: string | null;
  cwd: string;
}

export type PluginToolInvoker = (
  namespace: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx: PluginInvokeContext,
) => Promise<{ content: string; isError?: boolean }>;

function toJsonSchema(p: Record<string, unknown> | undefined): JsonSchema {
  if (p && p.type === 'object' && typeof p.properties === 'object' && p.properties !== null) {
    return p as unknown as JsonSchema;
  }
  return { type: 'object', properties: {} };
}

export function buildPluginTools(
  plugins: EnabledPlugin[],
  invoke: PluginToolInvoker,
): CoderTool[] {
  const out: CoderTool[] = [];
  for (const plugin of plugins) {
    for (const decl of plugin.tools) {
      const mutates = decl.mutates ?? true;
      out.push({
        name: `plugin__${plugin.namespace}__${decl.name}`,
        description: decl.description,
        parameters: toJsonSchema(decl.parameters),
        source: 'mcp_external',
        mutates,
        parallelSafe: !mutates,
        riskLevel: decl.riskLevel ?? (mutates ? 'write' : 'read'),
        handler: async (args, ctx): Promise<ToolResult> => {
          const r = await invoke(plugin.namespace, decl.name, args, {
            projectName: ctx.projectName,
            cwd: ctx.cwd,
          });
          return { content: r.content, isError: r.isError };
        },
      });
    }
  }
  return out;
}
