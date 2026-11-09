/**
 * Synthesize agent tools from a plugin's declared tool contributions. Each
 * becomes a `CoderTool` named `plugin__<namespace>__<name>` whose handler
 * dispatches to an injected invoker (the plugin worker in Phase 2b). The
 * invoker seam keeps this pure + unit-testable with no worker spawn.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import type { ToolResult, ToolSourceTruncation } from "@mcp/agent-runtime-host/tool-result.js";
import type { PluginToolDecl } from '@mcp/plugin-sdk';
import { sanitizeUntrustedCapabilityMetadata } from '@mcp/shared';

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
) => Promise<{
  content: string;
  isError?: boolean;
  sourceTruncations?: unknown;
}>;

function sanitizePluginSourceTruncations(value: unknown): ToolSourceTruncation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sanitized: ToolSourceTruncation[] = [];
  for (const candidate of value.slice(0, 16)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const { outputId: _untrusted, ...source } = candidate as Record<string, unknown>;
    sanitized.push(source as unknown as ToolSourceTruncation);
  }
  return sanitized.length > 0 ? sanitized : undefined;
}

/** Stable, collision-resistant tier id used by `expand_toolset`. */
export function pluginToolTierId(namespace: string): string {
  return `plugin:${namespace}`;
}

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
      const sanitized = sanitizeUntrustedCapabilityMetadata(
        decl.description,
        toJsonSchema(decl.parameters),
      );
      if (sanitized.schemaError) {
        console.warn(`[plugin] omitted tool "${plugin.namespace}/${decl.name}": ${sanitized.schemaError}`);
        continue;
      }
      out.push({
        name: `plugin__${plugin.namespace}__${decl.name}`,
        description: sanitized.description,
        parameters: sanitized.schema as JsonSchema,
        source: 'mcp_external',
        capabilityProvenance: {
          kind: 'plugin',
          providerId: plugin.namespace,
          provenanceRef: `plugin:${plugin.namespace}`,
        },
        runtimeTier: {
          id: pluginToolTierId(plugin.namespace),
          displayName: `plugin ${plugin.namespace}`,
        },
        ...(decl.outputPolicy ? { outputPolicy: decl.outputPolicy } : {}),
        // Unattested plugin metadata cannot lower the local safety posture.
        mutates: true,
        parallelSafe: false,
        riskLevel: decl.riskLevel === 'execute' || decl.riskLevel === 'admin'
          ? decl.riskLevel
          : 'write',
        handler: async (args, ctx): Promise<ToolResult> => {
          const r = await invoke(plugin.namespace, decl.name, args, {
            projectName: ctx.projectName,
            cwd: ctx.cwd,
          });
          return {
            content: r.content,
            isError: r.isError,
            // Plugin workers do not own the runner's ToolOutputStore. Never
            // trust a plugin-supplied outputId as an authoritative snapshot:
            // the central finalizer will persist the actual raw result itself.
            sourceTruncations: sanitizePluginSourceTruncations(r.sourceTruncations),
          };
        },
      });
    }
  }
  return out;
}
