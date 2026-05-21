/**
 * Pre-built ShadowVariants for ToolSelectionPipeline.
 *
 * Each variant runs the pipeline with a different `k`. The production
 * pipeline (typically k=12) keeps serving requests; these variants log
 * what they WOULD have selected so analytics can later compare:
 *   - Did production miss a tool that smaller-k would have included?
 *     (recall regression — bad)
 *   - Did production include tools that larger-k flags as unused?
 *     (waste — good to know)
 *
 * The shadow runs uses the same EmbeddingFn and tool registry, so the
 * marginal cost is one extra cosine-sim batch per request — not an extra
 * embedding call (tool embeddings are cached by ToolEmbeddingHydrator).
 */
import { PipelineShadowVariant } from '@mcp/services/shadow-traffic/index.js';
import {
  createToolSelectionPipeline,
  type ToolSelectionPipelineOptions,
} from './tool-selection-pipeline.js';
import type { ToolCandidate, ToolSelectionQuery } from './types.js';

export interface ToolSelectionShadowConfig extends Omit<ToolSelectionPipelineOptions, 'k'> {
  /** Variants to materialize. Each maps a `name` to a top-K value. */
  variantKs: ReadonlyArray<{ name: string; k: number }>;
}

export function buildToolSelectionShadowVariants(
  cfg: ToolSelectionShadowConfig,
): PipelineShadowVariant<ToolSelectionQuery, ToolCandidate>[] {
  return cfg.variantKs.map(({ name, k }) =>
    new PipelineShadowVariant<ToolSelectionQuery, ToolCandidate>({
      name,
      pipeline: createToolSelectionPipeline({ ...cfg, k }),
      // Snapshot only the tool names — bloated payloads would balloon
      // counterfactual_logs without analytical value.
      summarize: (result) => ({
        toolNames: result.selected.map((c) => c.name),
        droppedNames: result.nonSelected.map((c) => c.name).slice(0, 20),
      }),
    }),
  );
}

/** Default variant pack: k=8 (tight) and k=16 (loose) alongside production k=12. */
export const DEFAULT_TOOL_SELECTION_VARIANTS = [
  { name: 'k_8',  k: 8 },
  { name: 'k_16', k: 16 },
] as const;
