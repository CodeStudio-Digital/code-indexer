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
  cosineSimilarity,
  weightedSum,
} from '@mcp/candidate-pipeline';
import { ESSENTIAL_TOOL_NAMES } from './helpers.js';
import type { EmbeddingFn, ToolEmbeddingStore } from './stages.js';
import type { JsonSchema } from '../core/tool.js';

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
  /** Telemetry callback — receives the selection diagnostics. */
  onResult?: (diag: {
    consideredCount: number;
    selectedCount: number;
    droppedCount: number;
    estimatedTokensSaved: number;
    durationMs: number;
  }) => void;
}

const DEFAULT_MIN_TASK_LENGTH = 8;
const DEFAULT_K = 12;
const FREQUENCY_WINDOW_MS = 10 * 60 * 1000;
const FREQUENCY_SATURATION = 5;

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
    const taskEmbedding = await embed(taskText);

    const now = Date.now();
    const events = options.recentToolCalls ?? [];

    // Compute (or fetch) embeddings for each tool. Cache by descriptionText.
    type Scored = { tool: ThinTool; isEssential: boolean; score: number };
    const scored: Scored[] = [];
    for (const tool of allTools) {
      const isEssential = ESSENTIAL_TOOL_NAMES.has(tool.name);
      const text = descriptionText(tool);
      const cached = embeddingStore.get(tool.name, simpleHash(text));
      let embedding: Float32Array;
      if (cached) {
        embedding = cached;
      } else {
        embedding = await embed(text);
        embeddingStore.set(tool.name, simpleHash(text), embedding);
      }
      const taskAffinity = cosineSimilarity(taskEmbedding, embedding);
      const freq = frequencyBoost(tool.name, events, now);
      const fused = weightedSum([
        { name: 'taskAffinity',   value: taskAffinity, weight: 1.0 },
        { name: 'frequencyBoost', value: freq,         weight: 0.4 },
      ]);
      scored.push({ tool, isEssential, score: fused.score });
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
