import type { CoderTool, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { getToolTier, type ToolTier } from '@mcp/code-agent/tools/tiers.js';

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
 * description. The model can then call `expand_toolset(<tier>)` confidently
 * (or skip it entirely if the candidate is already visible).
 *
 * Discovery does NOT promote any tier — it's read-only. From here the agent
 * has two paths: call the discovered tool DIRECTLY (dispatch executes hidden
 * registered tools and pins them into the visible list — see the pin
 * mechanism in executing-dispatch.ts), or `expand_toolset(<tier>)` to unlock
 * the whole tier. Both grow the tool array monotonically between turns, so
 * prefix-cache stability is preserved either way. Known imprecision: a
 * tier-visible tool that was cap-cut for a small-catalog model still shows
 * as visible here — harmless, a direct call works and pins it.
 *
 * Implementation notes:
 *  - Cheap lexical match: substring + per-token overlap. No vector store
 *    dependency — this tool is the cheap path; if you need semantic search
 *    over code, use mcp__search.
 *  - Returns up to `limit` candidates (default 5, cap 10) — keep the result
 *    small so it doesn't itself become a token tax.
 *  - Excludes tools already in the active tier (those are visible already).
 */
export function buildFindToolsTool(
  registry: ToolRegistry,
  tierOverrides?: ReadonlyMap<string, ToolTier>,
): CoderTool {
  return {
    name: 'find_tools',
    source: 'native',
    mutates: false,
    parallelSafe: true,
    description:
      'Find tools by description (lazy discovery for tools NOT in your visible list).\n\n' +
      'Use when you suspect a tool exists for a task but cannot see it in your current tools array. ' +
      'Returns up to 5 candidates with their `name`, `tier`, `source`, argument summary, and a ' +
      'short description. You can call a discovered tool DIRECTLY even while hidden — it executes ' +
      'and is pinned into your visible list from the next turn. `expand_toolset(<tier>)` unlocks a ' +
      'whole tier at once when you need several of its tools.\n\n' +
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
            'Free-text description of the capability you need (e.g. "edit a file", "run shell command", ' +
            '"find references to a symbol", "create a git commit"). The matcher is lexical — keywords ' +
            'and verbs work better than full sentences.',
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
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return err('find_tools: `query` is required and must be non-empty.');
      const limit = Math.max(1, Math.min(10, Number(args.limit ?? 5) || 5));

      // Pull active tiers + pins from the runner via ctx if available.
      // Subagents and tests may not have a runner — in that case treat all
      // tiers as visible (no "hidden" tag) so the result is still useful.
      const runner = ctx.runner as
        | { activeTiers?: ReadonlySet<ToolTier> | null; pinnedTools?: ReadonlySet<string> }
        | undefined;
      const active = runner?.activeTiers ?? null;
      const pinned = runner?.pinnedTools;
      const tools = registry.list();

      // Tokenize query into lowercase keywords; keep words >=2 chars.
      // We split on non-alphanumeric INCLUDING underscores so that compound
      // names like "spawn_agent" become ["spawn", "agent"] — same shape as
      // `nameParts` below. Without this, the whole-part bonus never fires
      // for snake_case queries and substring fallback dominates.
      const qTokens = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2);
      if (qTokens.length === 0) {
        return err('find_tools: query has no usable tokens.');
      }

      // Score each tool:
      //   - whole snake_case part match in NAME: +4 (e.g. "agent" hits "spawn_agent" parts)
      //   - substring match in NAME (fallback):  +2 (catches "agent" inside "subagent")
      //   - substring match in DESCRIPTION:      +1
      // Then enforce a minimum score so weak fuzzy hits don't crowd the top-N:
      //   - 1 token   → need >= 3 (i.e. at least a name match)
      //   - N tokens  → need >= max(3, ceil(N * 1.5))
      // And a floor for pure-description matches: at least 2 desc hits when
      // the name didn't match at all — kills "agent" in a JSON example
      // bleeding into a totally unrelated tool's description.
      const ratioOverride = Number(process.env.CODER_FIND_TOOLS_MIN_SCORE_RATIO ?? '1.5');
      const ratio = Number.isFinite(ratioOverride) && ratioOverride > 0 ? ratioOverride : 1.5;
      const minScore = qTokens.length === 1
        ? 3
        : Math.max(3, Math.ceil(qTokens.length * ratio));

      type Scored = {
        name: string;
        tier: ToolTier;
        source: string;
        description: string;
        params: string;
        score: number;
        visible: boolean;
      };
      const scored: Scored[] = [];
      for (const t of tools) {
        const name = t.name.toLowerCase();
        const desc = (t.description ?? '').toLowerCase();
        const nameParts = name.split(/[^a-z0-9]+/).filter(Boolean);
        let nameScore = 0;
        let descScore = 0;
        for (const tok of qTokens) {
          if (nameParts.includes(tok)) nameScore += 4;
          else if (name.includes(tok)) nameScore += 2;
          if (desc.includes(tok)) descScore += 1;
        }
        const score = nameScore + descScore;
        if (score < minScore) continue;
        // Pure-description matches need at least 2 desc hits — otherwise a
        // single incidental token in an example/snippet ranks alongside
        // real candidates.
        if (nameScore === 0 && descScore < 2) continue;
        const tier = getToolTier(t.name, tierOverrides);
        const visible = active ? active.has(tier) || !!pinned?.has(t.name) : true;
        scored.push({
          name: t.name,
          tier,
          source: t.source,
          description: t.description ?? '',
          params: paramSummary(t.parameters),
          score,
          visible,
        });
      }

      if (scored.length === 0) {
        return ok(
          `No tools matched "${query}". Try simpler verbs ("edit", "run", "search") or ` +
            `mcp__search for code-level concepts.`,
        );
      }

      // Sort by score desc, then prefer hidden tools (the whole point of this
      // tool is surfacing tools the agent cannot already see). Tie-break by
      // alphabetical name for determinism.
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.visible !== b.visible) return a.visible ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      const top = scored.slice(0, limit);

      // Compact rendering — one line per candidate. The agent reads this in
      // its tool result; verbose multi-paragraph output here would defeat the
      // economy goal of Camada 3.
      const lines: string[] = [`Top ${top.length} tool match${top.length === 1 ? '' : 'es'} for "${query}":`];
      for (const r of top) {
        const visTag = r.visible
          ? ''
          : ` [hidden — call it directly (it will be pinned into your toolset) or expand_toolset('${r.tier}')]`;
        // Trim description to one sentence-ish for compactness.
        const shortDesc = r.description.split(/(?<=[.!?])\s+/)[0]?.slice(0, 180) ?? '';
        const argsTag = r.params ? ` (args: ${r.params})` : '';
        lines.push(`- ${r.name} (tier=${r.tier}, source=${r.source})${argsTag}${visTag}: ${shortDesc}`);
      }
      // Steer the follow-up when the top candidate is hidden.
      const firstHidden = top.find((r) => !r.visible);
      if (firstHidden) {
        lines.push('');
        lines.push(
          `Hint: call ${firstHidden.name} directly with the args above — it executes and joins your ` +
            `toolset next turn. Use \`expand_toolset({ tier: "${firstHidden.tier}" })\` instead if you ` +
            `need several ${firstHidden.tier}-tier tools.`,
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
  const s = schema as
    | { properties?: Record<string, { type?: string | string[] }>; required?: string[] }
    | undefined;
  const props = s?.properties;
  if (!props) return '';
  const required = new Set(s?.required ?? []);
  const keys = Object.keys(props).sort(
    (a, b) => Number(required.has(b)) - Number(required.has(a)) || a.localeCompare(b),
  );
  const parts: string[] = [];
  for (const k of keys) {
    const t = props[k]?.type;
    const typeLabel = Array.isArray(t) ? t.join('|') : t ?? 'any';
    const next = `${k}${required.has(k) ? '' : '?'}:${typeLabel}`;
    if ([...parts, next].join(', ').length > 90) {
      parts.push('…');
      break;
    }
    parts.push(next);
  }
  return parts.join(', ');
}
