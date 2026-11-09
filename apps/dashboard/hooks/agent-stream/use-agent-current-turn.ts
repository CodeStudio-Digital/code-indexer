import type { AssistantTurn, SessionId } from './types.js';
import { useCallback } from 'react';
import { useVisibleExternalStore } from '../../lib/surface-visibility.js';
import { getAgentCurrentTurnSnapshot, subscribeAgentCurrentTurn } from './session-stream-store.js';

export const ABORT_TERMINAL_EVENT_GRACE_MS = 2_000;

/** Subscribe only the narrow live-transcript surfaces to token/tool frames. */
export function useAgentCurrentTurn(sessionId: SessionId | null): AssistantTurn | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAgentCurrentTurn(sessionId, listener),
    [sessionId],
  );
  const getSnapshot = useCallback(
    () => getAgentCurrentTurnSnapshot(sessionId),
    [sessionId],
  );
  return useVisibleExternalStore(subscribe, getSnapshot);
}
