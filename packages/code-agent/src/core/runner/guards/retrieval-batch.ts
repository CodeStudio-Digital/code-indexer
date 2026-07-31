import { stableArgsKey } from '../dup-utils.js';

export interface RetrievalToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type RetrievalBatchDecision =
  | {
      action: 'execute';
      input: Record<string, unknown>;
    }
  | {
      action: 'coalesce';
      originToolUseId: string;
      reason:
        | 'targeted-search-over-broad-map'
        | 'same-batch-grep-merge';
      content: string;
    };

export interface RetrievalBatchPlanOptions {
  taskText?: string;
  enabled?: boolean;
}

const BROAD_PROJECT_READS = new Set([
  'mcp__get_project_overview',
  'mcp__get_repo_map',
]);

const TASK_STOP_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos',
  'e', 'em', 'este', 'esta', 'essa', 'esse', 'is', 'no', 'na', 'nos', 'nas',
  'o', 'os', 'ou', 'para', 'por', 'que', 'the', 'um', 'uma', 'where', 'what',
]);

function normalizedTokens(value: string): Set<string> {
  const tokens = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .match(/[\p{Letter}\p{Number}_-]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length > 1 && !TASK_STOP_WORDS.has(token)));
}

export function taskQueryOverlap(taskText: string, query: string): number {
  const taskTokens = normalizedTokens(taskText);
  let score = 0;
  for (const token of normalizedTokens(query)) {
    if (taskTokens.has(token)) score += 1;
  }
  return score;
}

function grepCompatibilityKey(input: Record<string, unknown>): string | null {
  if (typeof input.pattern !== 'string' || input.pattern.length === 0 || input.literal === true) {
    return null;
  }
  // Alternating separately valid regexes can change numbered backreference
  // targets or create duplicate named groups. Keep those calls independent.
  if (/\\[1-9]|\(\?</.test(input.pattern)) return null;
  const comparable = { ...input };
  delete comparable.pattern;
  delete comparable.max_results;
  return stableArgsKey(comparable);
}

function requestedMaxResults(input: Record<string, unknown>): number {
  const value = Number(input.max_results);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}

/**
 * Plans only redundancy that is provable inside one assistant tool batch.
 *
 * It never relies on an LLM and never carries state across turns:
 * - a targeted semantic search supersedes a broad repo map for this batch;
 * - compatible regex greps are executed once as an alternation.
 *
 * Every requested tool_use still receives a tool_result. Coalesced calls get a
 * compact pointer to the canonical result so provider tool protocols remain
 * balanced and the model can retry a deferred route on a later turn.
 */
export function planRetrievalBatch(
  toolUses: RetrievalToolUse[],
  options: RetrievalBatchPlanOptions = {},
): Map<string, RetrievalBatchDecision> {
  const decisions = new Map<string, RetrievalBatchDecision>(
    toolUses.map((toolUse) => [
      toolUse.id,
      { action: 'execute', input: toolUse.input } as const,
    ]),
  );
  if (options.enabled === false || toolUses.length < 2) return decisions;

  const searches = toolUses.filter((toolUse) => toolUse.name === 'mcp__search');
  const scoredSearches = options.taskText?.trim()
    ? searches.map((toolUse) => ({
        toolUse,
        score: taskQueryOverlap(options.taskText!, String(toolUse.input.query ?? '')),
      }))
    : [];
  const bestSearch = scoredSearches.length > 0
    ? scoredSearches.reduce((current, candidate) => (
        candidate.score > current.score ? candidate : current
      ))
    : undefined;
  const canonicalSearch = bestSearch?.toolUse ?? searches[0];
  if (canonicalSearch) {
    for (const toolUse of toolUses) {
      if (!BROAD_PROJECT_READS.has(toolUse.name)) continue;
      decisions.set(toolUse.id, {
        action: 'coalesce',
        originToolUseId: canonicalSearch.id,
        reason: 'targeted-search-over-broad-map',
        content:
          `[retrieval-coalesced] Skipped broad \`${toolUse.name}\` because this batch already `
          + 'contains targeted semantic search. Inspect that result first; request the broad map '
          + 'in a later turn only if the architecture remains unresolved.',
      });
    }
  }

  const grepGroups = new Map<string, RetrievalToolUse[]>();
  for (const toolUse of toolUses) {
    if (toolUse.name !== 'mcp__grep_code') continue;
    const key = grepCompatibilityKey(toolUse.input);
    if (key === null) continue;
    const group = grepGroups.get(key) ?? [];
    group.push(toolUse);
    grepGroups.set(key, group);
  }
  for (const group of grepGroups.values()) {
    if (group.length < 2) continue;
    const [canonical, ...aliases] = group;
    const patterns = [...new Set(group.map((toolUse) => String(toolUse.input.pattern)))];
    decisions.set(canonical.id, {
      action: 'execute',
      input: {
        ...canonical.input,
        pattern: patterns.map((pattern) => `(?:${pattern})`).join('|'),
        max_results: Math.min(
          100,
          group.reduce((sum, toolUse) => sum + requestedMaxResults(toolUse.input), 0),
        ),
      },
    });
    for (const alias of aliases) {
      decisions.set(alias.id, {
        action: 'coalesce',
        originToolUseId: canonical.id,
        reason: 'same-batch-grep-merge',
        content:
          `[retrieval-coalesced] This grep was merged into tool call ${canonical.id}. `
          + 'Use the combined grep result in this batch.',
      });
    }
  }

  return decisions;
}
