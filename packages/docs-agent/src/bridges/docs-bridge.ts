/**
 * DocsResearchBridge — bridges the DocsAgent into the coder's tool surface.
 *
 * Without this, the coder still has the basic `rag_search_docs` (single-
 * shot hybrid search with snippets). With this, the coder also gets
 * `docs_deep_research(query, collections?)` — a multi-step research tool
 * that spins up a full DocsAgent sub-run and returns a structured result
 * with markdown + cited chunks + confidence.
 *
 * Wiring pattern mirrors `setGlobalDocSearch` in
 * `@mcp/code-agent/tools/rag-search-docs.ts`:
 *   - The bridge is a process-singleton, installed by the http-api host
 *     at boot via `setGlobalDocsResearcher`.
 *   - The tool reads the singleton at handler-time; if unset (e.g. tests),
 *     it returns an error explaining what's missing.
 *   - Hosts resolve availability with `getReadyDocsResearchTools` and pass
 *     `hostTools` to runCoder before policy filtering and catalogue sealing.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { DocStore } from '@mcp/store/doc-store.js';
import type { DocHybridSearch } from '@mcp/services/services/docs/index.js';
import type {
  PipelineProviderResolver,
  ResolveContext,
} from '@mcp/services/pipelines/index.js';
import { runDocsAgent } from '../index.js';
import type { DocsResearchResult } from '../types.js';
import type { SessionId } from '@mcp/session-storage';

export interface DocsResearchBridgeDeps {
  sessionStore: FsSessionStore;
  docStore: DocStore;
  docHybridSearch: DocHybridSearch;
  pipelineResolver: PipelineProviderResolver;
}

export interface RunResearchInput {
  query: string;
  collections?: string[];
  parentCoderSessionId?: SessionId | null;
  maxTurns?: number;
  signal?: AbortSignal;
  resolveContext?: ResolveContext;
}

/**
 * The bridge's only job is to spin up the DocsAgent and wait for its
 * result. It owns no state of its own — instances are cheap to create.
 */
export class DocsResearchBridge {
  constructor(private deps: DocsResearchBridgeDeps) {}

  async runResearch(input: RunResearchInput): Promise<DocsResearchResult> {
    const handle = await runDocsAgent(
      {
        query: input.query,
        collections: input.collections,
        triggeredBy: input.parentCoderSessionId != null ? 'coder' : 'user',
        parentCoderSessionId: input.parentCoderSessionId ?? null,
        maxTurns: input.maxTurns,
        signal: input.signal,
        resolveContext: input.resolveContext,
      },
      this.deps,
    );
    return handle.done;
  }
}

// ─── Process singleton ──────────────────────────────────────────────

let globalBridge: DocsResearchBridge | null = null;

/**
 * Install the bridge as the process-global. Call from `server.ts` after
 * constructing the bridge. Pass `null` to detach (used in tests).
 */
export function setGlobalDocsResearcher(bridge: DocsResearchBridge | null): void {
  globalBridge = bridge;
}

export function getGlobalDocsResearcher(): DocsResearchBridge | null {
  return globalBridge;
}

// ─── Coder tool: docs_deep_research ─────────────────────────────────

/**
 * The CoderTool the coder will use to escalate a query to the DocsAgent.
 * Registered through runCoder.hostTools before the attempt catalogue is sealed.
 */
export const docsDeepResearchTool: CoderTool = {
  name: 'docs_deep_research',
  description:
    'Run a multi-step research pass over the indexed documentation corpus, with a cited synthesis and evidence review.\n' +
    'USE when a single rag_search_docs hit is not enough — you need to read multiple chunks, refine the query, and synthesize an answer.\n' +
    'USE when the query is about a specific framework/library version and you need authoritative, cited material — not your training-cutoff knowledge.\n' +
    'COST: multiple provider turns and document reads. Pick this when the query justifies it (complex setup, security implications, version-specific APIs).\n' +
    'OUTPUT: markdown with footnotes + a list of cited chunk_ids + a self-reported confidence label.',
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language research question. Be specific about versions and constraints. Example: "how to add OAuth login with NextAuth in Next.js 15 server actions, with email + Google providers".',
      },
      collections: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional collection names to scope the research to. Omit to let the DocsAgent decide via docs_list_sources.',
      },
      max_turns: {
        type: 'number',
        description: 'Optional cap on agent turns. Default 6; clamped to [1, 6].',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: false,
  effectBoundary: 'nested',
  riskLevel: 'read',
  // Explicit > classifier. Deep research spins a full DocsAgent sub-run
  // (LLM rounds + rerank + chunk fetches) that legitimately takes several
  // minutes on a cold cache. The 30-min ceiling is generous but bounded so
  // a stuck bridge can't freeze the parent session.
  timeoutMs: 30 * 60_000,
  handler: async (args, ctx): Promise<ToolResult> => {
    const query = String(args.query ?? '').trim();
    if (!query) return err('query cannot be empty');
    const rawCollections = Array.isArray(args.collections) ? args.collections : [];
    const collections = rawCollections.filter((c): c is string => typeof c === 'string');
    const rawMaxTurns = Number(args.max_turns);
    const maxTurns = Number.isFinite(rawMaxTurns) && rawMaxTurns > 0
      ? Math.min(6, Math.max(1, Math.floor(rawMaxTurns)))
      : undefined;

    if (ctx.runtimeGeneration === 'rust_v1') {
      const port = ctx.ports?.docsResearch;
      if (!port || port.runtimeGeneration !== 'rust_v1'
        || port.ownerAgentRunId !== ctx.controlPlaneParentAgentRunId) {
        return err('Native documentation research requires its admitted tree owner; legacy research fallback is forbidden.');
      }
      return port.research({ query, collections: collections.length ? collections : undefined, maxTurns }, ctx);
    }
    const bridge = getGlobalDocsResearcher();
    if (!bridge) {
      return err('docs_deep_research is not configured: no DocsResearchBridge installed. Use rag_search_docs as a fallback (single-shot search).');
    }

    let result: DocsResearchResult;
    try {
      result = await bridge.runResearch({
        query,
        collections: collections.length > 0 ? collections : undefined,
        // Pull the parent coder session UUID from the ToolContext if the
        // host wired it (sub-runners and standalone runs leave it undefined).
        parentCoderSessionId:
          (ctx as { sessionId?: SessionId }).sessionId ?? null,
        maxTurns,
        signal: ctx.signal,
      });
    } catch (e) {
      return err(`docs_deep_research failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Render the result back to the coder. The dashboard renders a richer
    // version (clickable footnotes) by reading the docs bundle; the
    // tool-result content here is what the coder LLM sees,
    // so we keep it text-only with chunk_id back-references.
    const header = `# Research result (confidence: ${result.confidence ?? 'low'}, session ${result.sessionId})`;
    const footer = result.chunks_cited.length > 0
      ? `\n\n_Cited chunks: ${result.chunks_cited.join(', ')} · ${result.telemetry.turns} turns · ` +
        `${result.telemetry.searches} searches · ${result.telemetry.chunks_read} chunks read · ` +
        `${result.telemetry.duration_ms}ms_`
      : '\n\n_(no chunks cited — see error message above)_';
    const error = result.errorMessage ? `\n\n_Error: ${result.errorMessage}_` : '';

    return ok(`${header}\n\n${result.markdown}${error}${footer}`);
  },
};

/**
 * Tool builder for hosts preparing the catalogue before attempt admission.
 */
export function buildDocsDeepResearchTools(): CoderTool[] {
  return [docsDeepResearchTool];
}

/** Resolve availability before the attempt catalogue is sealed. */
export function getReadyDocsResearchTools(): CoderTool[] {
  return getGlobalDocsResearcher() ? buildDocsDeepResearchTools() : [];
}

/**
 * Compatibility helper for callers with an unsealed runner registry.
 * Current hosts use runCoder.hostTools before admission. Calling this after
 * registration is a no-op; it must never mutate a sealed attempt catalogue.
 */
interface RunnerLike {
  opts: { registry: { has?(name: string): boolean; registerAll(tools: CoderTool[]): void } };
}

export function installDocsDeepResearch(runner: unknown): boolean {
  if (!getGlobalDocsResearcher()) return false;
  try {
    const internal = runner as unknown as RunnerLike;
    if (internal.opts.registry.has?.(docsDeepResearchTool.name)) return true;
    internal.opts.registry.registerAll(buildDocsDeepResearchTools());
    return true;
  } catch (err) {
    console.warn(
      `[docs-agent] installDocsDeepResearch: failed to register tool — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
