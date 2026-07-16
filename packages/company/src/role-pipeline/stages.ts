/**
 * Pipeline stages for role recommendation.
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
} from '@mcp/candidate-pipeline';
import {
  DEFAULT_WEIGHTS,
  type IdleRunDescriptor,
  type RoleCandidate,
  type RoleDescriptor,
  type RolePipelineQuery,
} from './types.js';

export interface EmbeddingFn {
  (text: string): Promise<Float32Array>;
  readonly fingerprint?: () => string;
}

export interface HistorySuccessSource {
  /** Returns a [0, 1] success rate for (role, task_class). 0.5 = unknown. */
  successRateFor(role: string, taskHash: string): Promise<number>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function roleDescriptionText(role: RoleDescriptor): string {
  return `Role ${role.role}. ${role.description}. Skills: ${(role.skills ?? []).join(', ')}`;
}

function spawnCandidate(role: RoleDescriptor): RoleCandidate {
  return {
    candidateId: `spawn::${role.role}`,
    kind: 'spawn',
    role,
    signals: {},
    score: 0,
  };
}

function reuseCandidate(role: RoleDescriptor, idle: IdleRunDescriptor): RoleCandidate {
  return {
    candidateId: `reuse::${idle.agentRunId}`,
    kind: 'reuse',
    role,
    idleRun: idle,
    signals: {},
    score: 0,
  };
}

// ─── QueryHydrator ─────────────────────────────────────────────────────

export class TaskEmbeddingHydrator implements QueryHydrator<RolePipelineQuery> {
  readonly name = 'task_embedding';
  constructor(private embed: EmbeddingFn) {}
  enable(q: RolePipelineQuery): boolean {
    return q.taskText.trim().length > 0 && (!q.taskEmbedding || !q.embeddingFingerprint);
  }
  async hydrate(q: RolePipelineQuery): Promise<Partial<RolePipelineQuery>> {
    const embeddingFingerprint = resolveEmbeddingFingerprint(this.embed);
    const taskEmbedding = await this.embed(q.taskText);
    assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
    return { taskEmbedding, embeddingFingerprint };
  }
  update(q: RolePipelineQuery, p: Partial<RolePipelineQuery>): void {
    if (p.taskEmbedding) q.taskEmbedding = p.taskEmbedding;
    if (p.embeddingFingerprint) q.embeddingFingerprint = p.embeddingFingerprint;
  }
}

// ─── Sources ───────────────────────────────────────────────────────────

export class TemplateRosterSource implements Source<RolePipelineQuery, RoleCandidate> {
  readonly name = 'template_roster';
  enable(): boolean { return true; }
  async source(query: RolePipelineQuery): Promise<RoleCandidate[]> {
    return query.availableRoles.map(spawnCandidate);
  }
}

export class ActiveIdleRunsSource implements Source<RolePipelineQuery, RoleCandidate> {
  readonly name = 'active_idle_runs';
  enable(query: RolePipelineQuery): boolean {
    return (query.idleRuns?.length ?? 0) > 0;
  }
  async source(query: RolePipelineQuery): Promise<RoleCandidate[]> {
    const byRole = new Map(query.availableRoles.map((r) => [r.role, r]));
    const candidates: RoleCandidate[] = [];
    for (const idle of query.idleRuns ?? []) {
      const role = byRole.get(idle.role);
      if (!role) continue; // idle run for a role no longer in the roster
      candidates.push(reuseCandidate(role, idle));
    }
    return candidates;
  }
}

// ─── Hydrators ─────────────────────────────────────────────────────────

export interface RoleEmbeddingStore {
  get(roleKey: string, embeddingFingerprint: string): Float32Array | undefined;
  set(roleKey: string, embeddingFingerprint: string, embedding: Float32Array): void;
}

export class RoleEmbeddingHydrator implements Hydrator<RolePipelineQuery, RoleCandidate> {
  readonly name = 'role_embedding';
  constructor(
    private embed: EmbeddingFn,
    private store: RoleEmbeddingStore,
  ) {}
  enable(): boolean { return true; }
  async hydrate(
    query: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<CandidateResult<RoleCandidate>[]> {
    const embeddingFingerprint = query.embeddingFingerprint ?? resolveEmbeddingFingerprint(this.embed);
    assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
    return Promise.all(
      candidates.map(async (c): Promise<CandidateResult<RoleCandidate>> => {
        const key = `${c.role.role}::${(c.role.skills ?? []).join(',')}`;
        const cached = this.store.get(key, embeddingFingerprint);
        if (cached) return { ok: true, candidate: { ...c, roleEmbedding: cached } };
        try {
          const emb = await this.embed(roleDescriptionText(c.role));
          assertEmbeddingFingerprint(this.embed, embeddingFingerprint);
          this.store.set(key, embeddingFingerprint, emb);
          return { ok: true, candidate: { ...c, roleEmbedding: emb } };
        } catch (e) {
          return { ok: false, candidateId: c.candidateId, error: (e as Error).message };
        }
      }),
    );
  }
  update(c: RoleCandidate, h: RoleCandidate): void { c.roleEmbedding = h.roleEmbedding; }
}

// ─── Filters ───────────────────────────────────────────────────────────

export class CapacityFilter implements Filter<RolePipelineQuery, RoleCandidate> {
  readonly name = 'capacity';
  enable(): boolean { return true; }
  filter(query: RolePipelineQuery, candidates: RoleCandidate[]): FilterResult<RoleCandidate> {
    const running = query.runningByRole ?? {};
    const kept: RoleCandidate[] = [];
    const removed: RoleCandidate[] = [];
    for (const c of candidates) {
      // 'reuse' candidates are not subject to the concurrency cap — reuse
      // doesn't open a new slot.
      if (c.kind === 'reuse') { kept.push(c); continue; }
      const cap = c.role.concurrencyCap ?? Infinity;
      const inUse = running[c.role.role] ?? 0;
      if (inUse < cap) kept.push(c);
      else removed.push(c);
    }
    return { kept, removed };
  }
}

export class BlockedRolesFilter implements Filter<RolePipelineQuery, RoleCandidate> {
  readonly name = 'blocked_roles';
  enable(query: RolePipelineQuery): boolean {
    return (query.blockedRoles?.length ?? 0) > 0;
  }
  filter(query: RolePipelineQuery, candidates: RoleCandidate[]): FilterResult<RoleCandidate> {
    const blocked = new Set(query.blockedRoles ?? []);
    const kept: RoleCandidate[] = [];
    const removed: RoleCandidate[] = [];
    for (const c of candidates) {
      if (blocked.has(c.role.role)) removed.push(c);
      else kept.push(c);
    }
    return { kept, removed };
  }
}

// ─── DisableRulesFilter (C2 — Sprint 1) ───────────────────────────────
//
// Evaluates declarative `RoleDescriptor.disableRules` against the
// workflow state in `RolePipelineQuery.disableContext`. Candidates whose
// rules match are dropped (with the first matching rule's reason
// surfaced in diagnostics). Direct port of grox's DISABLE_RULES.
//
// Stays off for legacy callers: when no role has `disableRules` set OR
// no `disableContext` is provided, the filter contributes zero removals
// (bit-identical to pre-C2 behavior).

import { evaluateDisableRules, emptyDisableContext } from './disable-rules.js';

export class DisableRulesFilter implements Filter<RolePipelineQuery, RoleCandidate> {
  readonly name = 'disable_rules';
  enable(query: RolePipelineQuery): boolean {
    // Cheap pre-check: at least one role must declare rules. If none do,
    // skipping the filter saves the per-candidate loop.
    return query.availableRoles.some((r) => (r.disableRules?.length ?? 0) > 0);
  }
  filter(query: RolePipelineQuery, candidates: RoleCandidate[]): FilterResult<RoleCandidate> {
    const ctx = query.disableContext ?? emptyDisableContext(query.taskText);
    const kept: RoleCandidate[] = [];
    const removed: RoleCandidate[] = [];
    for (const c of candidates) {
      const result = evaluateDisableRules(c.role.disableRules, ctx);
      if (result.disabled) {
        // Annotate the dropped candidate with the rule's diagnostic so
        // upstream observers (telemetry / shadow logs) can see WHY it
        // was filtered. Keeps the rest of the candidate untouched.
        removed.push({
          ...c,
          signals: {
            ...c.signals,
            disabledByRule: 1,
            disableReason: result.reason,
            disableRuleName: result.ruleName,
          } as RoleCandidate['signals'],
        });
      } else {
        kept.push(c);
      }
    }
    return { kept, removed };
  }
}

// ─── Scorers ───────────────────────────────────────────────────────────

export class TwoTowerScorer implements Scorer<RolePipelineQuery, RoleCandidate> {
  readonly name = 'two_tower';
  enable(q: RolePipelineQuery): boolean { return !!q.taskEmbedding; }
  async score(
    q: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<CandidateResult<RoleCandidate>[]> {
    const t = q.taskEmbedding!;
    return candidates.map((c): CandidateResult<RoleCandidate> => {
      const sim = c.roleEmbedding ? cosineSimilarity(t, c.roleEmbedding) : 0;
      return { ok: true, candidate: { ...c, signals: { ...c.signals, taskAffinity: sim } } };
    });
  }
  update(c: RoleCandidate, s: RoleCandidate): void { c.signals = s.signals; }
}

export class HistorySuccessScorer implements Scorer<RolePipelineQuery, RoleCandidate> {
  readonly name = 'history_success';
  constructor(private source: HistorySuccessSource | null) {}
  enable(): boolean { return this.source !== null; }
  async score(
    q: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<CandidateResult<RoleCandidate>[]> {
    const taskHash = await hashTaskText(q.taskText);
    return Promise.all(
      candidates.map(async (c): Promise<CandidateResult<RoleCandidate>> => {
        const rate = (await this.source?.successRateFor(c.role.role, taskHash)) ?? 0.5;
        return { ok: true, candidate: { ...c, signals: { ...c.signals, historySuccess: rate } } };
      }),
    );
  }
  update(c: RoleCandidate, s: RoleCandidate): void { c.signals = s.signals; }
}

export class CostScorer implements Scorer<RolePipelineQuery, RoleCandidate> {
  readonly name = 'cost';
  enable(): boolean { return true; }
  async score(
    _q: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<CandidateResult<RoleCandidate>[]> {
    // Signal = COST itself (normalized to [0, 1]). Combined with the
    // NEGATIVE weight in DEFAULT_WEIGHTS, this penalizes expensive roles.
    // Roles without a declared modelCost get a neutral 0.5 — neither
    // bonus nor penalty.
    const costs = candidates.map((c) => c.role.modelCost ?? Number.NaN).filter((x) => !Number.isNaN(x));
    const maxCost = costs.length > 0 ? Math.max(...costs) : 1;
    return candidates.map((c): CandidateResult<RoleCandidate> => {
      let normalized = 0.5;
      if (typeof c.role.modelCost === 'number' && maxCost > 0) {
        normalized = c.role.modelCost / maxCost; // higher cost → higher signal → penalized
      }
      return { ok: true, candidate: { ...c, signals: { ...c.signals, modelCost: normalized } } };
    });
  }
  update(c: RoleCandidate, s: RoleCandidate): void { c.signals = s.signals; }
}

/** Reuse candidates get a flat 1.0 bonus; spawn gets 0. */
export class ReuseBonusScorer implements Scorer<RolePipelineQuery, RoleCandidate> {
  readonly name = 'reuse_bonus';
  enable(): boolean { return true; }
  async score(
    _q: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<CandidateResult<RoleCandidate>[]> {
    return candidates.map((c): CandidateResult<RoleCandidate> => ({
      ok: true,
      candidate: { ...c, signals: { ...c.signals, reuseBonus: c.kind === 'reuse' ? 1 : 0 } },
    }));
  }
  update(c: RoleCandidate, s: RoleCandidate): void { c.signals = s.signals; }
}

export class WeightedFusionScorer implements Scorer<RolePipelineQuery, RoleCandidate> {
  readonly name = 'weighted_fusion';
  enable(): boolean { return true; }
  async score(
    _q: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<CandidateResult<RoleCandidate>[]> {
    return candidates.map((c): CandidateResult<RoleCandidate> => {
      const ws = weightedSum([
        { name: 'taskAffinity',   value: c.signals.taskAffinity   ?? 0, weight: DEFAULT_WEIGHTS.taskAffinity },
        { name: 'historySuccess', value: c.signals.historySuccess ?? 0, weight: DEFAULT_WEIGHTS.historySuccess },
        { name: 'modelCost',      value: c.signals.modelCost      ?? 0, weight: DEFAULT_WEIGHTS.modelCost },
        { name: 'reuseBonus',     value: c.signals.reuseBonus     ?? 0, weight: DEFAULT_WEIGHTS.reuseBonus },
      ]);
      return { ok: true, candidate: { ...c, score: ws.score } };
    });
  }
  update(c: RoleCandidate, s: RoleCandidate): void { c.score = s.score; }
}

// ─── Selector ──────────────────────────────────────────────────────────
//
// Top-K with diversity: at most one reuse for any given role, then top-K
// by score. Reuse candidates are preferred when they tie with a fresh
// spawn for the same role (since reuse signal already lifts them).

export class DiverseTopKSelector implements Selector<RolePipelineQuery, RoleCandidate> {
  readonly name = 'diverse_top_k';
  constructor(private defaultK = 3) {}
  enable(): boolean { return true; }
  size(): number | undefined { return this.defaultK; }
  score(c: RoleCandidate): number { return c.score; }
  select(query: RolePipelineQuery, candidates: RoleCandidate[]): SelectResult<RoleCandidate> {
    const k = query.k ?? this.defaultK;
    // Sort by score desc.
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const seenRoles = new Set<string>();
    const selected: RoleCandidate[] = [];
    const nonSelected: RoleCandidate[] = [];
    for (const c of ranked) {
      if (selected.length >= k) { nonSelected.push(c); continue; }
      if (seenRoles.has(c.role.role)) { nonSelected.push(c); continue; }
      selected.push(c);
      seenRoles.add(c.role.role);
    }
    return { selected, nonSelected };
  }
}

// ─── Hash helper ───────────────────────────────────────────────────────

async function hashTaskText(text: string): Promise<string> {
  // Lightweight FNV-1a — avoids a node:crypto dep for simple bucketing.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
