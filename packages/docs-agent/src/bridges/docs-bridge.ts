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
 *   - The coder runner picks up the tool via `onRunnerReady` (see
 *     apps/http-api/workers/coder-worker.ts). Zero edits to @mcp/code-agent.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import type { DocHybridSearch } from '@mcp/services/services/docs/index.js';
import type {
  PipelineProviderResolver,
  ResolveContext,
} from '@mcp/services/pipelines/index.js';
import { runDocsAgent } from '../index.js';
import type { DocsResearchResult } from '../types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export interface DocsResearchBridgeDeps {
  db: DB;
  docStore: DocStore;
  docHybridSearch: DocHybridSearch;
  pipelineResolver: PipelineProviderResolver;
}

export interface RunResearchInput {
  query: string;
  collections?: string[];
  parentCoderSessionId?: number | null;
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
 * Registered on the coder's `ToolRegistry` via the `onRunnerReady` hook
 * in `apps/http-api/workers/coder-worker.ts`. Zero edits to @mcp/code-agent.
 */
export const docsDeepResearchTool: CoderTool = {
  name: 'docs_deep_research',
  description:
    'Spin up the DocsAgent to do a multi-step research pass over the indexed doc corpus.\n' +
    'USE when a single rag_search_docs hit is not enough — you need to read multiple chunks, refine the query, and synthesize an answer.\n' +
    'USE when the query is about a specific framework/library version and you need authoritative, cited material — not your training-cutoff knowledge.\n' +
    'COST: ~5-15s wall-clock and 5-10× the tokens of rag_search_docs. Pick this when the query justifies it (complex setup, security implications, version-specific APIs).\n' +
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
        description: 'Optional cap on agent turns. Default 5; clamped to [1, 8].',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  mutates: false,
  parallelSafe: true,
  riskLevel: 'read',
  handler: async (args, ctx): Promise<ToolResult> => {
    const query = String(args.query ?? '').trim();
    if (!query) return err('query cannot be empty');
    const bridge = getGlobalDocsResearcher();
    if (!bridge) {
      return err(
        'docs_deep_research is not configured: no DocsResearchBridge installed. ' +
          'Use rag_search_docs as a fallback (single-shot search).',
      );
    }
    const rawCollections = Array.isArray(args.collections) ? args.collections : [];
    const collections = rawCollections.filter((c): c is string => typeof c === 'string');
    const rawMaxTurns = Number(args.max_turns);
    const maxTurns = Number.isFinite(rawMaxTurns) && rawMaxTurns > 0
      ? Math.min(8, Math.max(1, Math.floor(rawMaxTurns)))
      : undefined;

    let result: DocsResearchResult;
    try {
      result = await bridge.runResearch({
        query,
        collections: collections.length > 0 ? collections : undefined,
        // Pull the parent coder session id from the ToolContext if the
        // host wired it (sub-runners and standalone runs leave it undefined).
        parentCoderSessionId: (ctx as { sessionId?: number }).sessionId ?? null,
        maxTurns,
        signal: ctx.signal,
      });
    } catch (e) {
      return err(`docs_deep_research failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Render the result back to the coder. The dashboard renders a richer
    // version (clickable footnotes) by reading `docs_research_sessions`
    // directly; the tool-result content here is what the coder LLM sees,
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
 * Convenience builder so the http-api host can install the tool inside
 * the `onRunnerReady` hook. Kept symmetric with `ragSearchDocsTools`.
 */
export function buildDocsDeepResearchTools(): CoderTool[] {
  return [docsDeepResearchTool];
}

/**
 * Install docs_deep_research onto an already-constructed CoderRunner.
 *
 * The runner's `ToolRegistry` is held privately on `opts.registry` —
 * code-agent does not expose a public `addTool` method on the runner.
 * Rather than fork code-agent or thread the docs tool through every
 * `runCoder` call site, we bypass the private boundary at the integration
 * layer. This is the canonical pattern for cross-cutting "extra tools"
 * the host wants the agent to have without modifying @mcp/code-agent.
 *
 * Type-cast safety: `RunnerLike` is a structural shape that matches the
 * runtime layout of CoderRunner.opts.registry. If code-agent ever
 * refactors that path, this helper's `as unknown as RunnerLike` cast
 * will compile but fail at runtime with a clear "registerAll is not a
 * function" — easy to diagnose and patch here.
 */
interface RunnerLike {
  opts: { registry: { registerAll(tools: CoderTool[]): void } };
}

export function installDocsDeepResearch(runner: unknown): boolean {
  if (!getGlobalDocsResearcher()) return false;
  try {
    const internal = runner as unknown as RunnerLike;
    internal.opts.registry.registerAll(buildDocsDeepResearchTools());
    return true;
  } catch (err) {
    console.warn(
      `[docs-agent] installDocsDeepResearch: failed to register tool — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
