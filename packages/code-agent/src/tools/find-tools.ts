import type { CoderTool, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { getToolTier, type ToolTier } from '@mcp/code-agent/tools/tiers.js';
import {
  getToolText,
  passesRelaxed,
  passesStrict,
  scoreTool,
  tokenizeQuery,
  topLevelParams,
  type ToolScore,
} from './find-tools-score.js';

/**
 * find_tools — lazy tool discovery (Camada 3, "Tool Search Tool" pattern).
 *
 * Why this exists: the bootstrap tier ships ~30 tools as JSON schema on every
 * provider call (~5K tokens). Anything in `navigate` / `admin` / a custom MCP
 * tier is invisible until the agent calls `expand_toolset`, but to call it the
 * agent has to know the tier exists AND know which tier hides which tool. That
 * is exactly the kind of meta-knowledge a fresh model lacks.
 *
 * `find_tools(query)` lets the agent ask: "what tool do I need for X?" and
 * receive a small list of candidates with their tier, source, and full
 * description. A strong top hidden match is promoted automatically so its
 * full provider schema is available on the NEXT turn. The model can instead
 * call `expand_toolset(<tier>)` when it needs a whole family of tools.
 *
 * Discovery does NOT promote a whole tier. It promotes at most one strong
 * hidden result into a bounded LRU working set: a new capability replaces the
 * least-recently-used dynamic pin when the window is full, while configured
 * agent pins remain permanent. Dispatch can still execute and pin an explicit
 * hidden call for providers that permit undeclared tool names.
 *
 * Implementation notes:
 *  - Cheap lexical match over three fields — name parts, TOP-LEVEL parameter
 *    names, and description words (see find-tools-score.ts). No vector store
 *    dependency — this tool is the cheap path; if you need semantic search
 *    over code, use mcp__search.
 *  - Two passes: a strict pass (coverage + an anchor hit, or full coverage on
 *    a >=3-token query), and — only when strict comes back empty — a relaxed
 *    pass whose candidates are clearly labeled weak. A near-miss list the
 *    agent can learn the landscape from beats a dead end.
 *  - Known imprecision: ubiquitous params ("query", "path", "limit") anchor
 *    many tools on single-token queries naming them — honest behavior (those
 *    tools DO take that arg), flat-ranked and capped at `limit`.
 *  - Returns up to `limit` candidates (default 5, cap 10) — keep the result
 *    small so it doesn't itself become a token tax.
 */
export function buildFindToolsTool(
  registry: ToolRegistry,
  tierOverrides?: ReadonlyMap<string, ToolTier>,
  options?: { beforeSearch?: () => Promise<void> },
): CoderTool {
  return {
    name: 'find_tools',
    source: 'native',
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    executionClass: 'control',
    effectBoundary: 'control',
    description:
      'Find tools by capability — searches tool NAMES, DESCRIPTIONS, and ARGUMENT names ' +
      '(lazy discovery for tools NOT in your visible list).\n\n' +
      'Use when you suspect a tool exists for a task but cannot see it in your current tools array. ' +
      'Returns up to 5 candidates with their `name`, `tier`, `source`, argument summary, and a ' +
      'short description. A strong top hidden match is activated automatically for your next turn. ' +
      '`expand_toolset(<tier>)` unlocks a ' +
      'whole tier at once when you need several of its tools.\n\n' +
      'QUERY TIPS: concept nouns ("worktree", "spec revision"), verbs ("edit", "spawn"), and exact ' +
      'argument names seen in other tool results ("evolution_id") all match; filler words are ' +
      'ignored. When nothing matches strongly, the closest weak candidates are returned, labeled ' +
      'with why each one matched.\n\n' +
      'WHEN TO USE: before guessing tool names, before calling expand_toolset speculatively, when ' +
      'a generic search/edit/git/web/lsp/mcp capability is needed but no matching tool is visible.\n\n' +
      "DON'T: use this when you already see the tool you need in your tools array — call it directly. " +
      'Avoid for things that are obviously code-search; use mcp__search/grep_code instead.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What you need — concept nouns, verbs, or exact argument names work better than full ' +
            'sentences (e.g. "edit a file", "evolution_id", "create git commit"). Names, ' +
            'descriptions, and argument names are all searched; filler words are ignored.',
        },
        limit: {
          type: 'number',
          description: 'Max candidates to return (default 5, cap 10).',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args, ctx): Promise<ToolResult> => {
      ctx.signal?.throwIfAborted();
      ctx.ports?.discovery?.assertCurrent();
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return err('find_tools: `query` is required and must be non-empty.');
      if (query.length > 2_000) return err('find_tools: query exceeds 2000 characters.');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 10)) {
        return err('find_tools: limit must be an integer from 1 to 10.');
      }
      const limit = (args.limit as number | undefined) ?? 5;

      // Pull active tiers + pins from the runner via ctx if available.
      // Subagents and tests may not have a runner — in that case treat all
      // tiers as visible (no "hidden" tag) so the result is still useful.
      const runner = ctx.runner as
        | {
          activeTiers?: ReadonlySet<ToolTier> | null;
          pinnedTools?: ReadonlySet<string>;
          visibleToolNames?: ReadonlySet<string> | null;
          promoteTool?: (name: string) => string[];
          }
        | undefined;
      const active = runner?.activeTiers ?? null;
      const pinned = runner?.pinnedTools;
      const visibleToolNames = ctx.ports?.discovery?.visibleToolNames ?? runner?.visibleToolNames;

      const tokens = tokenizeQuery(query);
      if (tokens.length === 0) {
        return err('find_tools: query has no usable tokens.');
      }

      // External MCP servers can become ready after this runner was built
      // (notably Unity's editor broker). Reconcile before reading the mutable
      // registry so the same live session can discover the late catalogue.
      if (options?.beforeSearch && !registry.isSealed) {
        try {
          await options.beforeSearch();
        } catch (e) {
          console.warn(
            `[find_tools] catalogue refresh failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      ctx.signal?.throwIfAborted();
      ctx.ports?.discovery?.assertCurrent();

      // Coverage knob: fraction of distinct query tokens that must hit for
      // the strict pass (default 0.5 — see passesStrict/passesRelaxed).
      const coverage = 0.5;

      type Scored = {
        name: string;
        tier: ToolTier;
        source: string;
        description: string;
        params: string;
        score: ToolScore;
        visible: boolean;
      };
      const all: Scored[] = [];
      for (const t of registry.list()) {
        if (ctx.ports?.discovery && !visibleToolNames?.has(t.name)) continue;
        const score = scoreTool(tokens, getToolText(t));
        if (score.hitCount === 0) continue;
        const tier = getToolTier(t.name, tierOverrides);
        all.push({
          name: t.name,
          tier,
          source: t.source,
          description: t.description ?? '',
          params: paramSummary(t.parameters),
          score,
          visible: visibleToolNames
            ? visibleToolNames.has(t.name)
            : active
              ? active.has(tier) || !!pinned?.has(t.name)
              : true,
        });
      }

      // Pass A (strict), and only when it comes back empty, pass B (relaxed,
      // labeled weak). One scoring sweep, two filters.
      const strict = all.filter((c) => passesStrict(c.score, tokens.length, coverage));
      const weak = strict.length === 0;
      const pool = weak
        ? all.filter((c) => passesRelaxed(c.score, tokens.length, coverage))
        : strict;

      if (pool.length === 0) {
        return ok(
          `No tools matched "${query}". Retry with exact argument names you know ` +
            `(e.g. "evolution_id"), concept nouns ("worktree", "spec revision"), or verbs ` +
            `("edit", "spawn") — or run list_tools() inside code_exec for the full catalog.`,
        );
      }

      // Sort by score desc, then prefer hidden tools (the whole point of this
      // tool is surfacing tools the agent cannot already see). Tie-break by
      // alphabetical name for determinism.
      pool.sort((a, b) => {
        if (b.score.total !== a.score.total) return b.score.total - a.score.total;
        if (a.visible !== b.visible) return a.visible ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      const top = pool.slice(0, limit);

      // A provider can only emit tool calls whose schemas it received. The
      // old "call a hidden tool directly" hint therefore created a catch-22
      // on strict providers: discovery named the tool, but never put its
      // schema into the next request. Promote only the strong top result —
      // never weak/ambiguous matches — keeping discovery precise and bounded.
      const autoPromoted = !weak && top[0] && !top[0].visible && runner?.promoteTool
        ? top[0]
        : null;
      const evicted = autoPromoted && runner?.promoteTool
        ? runner.promoteTool(autoPromoted.name)
        : [];

      // Compact rendering — one line per candidate. The agent reads this in
      // its tool result; verbose multi-paragraph output here would defeat the
      // economy goal of Camada 3. Weak candidates always say WHY they matched
      // (strong ones only when the match came via an argument name).
      const renderCandidate = (r: Scored): string => {
        const visTag = r.visible
          ? ''
          : autoPromoted?.name === r.name
            ? ' [activated for next turn]'
            : ` [hidden — refine search to activate or expand_toolset('${r.tier}')]`;
        // Trim description to one sentence-ish for compactness.
        const shortDesc = r.description.split(/(?<=[.!?])\s+/)[0]?.slice(0, 180) ?? '';
        const argsTag = r.params ? ` (args: ${r.params})` : '';
        let matchTag = '';
        if (r.score.matchedParams.length > 0 && !r.score.nameHit) {
          matchTag = ` [matched arg: ${r.score.matchedParams.slice(0, 2).join(', ')}]`;
        } else if (weak) {
          matchTag = r.score.nameHit ? ' [matched: name]' : ' [matched: description only]';
        }
        return `- ${r.name} (tier=${r.tier}, source=${r.source})${argsTag}${matchTag}${visTag}: ${shortDesc}`;
      };

      const lines: string[] = [
        weak
          ? `No strong matches for "${query}". Closest candidates (weak matches):`
          : `Top ${top.length} tool match${top.length === 1 ? '' : 'es'} for "${query}":`,
      ];
      for (const r of top) lines.push(renderCandidate(r));
      // Steer the follow-up when the top candidate is hidden.
      if (autoPromoted) {
        lines.push('');
        lines.push(
          `Activated ${autoPromoted.name} for the next turn` +
            (evicted.length > 0 ? ` (replaced least-recently-used: ${evicted.join(', ')})` : '') +
            `. Call it directly with the args above. Use \`expand_toolset({ tier: "${autoPromoted.tier}" })\` ` +
            `instead if you need several ${autoPromoted.tier}-tier tools.`,
        );
      } else {
        const firstHidden = top.find((r) => !r.visible);
        if (firstHidden) {
          lines.push('');
          lines.push(firstHidden.tier === 'bootstrap'
            ? 'Hint: refine the query to auto-activate one strong match.'
            : `Hint: use \`expand_toolset({ tier: "${firstHidden.tier}" })\` if you need several ` +
              `${firstHidden.tier}-tier tools. Refine the query to auto-activate one strong match.`);
        }
      }
      if (weak) {
        lines.push('');
        lines.push(
          'If none fit, retry with different words: exact argument names you know, concept nouns, ' +
            'or verbs — or run list_tools() inside code_exec for the full catalog.',
        );
      }
      return ok(lines.join('\n'));
    },
  };
}

/**
 * One-line `name:type` argument summary from a JSON schema — required params
 * first, optional ones suffixed `?`. Capped ~90 chars so a wide schema can't
 * bloat the discovery result. Exists so a model can call a HIDDEN tool with
 * correct args on the first try (it never saw the tool's full schema).
 *
 * Exported for reuse by code_exec's in-sandbox `list_tools()` helper, which
 * renders the same compact arg summary for the full (tier-agnostic) catalog.
 */
export function paramSummary(schema: JsonSchema | undefined): string {
  const params = topLevelParams(schema);
  if (params.length === 0) return '';
  params.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  const parts: string[] = [];
  for (const p of params) {
    const next = `${p.name}${p.required ? '' : '?'}:${p.typeLabel}`;
    if ([...parts, next].join(', ').length > 90) {
      parts.push('…');
      break;
    }
    parts.push(next);
  }
  return parts.join(', ');
}
