import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CoderSessionStats,
  EnrichedProvider,
  EnrichedProviderModel,
  PersistedTasksState,
  ProviderOption,
  SessionData,
} from './types.js';
import { PROVIDERS } from './constants.js';
import { collectPersistedToolUseIds } from './utils.js';

interface UseAgentChatStateArgs {
  selectedId: number | null;
  doneReason: string | null;
  /** Bumped on `tasks_posted` + `message_complete` so the persisted task card
   *  refetches the latest list/approval mid-run, not only on run end. */
  tasksRefreshTick: number;
  sessionData: SessionData | null;
  setProvider: (p: string) => void;
  setModel: (m: string) => void;
  provider: string;
  model: string;
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
  setProvider,
  setModel,
  provider,
  model,
}: UseAgentChatStateArgs) {
  const [enrichedProviders, setEnrichedProviders] = useState<EnrichedProvider[]>([]);
  const [tasksState, setTasksState] = useState<PersistedTasksState | null>(null);
  const [stats, setStats] = useState<CoderSessionStats | null>(null);

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
      setTasksState(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/coder/sessions/${selectedId}/tasks`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setTasksState(d);
      })
      .catch(() => {
        if (!cancelled) setTasksState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, doneReason, tasksRefreshTick]);

  // Aggregate session stats — fetched on session select and on every run completion.
  useEffect(() => {
    if (!selectedId) {
      setStats(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/coder/sessions/${selectedId}/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setStats(d);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, doneReason]);

  // Restore provider/model from the selected session so users don't have to
  // re-pick the model every time they switch sessions. Recompose the encoded
  // Select value `modelId::mode` when a mode is present.
  useEffect(() => {
    const s = sessionData?.session;
    if (!s) return;
    if (s.provider && s.provider !== provider) setProvider(s.provider);
    if (s.model) {
      const encoded = s.model_mode ? `${s.model}::${s.model_mode}` : s.model;
      if (encoded !== model) setModel(encoded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, sessionData?.session?.provider, sessionData?.session?.model]);

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
            models: p.models,
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
