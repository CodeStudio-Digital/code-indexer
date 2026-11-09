import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { sessionProviderSwitches, switchSessionProvider } from '../../hooks/agent-stream/provider-switch.js';
import type { CoderSession, SessionData } from './types.js';

interface Options {
  selectedId: string | null;
  sessionData: SessionData | null;
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  updateSessionData: (fn: (data: SessionData) => SessionData) => void;
  refetchSessions: () => void;
}

function encodedModel(session: CoderSession): string {
  return session.model_mode && !session.model.includes('::')
    ? `${session.model}::${session.model_mode}` : session.model;
}

export function useSessionProvider({
  selectedId, sessionData, setProvider, setModel, updateSessionData, refetchSessions,
}: Options) {
  const subscribe = useCallback((listener: () => void) => selectedId
    ? sessionProviderSwitches.subscribe(selectedId, listener) : () => {}, [selectedId]);
  const snapshot = useCallback(() => selectedId ? sessionProviderSwitches.snapshot(selectedId) : null, [selectedId]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const observed = useRef({ id: selectedId, state });
  const savedId = sessionData?.session.id;
  const savedProvider = sessionData?.session.provider;
  const savedModel = sessionData ? encodedModel(sessionData.session) : undefined;

  // Refetches cannot overwrite the user's selection while it is being saved
  // or after a rejected write. A different session hydrates only its own row.
  useEffect(() => {
    if (!savedId || savedId !== selectedId || !savedProvider || !savedModel) return;
    const change = sessionProviderSwitches.snapshot(savedId);
    if (change?.pending || change?.error) return;
    setProvider(savedProvider);
    setModel(savedModel);
  }, [selectedId, savedId, savedProvider, savedModel, setProvider, setModel]);

  useEffect(() => {
    const changed = observed.current.id === selectedId && observed.current.state !== state;
    observed.current = { id: selectedId, state };
    if (!selectedId || !state || (!state.pending && !state.error && !changed)) return;
    setProvider(state.selection.provider);
    setModel(state.selection.model);
    if (state.pending || state.error) return;
    // Update the header from the server acknowledgement, never the optimistic
    // picker. This also works when the old session payload hasn't loaded yet.
    updateSessionData((data) => {
      if (data.session.id !== selectedId) return data;
      const [model, mode = ''] = state.selection.model.split('::');
      return { ...data, session: {
        ...data.session, provider: state.selection.provider, model, model_mode: mode || undefined,
      } };
    });
    refetchSessions();
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
  }, [selectedId, state, setProvider, setModel, updateSessionData, refetchSessions]);

  const onSwitchProvider = useCallback((provider: string, model: string) => {
    setProvider(provider);
    setModel(model);
    if (selectedId) void switchSessionProvider(selectedId, provider, model).catch(() => {});
  }, [selectedId, setProvider, setModel]);

  const retry = useCallback(() => {
    if (state) onSwitchProvider(state.selection.provider, state.selection.model);
  }, [state, onSwitchProvider]);

  return { onSwitchProvider, providerChange: state, retryProviderChange: retry };
}
