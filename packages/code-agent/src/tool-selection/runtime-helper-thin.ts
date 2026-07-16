/**
 * Thin tool-selection helper that operates on the SERIALIZED tool shape
 * (just name + description + parameters). Designed for the runner's
 * `toolSelectionFilter` hook, where the host receives stripped tools
 * about to go on the wire to the provider.
 *
 * Why this exists separately from `applyToolSelection`:
 *   - `applyToolSelection` operates on full `CoderTool[]` and goes
 *     through the framework's Source+Hydrator+Filter+Scorer+Selector
 *     pipeline (with tier filtering, frequency boost, etc.).
 *   - The runner has ALREADY done tier filtering by the time the hook
 *     fires, AND the stripped shape doesn't carry `source` or `riskLevel`,
 *     so re-running TierFilter is both wasteful and a no-op.
 *   - `applyToolSelectionThin` skips the framework and runs scoring
 *     directly on the stripped tools.
 *
 * Behavior is intentionally identical to the full pipeline for the
 * signals the stripped shape supports (taskAffinity + frequencyBoost +
 * weighted fusion), so observability metrics line up.
 */
import {
  assertEmbeddingFingerprint,
  cosineSimilarity,
  LruCache,
  resolveEmbeddingFingerprint,
  weightedSum,
} from '@mcp/candidate-pipeline';
import { ESSENTIAL_TOOL_NAMES, canonicalToolName } from './helpers.js';
import type { EmbeddingFn, ToolEmbeddingStore } from './stages.js';
import type { AgentDecisionTelemetry } from '../agents/decision-types.js';
import type { JsonSchema } from '../core/tool.js';

/**
 * Process-wide LRU for task embeddings — keyed by model fingerprint and
 * simpleHash(taskText).
 *
 * Rationale (A4 — Sprint 1): the thin path already caches TOOL embeddings
 * via `embeddingStore` (rarely change), but recomputes the TASK embedding
 * on every turn even when the user's input hasn't changed. Each task
 * embed() call is a network round-trip to Cloudflare/OpenAI/etc — by far
 * the dominant cost of this hot path.
 *
 * Caching by hash(taskText) catches:
 *   - User follow-up turns where taskText repeats (very common in chat)
 *   - Shadow A/B traffic that re-runs the same query
 *   - Re-evaluation after a tool result lands (taskText = last user message)
 *
 * Capacity 64 = generous for a single session. Different text or vector
 * space → different key → no false hits.
 *
 * The cache is process-wide because the cost-of-recompute is identical
 * across sessions and the keys can't collide on different content
 * (hash collision rate is negligible for short text).
 */
const taskEmbeddingCache = new LruCache<string, Float32Array>({ maxSize: 64 });

/**
 * Test helper — clears the module-level task embedding cache. Production code
 * should never need this; the cache is bounded and self-evicts.
 */
export function clearTaskEmbeddingCacheForTests(): void {
  taskEmbeddingCache.clear();
}

export interface ThinTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ApplyToolSelectionThinOptions {
  allTools: ThinTool[];
  taskText: string;
  /** Recent tool calls for the frequency-boost signal. */
  recentToolCalls?: ReadonlyArray<{ name: string; timestampMs: number }>;
  /** Embedding function — typically `deps.toolSelectionEmbed`. */
  embed: EmbeddingFn;
  /** Shared persistent store of tool-description embeddings. */
  embeddingStore: ToolEmbeddingStore;
  /** Top-K cap including essentials. Default 12. */
  k?: number;
  /** Skip selection when task text is shorter than this. Default 8. */
  minTaskLength?: number;
  /**
   * Optional intent/phase tool policy from the Agent Decision Engine. When
   * present, `preferred` tool names get a small score boost and `discouraged`
   * ones a penalty (mirrors PolicyAffinityScorer in the full pipeline). The
   * thin path bypasses the framework pipeline, so this re-implements the same
   * nudge here. Omitted/empty → byte-identical behavior. Names are matched
   * canonically (case/separator-insensitive) so snake_case engine names like
   * `web_fetch` match real candidate names like `WebFetch`/`web_fetch`.
   */
  toolPolicy?: { preferred?: readonly string[]; discouraged?: readonly string[] };
  /**
   * Optional compact Agent Decision Engine metadata for diagnostics/shadow logs.
   * This is observational only: it never affects selection.
   */
  agentDecision?: AgentDecisionTelemetry;
  /** Telemetry callback — receives the selection diagnostics. */
  onResult?: (diag: {
    consideredCount: number;
    selectedCount: number;
    droppedCount: number;
    estimatedTokensSaved: number;
    durationMs: number;
    /** True when the task embedding came from the LRU instead of `embed(taskText)`. */
    taskEmbeddingCacheHit: boolean;
    /** Compact shadow-mode decision metadata, when provided by the caller. */
    agentDecision?: AgentDecisionTelemetry;
  }) => void;
}

const DEFAULT_MIN_TASK_LENGTH = 8;
const DEFAULT_K = 12;
const FREQUENCY_WINDOW_MS = 10 * 60 * 1000;
const FREQUENCY_SATURATION = 5;
// Policy nudge magnitudes — kept in sync with PolicyAffinityScorer (stages.ts).
const POLICY_PREFER_BOOST = 0.5;
const POLICY_DISCOURAGE_PENALTY = 0.5;

function descriptionText(tool: ThinTool): string {
  const params = tool.parameters as { properties?: Record<string, unknown> } | undefined;
  const paramHints = Object.entries(params?.properties ?? {})
    .slice(0, 4)
    .map(([key, schema]) => {
      const desc = (schema as { description?: string }).description ?? '';
      return `${key}: ${desc}`;
    })
    .join('; ');
  return `${tool.name}. ${tool.description}. Params: ${paramHints}`.trim();
}

function frequencyBoost(name: string, events: ReadonlyArray<{ name: string; timestampMs: number }>, nowMs: number): number {
  const cutoff = nowMs - FREQUENCY_WINDOW_MS;
  let count = 0;
  for (const e of events) if (e.name === name && e.timestampMs >= cutoff) count++;
  if (count === 0) return 0;
  if (count >= FREQUENCY_SATURATION) return 1;
  return count / FREQUENCY_SATURATION;
}

/**
 * Run a lightweight tool selection on stripped tools. Returns the
 * filtered subset (essentials always included, then top-K by score).
 * On any error returns the original allTools unchanged.
 */
export async function applyToolSelectionThin(options: ApplyToolSelectionThinOptions): Promise<ThinTool[]> {
  const { allTools, taskText, embed, embeddingStore } = options;
  const minLen = options.minTaskLength ?? DEFAULT_MIN_TASK_LENGTH;
  const k = options.k ?? DEFAULT_K;
  if (!taskText || taskText.trim().length < minLen) return allTools;
  if (allTools.length <= k) return allTools;

  try {
    const startedAt = Date.now();
    const embeddingFingerprint = resolveEmbeddingFingerprint(embed);
    // Cache hit/miss on the task embedding — the dominant cost of this path.
    const taskKey = JSON.stringify([embeddingFingerprint, simpleHash(taskText)]);
    let taskEmbedding = taskEmbeddingCache.get(taskKey);
    const taskEmbeddingCacheHit = taskEmbedding !== undefined;
    if (!taskEmbedding) {
      taskEmbedding = await embed(taskText);
      assertEmbeddingFingerprint(embed, embeddingFingerprint);
      taskEmbeddingCache.set(taskKey, taskEmbedding);
    }

    const now = Date.now();
    const events = options.recentToolCalls ?? [];

    // Optional policy nudge (Agent Decision Engine). Empty/omitted → no effect.
    const preferredPolicy = new Set((options.toolPolicy?.preferred ?? []).map(canonicalToolName));
    const discouragedPolicy = new Set((options.toolPolicy?.discouraged ?? []).map(canonicalToolName));
    const hasPolicy = preferredPolicy.size > 0 || discouragedPolicy.size > 0;

    // Compute (or fetch) embeddings for each tool. Cache by descriptionText.
    type Scored = { tool: ThinTool; isEssential: boolean; score: number };
    const scored: Scored[] = [];
    for (const tool of allTools) {
      const isEssential = ESSENTIAL_TOOL_NAMES.has(tool.name);
      const text = descriptionText(tool);
      assertEmbeddingFingerprint(embed, embeddingFingerprint);
      const cached = embeddingStore.get(tool.name, simpleHash(text), embeddingFingerprint);
      let embedding: Float32Array;
      if (cached) {
        embedding = cached;
      } else {
        embedding = await embed(text);
        assertEmbeddingFingerprint(embed, embeddingFingerprint);
        embeddingStore.set(tool.name, simpleHash(text), embeddingFingerprint, embedding);
      }
      const taskAffinity = cosineSimilarity(taskEmbedding, embedding);
      const freq = frequencyBoost(tool.name, events, now);
      const fused = weightedSum([
        { name: 'taskAffinity',   value: taskAffinity, weight: 1.0 },
        { name: 'frequencyBoost', value: freq,         weight: 0.4 },
      ]);
      let policyDelta = 0;
      if (hasPolicy) {
        const cname = canonicalToolName(tool.name);
        if (preferredPolicy.has(cname)) policyDelta += POLICY_PREFER_BOOST;
        if (discouragedPolicy.has(cname)) policyDelta -= POLICY_DISCOURAGE_PENALTY;
      }
      scored.push({ tool, isEssential, score: fused.score + policyDelta });
    }

    const essentials = scored.filter((s) => s.isEssential);
    const others = scored.filter((s) => !s.isEssential).sort((a, b) => b.score - a.score);
    const slots = Math.max(0, k - essentials.length);
    const selected: ThinTool[] = [
      ...essentials.map((s) => s.tool),
      ...others.slice(0, slots).map((s) => s.tool),
    ];
    if (selected.length === 0) return allTools;

    const droppedCount = allTools.length - selected.length;
    const estimatedTokensSaved = Math.round(
      others.slice(slots).reduce((acc, s) => acc + descriptionText(s.tool).length, 0) / 4,
    );
    options.onResult?.({
      consideredCount: allTools.length,
      selectedCount: selected.length,
      droppedCount,
      estimatedTokensSaved,
      durationMs: Date.now() - startedAt,
      taskEmbeddingCacheHit,
      agentDecision: options.agentDecision,
    });

    return selected;
  } catch {
    return allTools;
  }
}

/** Lightweight FNV-1a so we don't pull node:crypto for a hot path. */
function simpleHash(text: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16);
}
