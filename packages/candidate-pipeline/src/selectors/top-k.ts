/**
 * Top-K selector — default selection strategy.
 *
 * Translated from `candidate-pipeline/selector.rs:21-85`. Caller supplies
 * a per-candidate `score(c)` function and a target `size`; selector sorts
 * descending by score and returns the top-K.
 *
 * Mutually-exclusive companion selectors (BlenderSelector, DiversitySelector)
 * provide alternative selection policies in this same folder.
 */
import type { Selector } from '../traits.js';
import type {
  PipelineCandidate,
  PipelineQuery,
  SelectResult,
} from '../types.js';

export interface TopKSelectorOptions<
  C extends PipelineCandidate,
  Q extends PipelineQuery = PipelineQuery,
> {
  /** Public name used in telemetry. */
  name?: string;
  /**
   * Number of candidates to keep, or a per-query resolver. Use Infinity for
   * no cap. Dynamic sizing is useful for pipelines whose public limit is part
   * of the query (for example, a rerank-depth selector followed by final K).
   */
  k: number | ((query: Q) => number);
  /** Score function; higher is better. */
  scoreOf: (candidate: C) => number;
  /** Optional gate — defaults to always-on. */
  enable?: (query: unknown) => boolean;
}

export class TopKSelector<Q extends PipelineQuery, C extends PipelineCandidate>
  implements Selector<Q, C>
{
  readonly name: string;
  constructor(private opts: TopKSelectorOptions<C, Q>) {
    this.name = opts.name ?? 'top_k';
  }
  enable(query: Q): boolean { return this.opts.enable ? this.opts.enable(query) : true; }
  size(): number | undefined {
    return typeof this.opts.k === 'number' ? this.opts.k : undefined;
  }
  score(candidate: C): number { return this.opts.scoreOf(candidate); }
  select(query: Q, candidates: C[]): SelectResult<C> {
    const sorted = [...candidates].sort((a, b) => this.opts.scoreOf(b) - this.opts.scoreOf(a));
    const requestedK = typeof this.opts.k === 'function' ? this.opts.k(query) : this.opts.k;
    const cap = Number.isFinite(requestedK) ? Math.max(0, requestedK) : sorted.length;
    return {
      selected: sorted.slice(0, cap),
      nonSelected: sorted.slice(cap),
    };
  }
}
