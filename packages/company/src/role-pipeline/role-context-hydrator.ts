/**
 * RoleContextHydrator (C4 — Sprint 1).
 *
 * Post-selection hydrator that enriches the chosen top-K role candidates
 * with workspace context BEFORE the orchestrator actually spawns them.
 * Mirrors the `home-mixer/post_selection_hydrators` pattern from
 * xai-org/x-algorithm: cheap-per-result enrichment that only pays for
 * the small final set, not the (potentially 100s of) candidates
 * filtered/scored earlier.
 *
 * **What it fetches** is intentionally pluggable — the role-pipeline
 * package does not know about HybridSearch or KanbanService directly.
 * Callers pass a `ContextFetcher` that bridges to those services. When
 * no fetcher is provided, the hydrator is omitted from the pipeline
 * (bit-identical to pre-C4 behavior).
 *
 * **Best-effort**: the framework wraps `hydrate()` in `Promise.allSettled`
 * and the hydrator catches per-candidate errors. A failed fetch leaves
 * the candidate's `roleContext` undefined and the spawn proceeds with
 * the cold-start prompt — same as before C4.
 *
 * **Why post-selection vs pre-selection**: pre-selection would pay the
 * fetch cost N times where N is the full roster (often 8-15 roles).
 * Post-selection runs only on the top-K (default 3) — 3-5× cheaper per
 * recommendation cycle.
 */
import type {
  CandidateResult,
  Hydrator,
} from '@mcp/candidate-pipeline';
import type { RoleCandidate, RolePipelineQuery } from './types.js';

/**
 * Adapter the caller wires to whatever fetches per-role context.
 * Returns a partial `RoleContextPayload`; whatever it returns is merged
 * onto the candidate.
 *
 * Implementations MUST:
 *   - Be idempotent — same candidate twice = same payload (or null).
 *   - Catch their own errors. The hydrator catches too, but caller-side
 *     telemetry is more informative.
 *   - Stay sub-second per candidate (post-selection runs in the response
 *     path; the framework's `Promise.allSettled` parallelizes but each
 *     call blocks the candidate's hydration).
 */
export type ContextFetcher = (
  candidate: RoleCandidate,
  query: RolePipelineQuery,
) => Promise<RoleContextPayload | null>;

export interface RoleContextPayload {
  /** Relevant file paths for the role (e.g. from HybridSearch on the task text). */
  relevantFiles?: ReadonlyArray<{ path: string; score?: number }>;
  /** Kanban card titles assigned to or blocking this role. */
  kanbanCards?: ReadonlyArray<{ id: number; title: string; status?: string }>;
  /** Free-form notes the orchestrator can prepend to the role's system prompt. */
  notes?: string;
}

export interface RoleContextHydratorOptions {
  fetcher: ContextFetcher;
  /** Per-candidate timeout. Default 2000ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`context-fetcher timeout ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export class RoleContextHydrator implements Hydrator<RolePipelineQuery, RoleCandidate> {
  readonly name = 'role_context';
  private readonly timeoutMs: number;

  constructor(private opts: RoleContextHydratorOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Always enabled when a fetcher is provided. */
  enable(): boolean {
    return true;
  }

  async hydrate(
    query: RolePipelineQuery,
    candidates: readonly RoleCandidate[],
  ): Promise<Array<CandidateResult<RoleCandidate>>> {
    // Hydrate in parallel; each failure is local to its candidate.
    return Promise.all(
      candidates.map(async (c): Promise<CandidateResult<RoleCandidate>> => {
        try {
          const payload = await raceWithTimeout(this.opts.fetcher(c, query), this.timeoutMs);
          if (!payload) {
            // null = fetcher decided there's nothing to add. Pass through unchanged.
            return { ok: true, candidate: c };
          }
          return {
            ok: true,
            candidate: { ...c, roleContext: payload },
          };
        } catch (e) {
          // Best-effort — spawn proceeds without the context.
          return {
            ok: false,
            candidateId: c.candidateId,
            error: (e as Error).message ?? 'context-fetcher failed',
          };
        }
      }),
    );
  }

  update(candidate: RoleCandidate, hydrated: RoleCandidate): void {
    candidate.roleContext = hydrated.roleContext;
  }
}
