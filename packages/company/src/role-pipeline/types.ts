/**
 * Types for the RolePipeline.
 *
 * Goal: pick the right subordinate role to spawn for a given task. Mirrors
 * the multi-source fan-out + BlenderSelector pattern from `home-mixer`
 * (xai-org/x-algorithm), adapted to the company-orchestration domain.
 *
 * Two sources:
 *   - TemplateRosterSource: roles defined in the active company template
 *   - ActiveIdleRunsSource: idle subordinates from past spawns, eligible
 *     for REUSE instead of a fresh spawn
 *
 * The selector blends both sources with a small reuse bonus.
 */
import type { PipelineCandidate, PipelineQuery } from '@mcp/candidate-pipeline';
import type { SubordinateDisableContext, SubordinateDisableRule } from './disable-rules.js';
import type { RoleContextPayload } from './role-context-hydrator.js';

export interface RoleDescriptor {
  /** Stable role name within the template (`frontend`, `qa`, `backend`, …). */
  role: string;
  /** Free-form description of what this role does. */
  description: string;
  /** Configured skill list — for fit assessment. */
  skills?: string[];
  /** Preferred model id; the resolver may override per binding. */
  preferredModel?: string;
  /** Estimated cost per token (USD or relative units; only used for sort). */
  modelCost?: number;
  /** Maximum concurrent runs allowed for this role. */
  concurrencyCap?: number;
  /**
   * Optional declarative skip rules (C2 — Sprint 1). Evaluated in order
   * by `DisableRulesFilter` against `RolePipelineQuery.disableContext`.
   * Absent → role is never auto-disabled (legacy behavior). See
   * `./disable-rules.ts` for pre-built rules and the contract.
   */
  disableRules?: SubordinateDisableRule[];
}

export interface IdleRunDescriptor {
  /** Reused independent agent-run UUID. */
  agentRunId: string;
  /** The role this idle run was originally spawned for. */
  role: string;
  /** Tokens already consumed by this run (so cost continues from there). */
  tokensConsumed?: number;
  /** Optional last activity timestamp — older idles ought to be reused first. */
  lastActiveAtMs?: number;
}

export interface RolePipelineQuery extends PipelineQuery {
  /** The task to satisfy — usually the user message + relevant kanban card. */
  taskText: string;
  /** Pre-computed task embedding (set by QueryHydrator). */
  taskEmbedding?: Float32Array;
  /** Vector-space identity pinned together with taskEmbedding. */
  embeddingFingerprint?: string;
  /** All roles available in the current template. */
  availableRoles: RoleDescriptor[];
  /** Idle subordinates that could be reactivated. */
  idleRuns?: IdleRunDescriptor[];
  /** Currently RUNNING subordinates (used for capacity filter). */
  runningByRole?: Record<string, number>;
  /** Kanban-blocked roles (filtered out unconditionally). */
  blockedRoles?: string[];
  /** Top-K cap. Defaults to 3 (the plan's "top-3 suggestions" target). */
  k?: number;
  /**
   * Optional context for `RoleDescriptor.disableRules` (C2 — Sprint 1).
   * Pass the workflow state (which roles were skipped, failed, are
   * running). Absent → rules evaluated against an empty context = never
   * fire. See `./disable-rules.ts`.
   */
  disableContext?: SubordinateDisableContext;
}

export interface RoleCandidate extends PipelineCandidate {
  /** Either a fresh-spawn candidate or an idle-reuse candidate. */
  kind: 'spawn' | 'reuse';
  /** Role descriptor (always present). */
  role: RoleDescriptor;
  /** Idle run reference when kind === 'reuse'. */
  idleRun?: IdleRunDescriptor;
  /** Pre-computed role-description embedding. */
  roleEmbedding?: Float32Array;
  /** Cached signals from each scorer + diagnostics from filters. */
  signals: {
    taskAffinity?: number;
    historySuccess?: number;
    modelCost?: number;
    reuseBonus?: number;
    /** C2 — set to 1 by `DisableRulesFilter` when a rule short-circuited the candidate. */
    disabledByRule?: number;
    /** C2 — human reason from the rule that fired. */
    disableReason?: string;
    /** C2 — rule name for telemetry diff. */
    disableRuleName?: string;
  };
  /** Final fused score (higher = better). */
  score: number;
  /**
   * C4 — post-selection context payload populated by `RoleContextHydrator`
   * for the top-K candidates only. Absent when the hydrator wasn't
   * wired or the fetch failed (best-effort). The orchestrator can use
   * this to seed the role's system prompt with relevant files/cards
   * BEFORE the subordinate spawns, so its first turn is informed.
   */
  roleContext?: RoleContextPayload;
}

export const DEFAULT_TOP_K = 3;
export const DEFAULT_WEIGHTS = {
  taskAffinity:   +1.0,
  historySuccess: +0.6,
  modelCost:      -0.3, // negative — cheaper models score higher
  reuseBonus:     +0.4,
};
