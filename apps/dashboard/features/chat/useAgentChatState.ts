import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CoderSessionStats,
  EnrichedProvider,
  EnrichedProviderModel,
  PersistedTasksState,
  ProviderOption,
  SessionId,
  SessionData,
} from './types.js';
import { PROVIDERS } from './constants.js';
import { collectPersistedToolUseIds } from './utils.js';
import { sortClaudeCodeModels } from '../../lib/claude-code-model-order.js';

interface UseAgentChatStateArgs {
  selectedId: SessionId | null;
  doneReason: string | null;
  /** Bumped on `tasks_posted` + `message_complete` so the persisted task card
   *  refetches the latest list/approval mid-run, not only on run end. */
  tasksRefreshTick: number;
  sessionData: SessionData | null;
  provider: string;
}

/**
 * Owns the side-effects layer of AgentChat: fetches the enriched provider
 * list, the persisted task state, the session stats, and computes the
 * "live turn already in DB" guard. Returns the derived values used by the
 * shell. Keeps AgentChat under the 300L cap by isolating effects here.
 */
export function useAgentChatState({
  selectedId,
  doneReason,
  tasksRefreshTick,
  sessionData,
  provider,
}: UseAgentChatStateArgs) {
  const [enrichedProviders, setEnrichedProviders] = useState<EnrichedProvider[]>([]);
  const [tasksResult, setTasksResult] = useState<{ sessionId: SessionId; state: PersistedTasksState } | null>(null);
  const tasksState = tasksResult?.sessionId === selectedId ? tasksResult.state : null;
  const [statsResult, setStatsResult] = useState<{ sessionId: SessionId; stats: CoderSessionStats } | null>(null);
  const stats = statsResult?.sessionId === selectedId ? statsResult.stats : null;

  // Pull the DB-backed provider/model list from /api/coder/providers (enriched
  // shape served by src/api/server.ts). Falls back to the static PROVIDERS
  // constant when the server returns `legacy: true` so the UI keeps working.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/coder/providers')
      .then((r) => r.json())
      .then((j: { providers: unknown; legacy?: boolean }) => {
        if (cancelled) return;
        if (!j.legacy && Array.isArray(j.providers) && j.providers.length > 0) {
          setEnrichedProviders(j.providers as EnrichedProvider[]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Persisted task list state — refetched on session select, on every run
  // completion, AND whenever the task list identity/approval changes mid-run
  // (tasksRefreshTick) so the TaskListReview card never shows a stale list or
  // lingering Approve buttons after the user approves a fresh proposal.
  useEffect(() => {
    if (!selectedId) {
      setTasksResult(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/coder/sessions/${selectedId}/tasks`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!controller.signal.aborted) setTasksResult(d ? { sessionId: selectedId, state: d } : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setTasksResult(null);
      });
    return () => {
      controller.abort();
    };
  }, [selectedId, doneReason, tasksRefreshTick]);

  // Aggregate session stats — fetched on session select and on every run completion.
  useEffect(() => {
    if (!selectedId) {
      setStatsResult(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/coder/sessions/${selectedId}/stats`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!controller.signal.aborted) setStatsResult(d ? { sessionId: selectedId, stats: d } : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatsResult(null);
      });
    return () => {
      controller.abort();
    };
  }, [selectedId, doneReason]);

  // Memoized so the returned references stay stable across the parent's
  // frequent re-renders (click/stream churn). An inline `.map(...)` here would
  // hand AgentChat a fresh array every render, silently defeating the
  // React.memo on <Composer> (which takes providerOptions/currentProviderModels
  // as props). Only recomputes when the underlying provider list changes.
  const providerOptions: ProviderOption[] = useMemo(
    () =>
      enrichedProviders.length > 0
        ? enrichedProviders.map((p) => ({
            id: p.id,
            label: p.name,
            kind: p.kind,
            models: p.kind === 'claude-code'
              ? sortClaudeCodeModels(p.models, (model) => model.id, (model) => model.name)
              : p.models,
            // Without this, providerSupportsThinking() can't see supportsThinking
            // and the Thinking chip never renders — bug existed since the
            // capability flag was introduced (Composer used the same hook).
            capabilities: p.capabilities,
          }))
        : PROVIDERS.map((p) => ({ id: p.id, label: p.label, models: [] as EnrichedProviderModel[] })),
    [enrichedProviders],
  );
  const currentProviderModels = useMemo(
    () => providerOptions.find((p) => p.id === provider)?.models ?? [],
    [providerOptions, provider],
  );

  // The set of assistant tool_use ids already in persisted history. Lets the
  // live turn suppress gate cards (submit_tasks/submit_plan/decision_gate/…)
  // that the refetched history already renders. Memoized on sessionData so it
  // does NOT recompute on every token flush (currentTurn churn).
  const persistedToolUseIds = useMemo(
    () => collectPersistedToolUseIds(sessionData?.messages ?? []),
    [sessionData],
  );

  // Stable identity (deps: providerOptions) so passing it to the memoized
  // <Composer> doesn't bust the memo on every parent render.
  const getModelsForProvider = useCallback(
    (providerId: string): EnrichedProviderModel[] =>
      providerOptions.find((p) => p.id === providerId)?.models ?? [],
    [providerOptions],
  );

  return {
    providerOptions,
    currentProviderModels,
    getModelsForProvider,
    tasksState,
    stats,
    persistedToolUseIds,
  };
}
