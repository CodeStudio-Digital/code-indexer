import type { CodeIndexDB } from '@mcp/store/db.js';
import { loadConfig, type IndexerConfig } from '@mcp/shared/utils/config.js';
import {
  createIndexToolContext,
  type IndexToolContext,
  type IndexToolContextOverrides,
} from './context.js';
import { callIndexTool, type IndexToolCallResult } from './invoke.js';
import { indexCoreTools } from './index.js';
import type { IndexTool } from './tool.js';

/** A tool the port can serve: the core ones and transport-neutral tools defined elsewhere. */
export type IndexPortTool = Pick<IndexTool, 'name' | 'description' | 'inputSchema' | 'handler'>;

export interface IndexToolsPortDeps extends IndexToolContextOverrides {
  /** Defaults to the process configuration, read once per database handle. */
  config?: IndexerConfig;
  /** Documentation readers live with the agent; the host hands them in. */
  extraTools?: readonly IndexPortTool[];
}

export interface IndexToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * In-process implementation of the agent's index tools port. Each database
 * handle gets one service context; every call returns the same JSON a stdio
 * client would decode, so `undefined`, Date or class instances never leak.
 */
export function createIndexToolsPort(deps: IndexToolsPortDeps = {}) {
  const tools: readonly IndexPortTool[] = [...indexCoreTools, ...(deps.extraTools ?? [])];
  const registry = new Map<string, IndexPortTool>();
  for (const tool of tools) {
    if (registry.has(tool.name)) throw new Error(`Duplicate index tool name: ${tool.name}`);
    registry.set(tool.name, tool);
  }
  const contexts = new WeakMap<CodeIndexDB, IndexToolContext>();
  const contextFor = (db: CodeIndexDB): IndexToolContext => {
    let ctx = contexts.get(db);
    if (!ctx) {
      ctx = createIndexToolContext(deps.config ?? loadConfig(), db, {
        semanticSearchClient: deps.semanticSearchClient,
        mutationSinkWake: deps.mutationSinkWake,
      });
      contexts.set(db, ctx);
    }
    return ctx;
  };

  return {
    catalog(): IndexToolCatalogEntry[] {
      return [...tools]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(({ name, description, inputSchema }) => structuredClone({
          name, description, inputSchema: { ...inputSchema } as Record<string, unknown>,
        }));
    },
    async invoke(
      name: string,
      args: Record<string, unknown>,
      ctx: { db: CodeIndexDB; signal?: AbortSignal },
    ): Promise<IndexToolCallResult> {
      const result = await callIndexTool(registry.get(name), name, args, { ...contextFor(ctx.db), signal: ctx.signal });
      return JSON.parse(JSON.stringify(result)) as IndexToolCallResult;
    },
  };
}
