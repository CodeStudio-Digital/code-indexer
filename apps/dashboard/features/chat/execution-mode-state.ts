import type { CoderSession, EnrichedProviderModel, ExecutionMode, ProviderOption, SessionId, SessionData } from './types.js';

/** New conversations must opt into Ultra explicitly. */
export const DEFAULT_NEW_EXECUTION_MODE: ExecutionMode = 'standard';

interface SerializedAsyncQueue {
  enqueue: (task: () => Promise<void>) => Promise<void>;
  wait: () => Promise<void>;
}

/** Minimal promise chain used to keep mode mutations ordered before sends. */
export function createSerializedAsyncQueue(): SerializedAsyncQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(task) {
      const run = tail.catch(() => undefined).then(task);
      tail = run;
      return run;
    },
    wait() {
      // A failed PATCH is reconciled by the hook; callers only need the queue
      // to be settled before constructing the next runner.
      return tail.catch(() => undefined);
    },
  };
}

function normalizedValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLegacyUltraEffort(value: unknown): boolean {
  return normalizedValue(value)?.toLowerCase() === 'ultra';
}

/**
 * Resolve a session payload without ever applying a stale row from the
 * previously selected conversation. Legacy rows that still carry `ultra` in
 * the provider-effort column are rendered as the product execution profile.
 */
export function hydratedExecutionMode(
  session: CoderSession | null | undefined,
  selectedId: SessionId | null,
): ExecutionMode | null {
  if (!session || selectedId == null || session.id !== selectedId) return null;
  if (session.execution_mode_override === 'ultra' || isLegacyUltraEffort(session.reasoning_effort_override)) {
    return 'ultra';
  }
  return 'standard';
}

/** Never expose the legacy product marker as a provider-native wire effort. */
export function hydratedReasoningEffort(
  session: CoderSession | null | undefined,
  selectedId: SessionId | null,
): string | null | undefined {
  if (!session || selectedId == null || session.id !== selectedId) return undefined;
  const effort = normalizedValue(session.reasoning_effort_override);
  return effort && !isLegacyUltraEffort(effort) ? effort : null;
}

export function selectedProviderModel(
  providerId: string | null | undefined,
  providerOptions: ProviderOption[],
  model?: string | null,
): EnrichedProviderModel | null {
  if (!providerId || !model) return null;
  const option = providerOptions.find((candidate) => candidate.id === providerId);
  if (!option) return null;
  const [bare, mode] = model.split('::');
  const selectedMode = mode ?? '';
  return option.models.find(
    (candidate) => candidate.id === bare && (candidate.mode ?? '') === selectedMode,
  ) ?? null;
}

/** Dashboard-visible approximation of the persisted `can_reason` capability. */
export function modelCanReason(
  providerId: string | null | undefined,
  providerOptions: ProviderOption[],
  model?: string | null,
): boolean {
  const match = selectedProviderModel(providerId, providerOptions, model);
  if (!match) return false;
  if (match.can_reason === true) return true;
  if (normalizedValue(match.default_reasoning_level) && !isLegacyUltraEffort(match.default_reasoning_level)) return true;
  return (match.supported_reasoning_levels ?? []).some(
    (level) => normalizedValue(level) !== null && !isLegacyUltraEffort(level),
  );
}

export function ultraManagesThinking(
  executionMode: ExecutionMode,
  canReason: boolean,
): boolean {
  void executionMode; void canReason;
  return false;
}

export function executionModeChangeLocked(
  streaming: boolean,
  sessionStatus: string | null | undefined,
  payloadSessionId?: SessionId | null,
  selectedId?: SessionId | null,
): boolean {
  const payloadMatchesSelection = payloadSessionId == null
    || selectedId == null
    || payloadSessionId === selectedId;
  return streaming || (payloadMatchesSelection && sessionStatus === 'running');
}

/** Merge a mutation response/event only into the matching session cache. */
export function mergeExecutionModeSessionData(
  data: SessionData,
  sessionId: SessionId,
  mode: ExecutionMode,
  response?: CoderSession | null,
): SessionData {
  if (data.session.id !== sessionId) return data;
  return {
    ...data,
    session: {
      ...data.session,
      ...(response?.id === sessionId ? response : {}),
      execution_mode_override: mode,
      // A successful product-mode write supersedes any stale legacy marker.
      reasoning_effort_override: isLegacyUltraEffort(
        response?.reasoning_effort_override ?? data.session.reasoning_effort_override,
      )
        ? null
        : (response?.reasoning_effort_override ?? data.session.reasoning_effort_override),
    },
  };
}
