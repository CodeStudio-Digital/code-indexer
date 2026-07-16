/**
 * Pipeline stages for tool selection.
 *
 * Each stage implements one of the @mcp/candidate-pipeline traits. Stages
 * are small and composable — the orchestrator wires them together in
 * tool-selection-pipeline.ts.
 */
import type {
  QueryHydrator,
  Source,
  Hydrator,
  Filter,
  Scorer,
  Selector,
  CandidateResult,
  FilterResult,
  SelectResult,
} from '@mcp/candidate-pipeline';
import {
  assertEmbeddingFingerprint,
  cosineSimilarity,
  resolveEmbeddingFingerprint,
  weightedSum,
  recencyDecay,
  batchFrequencyBoost,
} from '@mcp/candidate-pipeline';
import { ESSENTIAL_TOOL_NAMES, toCandidate, canonicalToolName } from './helpers.js';
import type { ToolCandidate, ToolSelectionQuery } from './types.js';
import type { CoderTool } from '../core/tool.js';

// ────────────────────────────────────────────────────────────────────────
// QueryHydrator — embed the task text once per request.
// ────────────────────────────────────────────────────────────────────────

export interface EmbeddingFn {
  (text: string): Promise<Float32Array>;
  readonly fingerprint?: () => string;
}

export class TaskEmbeddingHydrator implements QueryHydrator<ToolSelectionQuery> {
  readonly name = 'task_embedding';
  constructor(private embed: EmbeddingFn) {}
  enable(query: ToolSelectionQuery): boolean {
    return query.taskText.trim().length > 0 && (!query.taskEmbedding || !query.embeddingFingerprint);
  }
  async hydrate(query: ToolSelectionQuery): Promise<Partial<ToolSelectionQuery>> {
    const embeddingFingerprint = resolveEmbeddingFingerprint(this.embed);
    const taskEmbedding = await this.embed(query.taskText);
    assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
    return { taskEmbedding, embeddingFingerprint };
  }
  update(query: ToolSelectionQuery, partial: Partial<ToolSelectionQuery>): void {
    if (partial.taskEmbedding) query.taskEmbedding = partial.taskEmbedding;
    if (partial.embeddingFingerprint) query.embeddingFingerprint = partial.embeddingFingerprint;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Source — produce candidates from the tool registry.
// ────────────────────────────────────────────────────────────────────────

export class ToolRegistrySource implements Source<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'tool_registry';
  constructor(private getAllTools: () => CoderTool[]) {}
  enable(): boolean { return true; }
  async source(): Promise<ToolCandidate[]> {
    return this.getAllTools().map(toCandidate);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Hydrator — fetch / cache tool embeddings.
// ────────────────────────────────────────────────────────────────────────

export interface ToolEmbeddingStore {
  /** Returns cached embedding if present, undefined otherwise. */
  get(toolName: string, descriptionHash: string, embeddingFingerprint: string): Float32Array | undefined;
  set(toolName: string, descriptionHash: string, embeddingFingerprint: string, embedding: Float32Array): void;
}

export class ToolEmbeddingHydrator implements Hydrator<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'tool_embedding';
  constructor(
    private embed: EmbeddingFn,
    private store: ToolEmbeddingStore,
    private hashFn: (text: string) => string,
  ) {}
  enable(): boolean { return true; }
  async hydrate(
    query: ToolSelectionQuery,
    candidates: readonly ToolCandidate[],
  ): Promise<CandidateResult<ToolCandidate>[]> {
    const embeddingFingerprint = query.embeddingFingerprint ?? resolveEmbeddingFingerprint(this.embed);
    assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
    return Promise.all(
      candidates.map(async (c): Promise<CandidateResult<ToolCandidate>> => {
        const hash = this.hashFn(c.descriptionText);
        const cached = this.store.get(c.name, hash, embeddingFingerprint);
        if (cached) {
          return { ok: true, candidate: { ...c, embedding: cached } };
        }
        try {
          const embedding = await this.embed(c.descriptionText);
          assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
          this.store.set(c.name, hash, embeddingFingerprint, embedding);
          return { ok: true, candidate: { ...c, embedding } };
        } catch (e) {
          return { ok: false, candidateId: c.candidateId, error: (e as Error).message };
        }
      }),
    );
  }
  update(candidate: ToolCandidate, hydrated: ToolCandidate): void {
    candidate.embedding = hydrated.embedding;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Filter — drop tools that don't match the tier policy.
// ────────────────────────────────────────────────────────────────────────

/** Tools with risk-level higher than `tier` are dropped UNLESS `isEssential`. */
export class TierFilter implements Filter<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'tier_filter';
  enable(): boolean { return true; }
  filter(query: ToolSelectionQuery, candidates: ToolCandidate[]): FilterResult<ToolCandidate> {
    const tier = query.tier ?? 'full';
    const kept: ToolCandidate[] = [];
    const removed: ToolCandidate[] = [];
    for (const c of candidates) {
      if (c.isEssential) { kept.push(c); continue; }
      const risk = c.tool.riskLevel ?? 'write';
      const allowed =
        tier === 'full' ? true :
        tier === 'navigate' ? risk !== 'admin' :
        // bootstrap: only essentials remain (already handled above)
        false;
      if (allowed) kept.push(c);
      else removed.push(c);
    }
    return { kept, removed };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Scorers
// ────────────────────────────────────────────────────────────────────────

/** Two-tower scorer: cosine similarity task↔tool. */
export class TwoTowerScorer implements Scorer<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'two_tower';
  enable(query: ToolSelectionQuery): boolean { return !!query.taskEmbedding; }
  async score(
    query: ToolSelectionQuery,
    candidates: readonly ToolCandidate[],
  ): Promise<CandidateResult<ToolCandidate>[]> {
    const q = query.taskEmbedding!;
    return candidates.map((c): CandidateResult<ToolCandidate> => {
      if (!c.embedding) {
        return { ok: true, candidate: { ...c, signals: { ...c.signals, taskAffinity: 0 } } };
      }
      const sim = cosineSimilarity(q, c.embedding);
      return {
        ok: true,
        candidate: { ...c, signals: { ...c.signals, taskAffinity: sim } },
      };
    });
  }
  update(candidate: ToolCandidate, scored: ToolCandidate): void {
    candidate.signals = scored.signals;
  }
}

/** Frequency boost: tools called recently in this session get a bump. */
export class FrequencyBoostScorer implements Scorer<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'frequency_boost';
  constructor(private windowMs = 10 * 60 * 1000, private maxBoost = 0.3) {}
  enable(query: ToolSelectionQuery): boolean {
    return (query.recentToolEvents?.length ?? 0) > 0;
  }
  async score(
    query: ToolSelectionQuery,
    candidates: readonly ToolCandidate[],
  ): Promise<CandidateResult<ToolCandidate>[]> {
    const events = (query.recentToolEvents ?? []).map((e) => ({
      candidateId: e.toolName,
      timestampMs: e.timestampMs,
    }));
    const boosts = batchFrequencyBoost(
      candidates.map((c) => c.name),
      events,
      { windowMs: this.windowMs, maxBoost: this.maxBoost },
    );
    return candidates.map((c, i): CandidateResult<ToolCandidate> => ({
      ok: true,
      candidate: { ...c, signals: { ...c.signals, frequencyBoost: boosts[i] } },
    }));
  }
  update(candidate: ToolCandidate, scored: ToolCandidate): void {
    candidate.signals = scored.signals;
  }
}

/** Recency decay: bump tools used within the last few turns. */
export class RecencyScorer implements Scorer<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'recency';
  constructor(private halfLifeMs = 5 * 60 * 1000) {}
  enable(query: ToolSelectionQuery): boolean {
    return (query.recentToolEvents?.length ?? 0) > 0;
  }
  async score(
    query: ToolSelectionQuery,
    candidates: readonly ToolCandidate[],
  ): Promise<CandidateResult<ToolCandidate>[]> {
    const lastUseByName = new Map<string, number>();
    for (const e of query.recentToolEvents ?? []) {
      const prev = lastUseByName.get(e.toolName) ?? 0;
      if (e.timestampMs > prev) lastUseByName.set(e.toolName, e.timestampMs);
    }
    return candidates.map((c): CandidateResult<ToolCandidate> => {
      const last = lastUseByName.get(c.name);
      const decay = last ? recencyDecay(last, { halfLifeMs: this.halfLifeMs }) : 0;
      return {
        ok: true,
        candidate: { ...c, signals: { ...c.signals, recency: decay } },
      };
    });
  }
  update(candidate: ToolCandidate, scored: ToolCandidate): void {
    candidate.signals = scored.signals;
  }
}

/** Weighted-sum: combines all signals into the final `score` field. */
export class WeightedFusionScorer implements Scorer<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'weighted_fusion';
  constructor(
    private weights: { taskAffinity: number; frequencyBoost: number; recency: number } = {
      taskAffinity: 1.0,
      frequencyBoost: 0.4,
      recency: 0.2,
    },
  ) {}
  enable(): boolean { return true; }
  async score(
    _query: ToolSelectionQuery,
    candidates: readonly ToolCandidate[],
  ): Promise<CandidateResult<ToolCandidate>[]> {
    return candidates.map((c): CandidateResult<ToolCandidate> => {
      const ws = weightedSum([
        { name: 'taskAffinity',   value: c.signals.taskAffinity ?? 0,    weight: this.weights.taskAffinity },
        { name: 'frequencyBoost', value: c.signals.frequencyBoost ?? 0,  weight: this.weights.frequencyBoost },
        { name: 'recency',        value: c.signals.recency ?? 0,         weight: this.weights.recency },
      ]);
      return { ok: true, candidate: { ...c, score: ws.score } };
    });
  }
  update(candidate: ToolCandidate, scored: ToolCandidate): void {
    candidate.score = scored.score;
  }
}

/**
 * Policy affinity: nudge the final fused score using the Agent Decision
 * Engine's intent/phase-aware tool policy. Tools in `preferred` get a bump,
 * tools in `discouraged` get a penalty.
 *
 * Runs AFTER {@link WeightedFusionScorer} so it adjusts the already-fused
 * `score` directly (a small, comparable-magnitude nudge — not a hard filter).
 * Essentials are still always kept by the selector, so a discouraged essential
 * is never stranded — it just sinks in the ranking of non-essentials.
 *
 * Crucially, `enable()` returns false when no policy is supplied, so callers
 * that don't pass `toolPolicy` get byte-identical selection — this scorer is a
 * pure, backward-compatible add-on (shadow-mode friendly).
 */
export class PolicyAffinityScorer implements Scorer<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'policy_affinity';
  constructor(private preferBoost = 0.5, private discouragePenalty = 0.5) {}
  enable(query: ToolSelectionQuery): boolean {
    const p = query.toolPolicy;
    return !!p && ((p.preferred?.length ?? 0) > 0 || (p.discouraged?.length ?? 0) > 0);
  }
  async score(
    query: ToolSelectionQuery,
    candidates: readonly ToolCandidate[],
  ): Promise<CandidateResult<ToolCandidate>[]> {
    const preferred = new Set((query.toolPolicy?.preferred ?? []).map(canonicalToolName));
    const discouraged = new Set((query.toolPolicy?.discouraged ?? []).map(canonicalToolName));
    return candidates.map((c): CandidateResult<ToolCandidate> => {
      const name = canonicalToolName(c.name);
      let delta = 0;
      if (preferred.has(name)) delta += this.preferBoost;
      if (discouraged.has(name)) delta -= this.discouragePenalty;
      return {
        ok: true,
        candidate: {
          ...c,
          score: c.score + delta,
          signals: { ...c.signals, policyAffinity: delta },
        },
      };
    });
  }
  update(candidate: ToolCandidate, scored: ToolCandidate): void {
    candidate.score = scored.score;
    candidate.signals = scored.signals;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Selector — top-K with an essential-tools guard that always concatenates
// the bootstrap tier so a misbehaving scorer can't strand the agent.
// ────────────────────────────────────────────────────────────────────────

export class EssentialAwareTopKSelector implements Selector<ToolSelectionQuery, ToolCandidate> {
  readonly name = 'essential_topk';
  constructor(private defaultK = 12) {}
  enable(): boolean { return true; }
  size(): number { return this.defaultK; }
  score(c: ToolCandidate): number { return c.score; }
  select(query: ToolSelectionQuery, candidates: ToolCandidate[]): SelectResult<ToolCandidate> {
    const k = query.k ?? this.defaultK;
    // Always include essentials, then fill with top-scoring of the rest.
    const essentials = candidates.filter((c) => c.isEssential || ESSENTIAL_TOOL_NAMES.has(c.name));
    const others = candidates
      .filter((c) => !essentials.includes(c))
      .sort((a, b) => b.score - a.score);
    const slotsForOthers = Math.max(0, k - essentials.length);
    const selected = [...essentials, ...others.slice(0, slotsForOthers)];
    const nonSelected = others.slice(slotsForOthers);
    return { selected, nonSelected };
  }
}
