/**
 * ToolSelectionPipeline factory + simple convenience entrypoint.
 *
 * Constructs a CandidatePipeline<ToolSelectionQuery, ToolCandidate> wired
 * with all the stages from `./stages.ts`. Consumers (the code-agent runner)
 * call `selectTools(query)` and receive the top-K ToolCandidates.
 *
 * The pipeline is intentionally a thin assembly — all behavior lives in
 * the individual stages, so they can be A/B tested or replaced without
 * touching the orchestration.
 */
import { createHash } from 'node:crypto';
import { CandidatePipeline, type TelemetrySink } from '@mcp/candidate-pipeline';
import {
  EssentialAwareTopKSelector,
  FrequencyBoostScorer,
  RecencyScorer,
  TaskEmbeddingHydrator,
  TierFilter,
  ToolEmbeddingHydrator,
  ToolRegistrySource,
  TwoTowerScorer,
  WeightedFusionScorer,
  type EmbeddingFn,
  type ToolEmbeddingStore,
} from './stages.js';
import type { ToolCandidate, ToolSelectionQuery } from './types.js';
import { DEFAULT_TOP_K } from './types.js';
import type { CoderTool } from '../core/tool.js';

export interface ToolSelectionPipelineOptions {
  /** Returns the full tool registry. */
  getAllTools: () => CoderTool[];
  /** Embedding function for both task text and tool descriptions. */
  embed: EmbeddingFn;
  /** Persistent (or in-process) store of tool embeddings. */
  toolEmbeddingStore: ToolEmbeddingStore;
  /** Optional telemetry sink — typically `deps.pipelineTelemetrySink`. */
  telemetry?: TelemetrySink;
  /** Top-K cap. Defaults to DEFAULT_TOP_K (12). */
  k?: number;
}

export function createToolSelectionPipeline(
  options: ToolSelectionPipelineOptions,
): CandidatePipeline<ToolSelectionQuery, ToolCandidate> {
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
  return new CandidatePipeline<ToolSelectionQuery, ToolCandidate>(
    { name: 'tool_selection', telemetry: options.telemetry },
    {
      queryHydrators: [new TaskEmbeddingHydrator(options.embed)],
      sources: [new ToolRegistrySource(options.getAllTools)],
      hydrators: [new ToolEmbeddingHydrator(options.embed, options.toolEmbeddingStore, hash)],
      filters: [new TierFilter()],
      scorers: [
        new TwoTowerScorer(),
        new FrequencyBoostScorer(),
        new RecencyScorer(),
        new WeightedFusionScorer(),
      ],
      selector: new EssentialAwareTopKSelector(options.k ?? DEFAULT_TOP_K),
    },
  );
}

/**
 * Convenience helper: build a query from the typical inputs and run the
 * pipeline. Returns the selected tools in order + a token-savings estimate.
 *
 * Token estimate is a heuristic: descriptionText length / 4 chars per token,
 * summed over the tools that were DROPPED. Good enough for telemetry; not
 * meant to be precise.
 */
export interface SelectToolsResult {
  selected: CoderTool[];
  diag: {
    consideredCount: number;
    selectedCount: number;
    droppedCount: number;
    estimatedTokensSaved: number;
    durationMs: number;
  };
}

export async function selectTools(
  pipeline: CandidatePipeline<ToolSelectionQuery, ToolCandidate>,
  query: ToolSelectionQuery,
): Promise<SelectToolsResult> {
  const result = await pipeline.execute(query);
  const consideredCount = result.selected.length + result.nonSelected.length;
  const droppedTextLength = result.nonSelected.reduce(
    (acc, c) => acc + c.descriptionText.length,
    0,
  );
  return {
    selected: result.selected.map((c) => c.tool),
    diag: {
      consideredCount,
      selectedCount: result.selected.length,
      droppedCount: result.nonSelected.length,
      estimatedTokensSaved: Math.round(droppedTextLength / 4),
      durationMs: result.diag.durationMs,
    },
  };
}
