/**
 * PipelineShadowVariant — adapter that turns a CandidatePipeline instance
 * into a `ShadowVariant`. Lets you spin up alternative configurations
 * (different k, different scorer weights, different selector) and run
 * them in parallel with production via the shared `ShadowTrafficRunner`.
 *
 * Usage:
 *
 *   const variant = new PipelineShadowVariant({
 *     name: 'tool_selection_k_8',
 *     pipeline: createToolSelectionPipeline({ ...productionOpts, k: 8 }),
 *     summarize: (result) => result.selected.map((c) => c.name),
 *   });
 *
 * The `summarize` callback collapses the pipeline's typed candidates into
 * a JSON-friendly snapshot (typically a list of ids or names). Storing
 * the full candidate set in counterfactual_logs would bloat the table for
 * little analytical value.
 */
import type {
  CandidatePipeline,
  PipelineCandidate,
  PipelineQuery,
} from '@mcp/candidate-pipeline';
import type { ShadowVariant } from './types.js';

export interface PipelineShadowVariantConfig<Q extends PipelineQuery, C extends PipelineCandidate, S = unknown> {
  /** Stable variant name. Written to counterfactual_logs.shadow_variant. */
  name: string;
  /** The variant pipeline. Built ahead of time with alternative config. */
  pipeline: CandidatePipeline<Q, C>;
  /**
   * Snapshot function — picks which fields of the result to log. Default
   * picks the `candidateId` of each selected candidate.
   */
  summarize?: (result: { selected: C[]; nonSelected: C[] }) => S;
  /** Optional gate. */
  enable?: (query: Q) => boolean;
}

export class PipelineShadowVariant<Q extends PipelineQuery, C extends PipelineCandidate>
  implements ShadowVariant<Q>
{
  readonly name: string;
  constructor(private cfg: PipelineShadowVariantConfig<Q, C>) {
    this.name = cfg.name;
  }
  enable(query: Q): boolean {
    return this.cfg.enable ? this.cfg.enable(query) : true;
  }
  async run(query: Q): Promise<unknown> {
    const result = await this.cfg.pipeline.execute(query);
    if (this.cfg.summarize) {
      return this.cfg.summarize({ selected: result.selected, nonSelected: result.nonSelected });
    }
    // Default snapshot: just the selected candidateIds.
    return { selectedIds: result.selected.map((c) => c.candidateId) };
  }
}
