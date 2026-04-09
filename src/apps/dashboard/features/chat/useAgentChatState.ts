import { useEffect, useState } from 'react';
import type { AssistantTurn } from '../../hooks/useAgentStream.js';
import type {
  CoderSessionStats,
  EnrichedProvider,
  EnrichedProviderModel,
  PersistedTasksState,
  ProviderOption,
  SessionData,
} from './types.js';
import { PROVIDERS } from './constants.js';
import { getCurrentTurnText, getPersistedAssistantText } from './utils.js';

interface UseAgentChatStateArgs {
  selectedId: number | null;
  doneReason: string | null;
  sessionData: SessionData | null;
  currentTurn: AssistantTurn | null;
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
  sessionData,
  currentTurn,
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

  // Persisted task list state — refetched on session select and on every run
  // completion so MessageView can display live runtime status on old sessions.
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
  }, [selectedId, doneReason]);

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

  const providerOptions: ProviderOption[] =
    enrichedProviders.length > 0
      ? enrichedProviders.map((p) => ({ id: p.id, label: p.name, models: p.models }))
      : PROVIDERS.map((p) => ({ id: p.id, label: p.label, models: [] as EnrichedProviderModel[] }));
  const currentProviderModels = providerOptions.find((p) => p.id === provider)?.models ?? [];

  // Detect whether the current live turn was just persisted to the DB. When
  // true, the message list hides the live AssistantBubble to avoid showing
  // the same content twice during the brief refetch window.
  const liveTurnDuplicatedInHistory = (() => {
    if (!sessionData || !currentTurn || currentTurn.blocks.length === 0) return false;
    const lastAssistant = [...sessionData.messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant) return false;
    const persistedText = getPersistedAssistantText(lastAssistant).trim();
    const liveText = getCurrentTurnText(currentTurn).trim();
    if (!persistedText || !liveText) return false;
    return persistedText === liveText;
  })();

  return {
    providerOptions,
    currentProviderModels,
    tasksState,
    stats,
    liveTurnDuplicatedInHistory,
  };
}
