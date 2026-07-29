import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiPatch } from '../../hooks/useApi.js';
import { toast } from '../../components/ui/prompt-dialog.js';
import type { CoderSession, ExecutionMode, SessionData, SessionId } from './types.js';
import {
  DEFAULT_NEW_EXECUTION_MODE,
  createSerializedAsyncQueue,
  hydratedExecutionMode,
  mergeExecutionModeSessionData,
} from './execution-mode-state.js';

const EXECUTION_MODE_CHANGED_EVENT = 'coder:session_execution_mode_changed';

interface ExecutionModeChangedDetail {
  sessionId: SessionId;
  mode: ExecutionMode;
  session?: CoderSession;
}

interface UseSessionExecutionModeOptions {
  selectedId: SessionId | null;
  sessionData: SessionData | null;
  updateSessionData: (fn: (previous: SessionData) => SessionData) => void;
  runnerBusy: boolean;
  refetchSession?: () => void;
}

/**
 * Shared Chat/Editor execution-mode state. Writes are serialized, reflected
 * into the matching useApi cache, and broadcast to the sibling surface only
 * after the server acknowledges them.
 */
export function useSessionExecutionMode({
  selectedId,
  sessionData,
  updateSessionData,
  runnerBusy,
  refetchSession,
}: UseSessionExecutionModeOptions) {
  const { t } = useTranslation('chat');
  const [executionMode, setExecutionModeState] = useState<ExecutionMode>(DEFAULT_NEW_EXECUTION_MODE);
  const [pending, setPending] = useState(false);
  const modeRef = useRef(executionMode);
  const selectedIdRef = useRef(selectedId);
  const runnerBusyRef = useRef(runnerBusy);
  const writeQueueRef = useRef(createSerializedAsyncQueue());
  const latestWriteRef = useRef<Promise<void> | null>(null);

  // Keep imperative send/change gates current during render, before effects.
  modeRef.current = executionMode;
  selectedIdRef.current = selectedId;
  runnerBusyRef.current = runnerBusy;

  useEffect(() => {
    const hydrated = hydratedExecutionMode(sessionData?.session, selectedId);
    if (hydrated !== null) {
      modeRef.current = hydrated;
      setExecutionModeState(hydrated);
    } else if (selectedId == null) {
      modeRef.current = DEFAULT_NEW_EXECUTION_MODE;
      setExecutionModeState(DEFAULT_NEW_EXECUTION_MODE);
    }
  }, [selectedId, sessionData?.session]);

  useEffect(() => {
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<ExecutionModeChangedDetail>).detail;
      if (!detail || detail.sessionId !== selectedIdRef.current) return;
      modeRef.current = detail.mode;
      setExecutionModeState(detail.mode);
      updateSessionData((previous) => mergeExecutionModeSessionData(
        previous,
        detail.sessionId,
        detail.mode,
        detail.session,
      ));
    };
    window.addEventListener(EXECUTION_MODE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(EXECUTION_MODE_CHANGED_EVENT, onChanged);
  }, [updateSessionData]);

  const awaitPendingExecutionMode = useCallback(async (): Promise<void> => {
    await writeQueueRef.current.wait();
  }, []);

  const adoptExecutionMode = useCallback((next: ExecutionMode): void => {
    modeRef.current = next;
    setExecutionModeState(next);
  }, []);

  const setExecutionMode = useCallback((next: ExecutionMode): void => {
    const sessionId = selectedIdRef.current;
    if (runnerBusyRef.current) return;
    if (sessionId == null) {
      modeRef.current = next;
      setExecutionModeState(next);
      return;
    }

    const previous = modeRef.current;
    modeRef.current = next;
    setExecutionModeState(next);
    updateSessionData((data) => mergeExecutionModeSessionData(data, sessionId, next));
    setPending(true);

    const operation = writeQueueRef.current.enqueue(async () => {
        const response = await apiPatch<CoderSession>(
          `/coder/sessions/${sessionId}/execution-mode`,
          { mode: next },
        );
        const authoritative = hydratedExecutionMode(response, sessionId) ?? next;
        if (selectedIdRef.current === sessionId) {
          modeRef.current = authoritative;
          setExecutionModeState(authoritative);
          updateSessionData((data) => mergeExecutionModeSessionData(data, sessionId, authoritative, response));
        }
        window.dispatchEvent(new CustomEvent<ExecutionModeChangedDetail>(EXECUTION_MODE_CHANGED_EVENT, {
          detail: { sessionId, mode: authoritative, session: response },
        }));
        window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
      });
    const write = operation
      .catch((error: unknown) => {
        if (selectedIdRef.current === sessionId) {
          modeRef.current = previous;
          setExecutionModeState(previous);
          updateSessionData((data) => mergeExecutionModeSessionData(data, sessionId, previous));
          refetchSession?.();
        }
        toast.error(t('ultra.saveFailed', { defaultValue: 'Could not save Ultra mode.' }), {
          description: error instanceof Error ? error.message : String(error),
        });
      });

    latestWriteRef.current = write;
    void write.finally(() => {
      if (latestWriteRef.current === write) setPending(false);
    });
  }, [refetchSession, t, updateSessionData]);

  return {
    executionMode,
    setExecutionMode,
    executionModePending: pending,
    executionModeLocked: runnerBusy || pending,
    awaitPendingExecutionMode,
    adoptExecutionMode,
  };
}
