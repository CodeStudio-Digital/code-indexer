/**
 * Resolve whether a run must close an explicit goal lifecycle even before the
 * tool ledger contains substantive work.
 *
 * Fresh runs trust only the validated task-preflight kind supplied by the
 * host. Resumed runs may rehydrate that one field from the durable preflight
 * cache while the original goal is still absent/in progress. Once the goal is
 * complete, ordinary follow-up conversation returns to ledger-based gating.
 */
import type { AgentMessage } from '@mcp/provider-sdk';

export type GoalLifecycleIntent =
  | 'required_fresh'
  | 'required_pivot'
  | 'required_resume'
  | 'ledger';
export interface GoalLifecycleAuthority {
  intent: GoalLifecycleIntent;
  /** Exact inherited goal generation that the user's explicit pivot may close. */
  pivotGoalCreatedAt: string | null;
}
export const GOAL_LIFECYCLE_INTENT_CACHE_VERSION = 1;

const ACTIONABLE_TASK_KINDS = new Set([
  'bugfix',
  'feature',
  'refactor',
  'config',
  'test',
]);
const ACTIONABLE_TURN_INTENTS = new Set([
  'edit',
  'verify',
  'git_admin',
  'preview',
  'diagram',
  'api_collection',
  'plan',
]);
const CONTINUATION_DIRECTIVE =
  /^\s*(?:continue|continue working|keep going|go ahead|prossiga|siga(?: em frente)?|faça isso|do it)\b/i;
const EXPLICIT_PIVOT_PATTERNS = [
  /\b(?:new|different)\s+(?:task|goal|objective|request)\b/i,
  /\b(?:nova|outra|diferente)\s+(?:tarefa|meta|objetivo|pedido)\b/i,
  /\b(?:stop|cancel|abandon|forget)\s+(?:that|this|the\s+(?:task|goal|objective|request))\b/i,
  /\b(?:pare|cancele|abandone|deixe)\s+(?:isso|isto|essa\s+tarefa|este\s+objetivo|o\s+pedido)\b/i,
  /\b(?:switch|change|replace)\s+(?:(?:the|this|current)\s+)(?:task|goal|objective|request|scope|focus)\b/i,
  /\b(?:switch|change|replace)\s+to\s+.{0,40}\b(?:task|goal|objective|request)\b/i,
  /\b(?:troque|mude|substitua)\s+(?:(?:o|a|este|esta|esse|essa|atual)\s+)?(?:objetivo|meta|tarefa|pedido|escopo|foco)\b/i,
  /\b(?:troque|mude|substitua)\s+para\s+.{0,40}\b(?:tarefa|meta|objetivo|pedido)\b/i,
] as const;

function isExplicitPivot(message: string): boolean {
  return EXPLICIT_PIVOT_PATTERNS.some((pattern) => pattern.test(message));
}

function actionableTaskKind(value: unknown): boolean {
  return typeof value === 'string'
    && ACTIONABLE_TASK_KINDS.has(value.trim().toLowerCase());
}

function cachedTaskKind(
  raw: string | null | undefined,
  allowUnmarked = false,
): unknown {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
      !allowUnmarked
      && record.goalLifecycleIntentVersion !== GOAL_LIFECYCLE_INTENT_CACHE_VERSION
    ) {
      return undefined;
    }
    // Current HTTP cache shape is { h, seed }; a marked direct seed is also
    // accepted for non-HTTP hosts. Deliberately rehydrate no field except
    // taskKind.
    const seed = record.seed && typeof record.seed === 'object' && !Array.isArray(record.seed)
      ? record.seed as Record<string, unknown>
      : record;
    return seed.taskKind;
  } catch {
    return undefined;
  }
}

function cachedLifecycleMarker(raw: string | null | undefined): {
  required: boolean | undefined;
  pendingSince: string | null;
  pivotGoalCreatedAt: string | null;
} {
  if (!raw) return { required: undefined, pendingSince: null, pivotGoalCreatedAt: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { required: undefined, pendingSince: null, pivotGoalCreatedAt: null };
    }
    const record = parsed as Record<string, unknown>;
    if (record.goalLifecycleIntentVersion !== GOAL_LIFECYCLE_INTENT_CACHE_VERSION) {
      return { required: undefined, pendingSince: null, pivotGoalCreatedAt: null };
    }
    return {
      required: typeof record.goalLifecycleRequired === 'boolean'
        ? record.goalLifecycleRequired
        : undefined,
      pendingSince: typeof record.goalLifecyclePendingSince === 'string'
        ? record.goalLifecyclePendingSince
        : null,
      pivotGoalCreatedAt: typeof record.goalLifecyclePivotGoalCreatedAt === 'string'
        ? record.goalLifecyclePivotGoalCreatedAt
        : null,
    };
  } catch {
    return { required: undefined, pendingSince: null, pivotGoalCreatedAt: null };
  }
}

function pendingMarkerStillApplies(
  marker: ReturnType<typeof cachedLifecycleMarker>,
  persistedGoalCreatedAt: string | null | undefined,
): boolean {
  if (marker.required !== true) return false;
  if (
    marker.pivotGoalCreatedAt !== null
    && marker.pivotGoalCreatedAt === (persistedGoalCreatedAt ?? null)
  ) {
    return true;
  }
  if (!persistedGoalCreatedAt || !marker.pendingSince) return true;
  const goalCreatedAt = Date.parse(persistedGoalCreatedAt);
  const pendingSince = Date.parse(marker.pendingSince);
  // Invalid/legacy timestamps fail closed. A goal created at or after the
  // pending marker is the new objective's goal and satisfies this marker.
  if (!Number.isFinite(goalCreatedAt) || !Number.isFinite(pendingSince)) return true;
  return goalCreatedAt < pendingSince;
}

function currentTurnRequiresGoal(input: {
  currentTurnIntent?: unknown;
  currentTurnConfidence?: number;
  currentTurnMessage?: string;
}): boolean {
  if (CONTINUATION_DIRECTIVE.test(input.currentTurnMessage ?? '')) return true;
  return typeof input.currentTurnIntent === 'string'
    && ACTIONABLE_TURN_INTENTS.has(input.currentTurnIntent)
    && (input.currentTurnConfidence ?? 0) >= 0.6;
}

/**
 * Recover the exact legacy failure that motivated durable lifecycle intent.
 * Persisted provider blocks use the canonical wire spelling `is_error`.
 */
export function hasLegacyMissingGoalCompletionAttempt(
  messages: readonly AgentMessage[],
): boolean {
  const updateGoalUseIds = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'update_goal') {
        updateGoalUseIds.add(block.id);
        continue;
      }
      if (
        block.type === 'tool_result'
        && updateGoalUseIds.has(block.tool_use_id)
        && block.is_error === true
        && /\bno goal set\b/i.test(block.content)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Add the lifecycle authority marker without discarding the HTTP cache hash or
 * any validated preflight fields. Malformed/absent caches are replaced by the
 * smallest compatible envelope so non-HTTP hosts also get durable retries.
 */
export function markGoalLifecycleIntentCache(
  raw: string | null | undefined,
  taskKind: unknown,
  options: {
    /** Explicit pending state; omitted derives from/preserves task authority. */
    required?: boolean;
    /**
     * Exact inherited goal generation authorized for superseding. Pass null
     * for an ordinary fresh objective so stale pivot authority is removed.
     */
    pivotGoalCreatedAt?: string | null;
    /** Injectable for deterministic tests. */
    now?: string;
  } = {},
): string {
  const normalizedTaskKind = typeof taskKind === 'string'
    ? taskKind.trim().toLowerCase()
    : undefined;
  const now = options.now ?? new Date().toISOString();
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const required = options.required
        ?? (record.goalLifecycleRequired === true || actionableTaskKind(normalizedTaskKind));
      const existingPendingSince = typeof record.goalLifecyclePendingSince === 'string'
        ? record.goalLifecyclePendingSince
        : null;
      const existingPivotGoalCreatedAt =
        typeof record.goalLifecyclePivotGoalCreatedAt === 'string'
          ? record.goalLifecyclePivotGoalCreatedAt
          : null;
      const pivotGoalCreatedAt = required
        ? options.pivotGoalCreatedAt === undefined
          ? existingPivotGoalCreatedAt
          : options.pivotGoalCreatedAt
        : null;
      const lifecycleFields = required
        ? {
            goalLifecycleRequired: true,
            goalLifecyclePendingSince: options.required === true
              ? now
              : existingPendingSince ?? now,
            ...(pivotGoalCreatedAt !== null
              ? { goalLifecyclePivotGoalCreatedAt: pivotGoalCreatedAt }
              : {}),
          }
        : { goalLifecycleRequired: false };
      const isEnvelope = 'h' in record || 'seed' in record;
      if (isEnvelope) {
        const oldSeed = record.seed && typeof record.seed === 'object' && !Array.isArray(record.seed)
          ? record.seed as Record<string, unknown>
          : {};
        return JSON.stringify({
          ...record,
          seed: {
            ...oldSeed,
            ...(normalizedTaskKind ? { taskKind: normalizedTaskKind } : {}),
          },
          goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
          ...lifecycleFields,
          ...(!required
            ? {
                goalLifecyclePendingSince: undefined,
                goalLifecyclePivotGoalCreatedAt: undefined,
              }
            : pivotGoalCreatedAt === null
              ? { goalLifecyclePivotGoalCreatedAt: undefined }
              : {}),
        });
      }
      return JSON.stringify({
        ...record,
        ...(normalizedTaskKind ? { taskKind: normalizedTaskKind } : {}),
        goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
        ...lifecycleFields,
        ...(!required
          ? {
              goalLifecyclePendingSince: undefined,
              goalLifecyclePivotGoalCreatedAt: undefined,
            }
          : pivotGoalCreatedAt === null
            ? { goalLifecyclePivotGoalCreatedAt: undefined }
            : {}),
      });
    }
  } catch {
    // Replace corrupt cache with the minimal marked seed below.
  }
  const required = options.required ?? actionableTaskKind(normalizedTaskKind);
  const pivotGoalCreatedAt = required ? options.pivotGoalCreatedAt ?? null : null;
  return JSON.stringify({
    goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
    seed: normalizedTaskKind ? { taskKind: normalizedTaskKind } : {},
    goalLifecycleRequired: required,
    ...(required ? { goalLifecyclePendingSince: now } : {}),
    ...(pivotGoalCreatedAt !== null
      ? { goalLifecyclePivotGoalCreatedAt: pivotGoalCreatedAt }
      : {}),
  });
}

interface ResolveGoalLifecycleAuthorityInput {
  hasHistory: boolean;
  freshTaskKind?: unknown;
  cachedPreflightSeedJson?: string | null;
  persistedGoalStatus?: 'in_progress' | 'complete' | 'superseded' | null;
  persistedGoalCreatedAt?: string | null;
  currentTurnIntent?: unknown;
  currentTurnConfidence?: number;
  currentTurnMessage?: string;
  legacyMissingGoalCompletionAttempt?: boolean;
}

export function resolveGoalLifecycleAuthority(
  input: ResolveGoalLifecycleAuthorityInput,
): GoalLifecycleAuthority {
  const turnRequiresGoal = currentTurnRequiresGoal(input);
  if (!input.hasHistory) {
    return {
      intent: actionableTaskKind(input.freshTaskKind) || turnRequiresGoal
        ? 'required_fresh'
        : 'ledger',
      pivotGoalCreatedAt: null,
    };
  }
  const marker = cachedLifecycleMarker(input.cachedPreflightSeedJson);
  if (pendingMarkerStillApplies(marker, input.persistedGoalCreatedAt)) {
    const pivotMatchesPersistedGoal =
      marker.pivotGoalCreatedAt !== null
      && marker.pivotGoalCreatedAt === (input.persistedGoalCreatedAt ?? null);
    return {
      intent: pivotMatchesPersistedGoal ? 'required_pivot' : 'required_fresh',
      pivotGoalCreatedAt: pivotMatchesPersistedGoal ? marker.pivotGoalCreatedAt : null,
    };
  }
  if (input.persistedGoalStatus === 'superseded') {
    // Superseded is only reachable through an explicit pivot. If a crash lands
    // after closing the inherited goal but before create_goal, the terminal
    // status itself remains durable proof that a replacement is still owed.
    return { intent: 'required_fresh', pivotGoalCreatedAt: null };
  }
  if (input.persistedGoalStatus === 'complete') {
    return {
      intent: turnRequiresGoal ? 'required_fresh' : 'ledger',
      pivotGoalCreatedAt: null,
    };
  }
  if (input.persistedGoalStatus === 'in_progress') {
    if (turnRequiresGoal && isExplicitPivot(input.currentTurnMessage ?? '')) {
      return {
        intent: 'required_pivot',
        pivotGoalCreatedAt: input.persistedGoalCreatedAt ?? null,
      };
    }
    return { intent: 'required_resume', pivotGoalCreatedAt: null };
  }
  if (marker.required === false) {
    return {
      intent: turnRequiresGoal ? 'required_fresh' : 'ledger',
      pivotGoalCreatedAt: null,
    };
  }
  if (actionableTaskKind(cachedTaskKind(input.cachedPreflightSeedJson))) {
    return { intent: 'required_resume', pivotGoalCreatedAt: null };
  }
  if (
    input.legacyMissingGoalCompletionAttempt
    && actionableTaskKind(cachedTaskKind(input.cachedPreflightSeedJson, true))
  ) {
    return { intent: 'required_resume', pivotGoalCreatedAt: null };
  }
  return {
    intent: turnRequiresGoal ? 'required_fresh' : 'ledger',
    pivotGoalCreatedAt: null,
  };
}

export function resolveGoalLifecycleIntent(
  input: ResolveGoalLifecycleAuthorityInput,
): GoalLifecycleIntent {
  return resolveGoalLifecycleAuthority(input).intent;
}
