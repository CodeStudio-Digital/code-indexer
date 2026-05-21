/**
 * docs_synthesize — outline + chunk_ids → markdown with footnote citations.
 *
 * The DocsAgent's main LLM (scorer_llm binding) decides WHAT to say; this
 * tool delegates the prose rendering to a cheaper LLM (classifier
 * binding) that turns the outline + cited passages into final markdown.
 * Splitting saves ~80% on tokens versus having the scorer write the
 * whole prose itself.
 *
 * The agent calls this BEFORE docs_finish. The tool returns the
 * synthesized markdown as its content; the agent can preview/edit it
 * before emitting docs_finish.
 */
import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DocStore, DocChunk } from '@mcp/store/doc-store.js';
import type {
  PipelineProviderResolver,
  ResolveContext,
} from '@mcp/services/pipelines/index.js';
import { pickChatFn } from '@mcp/services/quality/chat-dispatcher.js';
import { buildSynthesisPrompt } from '../prompts/synthesis-prompt.js';

export interface DocsSynthesizeToolDeps {
  docStore: DocStore;
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Increment-on-call counter for telemetry. */
  onCall?: () => void;
  /** Token bookkeeping callback. */
  onUsage?: (usage: { input_tokens: number; output_tokens: number; cost_usd?: number }) => void;
}

/** Max chunks the synth tool will accept in one call (cost + context cap). */
const MAX_SYNTH_CHUNKS = 20;

export function makeDocsSynthesizeTool(deps: DocsSynthesizeToolDeps): CoderTool {
  return {
    name: 'docs_synthesize',
    description:
      'Renders the final markdown answer from your outline + the chunks you decided to cite.\n' +
      'USE when you have collected enough material and are ready to compose the answer.\n' +
      'Pass the developer\'s original `query`, your `outline` (array of section headings, in order), and the `chunk_ids` to draw from (in the order they should appear as footnotes [^1] [^2] …).\n' +
      'Returns markdown with footnote citations and a bibliography. You can then pass this markdown to docs_finish.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The developer\'s original query (re-passed for the synthesizer).',
        },
        outline: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered section titles. Example: ["Setup NextAuth.js", "Server actions auth", "Token storage"].',
        },
        chunk_ids: {
          type: 'array',
          items: { type: 'number' },
          description: `Chunks to cite, in the order they should appear as footnotes. Max ${MAX_SYNTH_CHUNKS}.`,
        },
      },
      required: ['query', 'outline', 'chunk_ids'],
      additionalProperties: false,
    },
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    handler: async (args): Promise<ToolResult> => {
      deps.onCall?.();
      const query = String(args.query ?? '').trim();
      if (!query) return err('query cannot be empty');
      const rawOutline = Array.isArray(args.outline) ? args.outline : [];
      const outline = rawOutline
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (outline.length === 0) return err('outline must contain at least one section title');
      const rawChunkIds = Array.isArray(args.chunk_ids) ? args.chunk_ids : [];
      const chunkIds = rawChunkIds
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (chunkIds.length === 0) return err('chunk_ids must contain at least one chunk id');
      if (chunkIds.length > MAX_SYNTH_CHUNKS) {
        return err(`chunk_ids has ${chunkIds.length} entries — max ${MAX_SYNTH_CHUNKS}. Pick the most relevant ones.`);
      }

      // Hydrate chunks (preserving the caller's order).
      const all = deps.docStore.getChunksByIds(chunkIds);
      const byId = new Map(all.map((c) => [c.id, c]));
      const chunks: DocChunk[] = [];
      const missing: number[] = [];
      for (const id of chunkIds) {
        const c = byId.get(id);
        if (c) chunks.push(c);
        else missing.push(id);
      }
      if (chunks.length === 0) {
        return err(`None of the chunk_ids resolved to chunks (verify they came from a recent docs_search). Missing: ${missing.join(', ')}`);
      }

      // Resolve the synthesizer binding (classifier role on docs_research).
      const binding = await deps.resolver.resolveOrNull(
        'docs_research',
        'classifier',
        deps.resolveContext ?? {},
      );
      if (!binding) {
        return err(
          'docs_synthesize is not configured: no provider binding for docs_research/classifier. ' +
            'Ask an admin to configure one in the admin panel, then retry. ' +
            'Meanwhile, you can manually assemble the markdown using the chunks you read and emit docs_finish directly.',
        );
      }

      const { system, user } = buildSynthesisPrompt({ query, outline, chunks });
      const chat = pickChatFn(binding);
      let response;
      try {
        response = await chat(binding, [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
      } catch (e) {
        return err(`docs_synthesize LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      const markdown = stripWrappingFences(response.content).trim();
      if (!markdown) {
        return err('Synthesizer returned an empty response. Try again with a tighter outline or fewer chunks.');
      }

      // Token accounting — the chat dispatcher surface includes usage in
      // some adapter shapes. Be defensive about what's available.
      const usage = extractUsage(response);
      if (usage) deps.onUsage?.(usage);

      const note = missing.length > 0
        ? `\n\n_(Note: ${missing.length} chunk id${missing.length === 1 ? ' was' : 's were'} missing — synthesized from the remaining ${chunks.length}.)_`
        : '';
      return ok(`${markdown}${note}`);
    },
  };
}

function stripWrappingFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return s;
}

function extractUsage(
  response: unknown,
): { input_tokens: number; output_tokens: number; cost_usd?: number } | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as { usage?: unknown };
  if (!r.usage || typeof r.usage !== 'object') return null;
  const u = r.usage as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const cost = Number(u.cost_usd ?? 0);
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    cost_usd: Number.isFinite(cost) ? cost : undefined,
  };
}
