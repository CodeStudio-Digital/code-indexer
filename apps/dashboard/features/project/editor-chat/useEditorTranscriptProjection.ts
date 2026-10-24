import { useMemo, useRef } from 'react';
import type { useAgentCurrentTurn } from '../../../hooks/useAgentStream.js';
import type { PersistedTasksState, SessionData } from '../../chat/types.js';
import { buildTranscriptProjection } from '../../chat/transcript-projection.js';
import { liveTurnReconciliationRevision } from '../../chat/utils.js';
export function useEditorTranscriptProjection(selectedSessionData: SessionData | null,
  currentTurn: ReturnType<typeof useAgentCurrentTurn>, tasksState: PersistedTasksState | null,
) {
  const historyProjection = useMemo(
    () => buildTranscriptProjection(selectedSessionData, null, tasksState),
    [selectedSessionData, tasksState],
  );
  const currentTurnRef = useRef(currentTurn);
  currentTurnRef.current = currentTurn;
  const liveReconciliationRevision = liveTurnReconciliationRevision(
    currentTurn,
    historyProjection.reconciliation.tailTextLength,
    historyProjection.reconciliation.tailThinkingLength,
  );
  const transcriptProjection = useMemo(
    () => buildTranscriptProjection(selectedSessionData, currentTurnRef.current, tasksState),
    [selectedSessionData, tasksState, liveReconciliationRevision],
  );


  return transcriptProjection;
}
