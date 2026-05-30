/**
 * Pure plugin-execution runtime. Runs INSIDE the plugin worker thread
 * (apps/http-api/workers/plugin-worker.ts), but kept dependency-light and
 * spawn-free here so it unit-tests directly: load built plugin bundles via
 * dynamic import, index their tools, dispatch by name.
 */
import { pathToFileURL } from 'node:url';
import type {
  PluginModule,
  ContributedTool,
  PluginToolContext,
  PluginToolResult,
} from '@mcp/plugin-sdk';

export type PluginToolMap = Map<string, ContributedTool>;

/** Collision-proof composite key for the (namespace, toolName) pair. */
function toolKey(ns: string, name: string): string {
  return JSON.stringify([ns, name]);
}

export interface PluginBundleRef {
  namespace: string;
  /** Absolute path to the built ESM bundle (dist/plugin.js). */
  file: string;
}

/** Dynamic-import each bundle's default `PluginModule` and index its tools. */
export async function loadPluginTools(bundles: PluginBundleRef[]): Promise<PluginToolMap> {
  const map: PluginToolMap = new Map();
  for (const b of bundles) {
    let mod: { default?: PluginModule };
    try {
      mod = (await import(pathToFileURL(b.file).href)) as { default?: PluginModule };
    } catch (e) {
      console.warn(
        `[plugin-runtime] failed to load ${b.namespace} (${b.file}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      continue;
    }
    const pluginModule = mod.default;
    if (!pluginModule || !Array.isArray(pluginModule.tools)) continue;
    for (const tool of pluginModule.tools) {
      map.set(toolKey(b.namespace, tool.name), tool);
    }
  }
  return map;
}

/** Run one tool handler, normalizing thrown errors into an error result. */
export async function invokePluginTool(
  map: PluginToolMap,
  namespace: string,
  name: string,
  args: Record<string, unknown>,
  ctx: PluginToolContext,
): Promise<PluginToolResult> {
  const tool = map.get(toolKey(namespace, name));
  if (!tool) {
    return { content: `plugin tool not found: ${namespace}/${name}`, isError: true };
  }
  try {
    const r = await tool.handler(args, ctx);
    return { content: String(r.content ?? ''), isError: r.isError, data: r.data };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}
