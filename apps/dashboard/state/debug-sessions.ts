import { create } from 'zustand';
import type { DebugSessionSummary, DebugStartInput } from '@mcp/api-bus';
import { apiCall, apiStream, electronApi } from '../lib/api-client.js';

interface DebugSessionsState {
  sessions: DebugSessionSummary[];
  started: boolean;
  setSessions: (sessions: DebugSessionSummary[]) => void;
}

export const useDebugSessions = create<DebugSessionsState>((set) => ({
  sessions: [],
  started: false,
  setSessions: (sessions) => set({ sessions }),
}));

export function initDebugSessions(): void {
  if (useDebugSessions.getState().started || !electronApi()) return;
  useDebugSessions.setState({ started: true });
  void (async () => {
    for (;;) {
      try {
        const stream = apiStream<DebugSessionSummary[]>('debug.events', {});
        for await (const snapshot of stream) useDebugSessions.getState().setSessions(snapshot);
      } catch {
        // Main-process reload or channel close: back off and reconnect.
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  })();
}

export async function startDebugSession(input: DebugStartInput): Promise<DebugSessionSummary> {
  return apiCall<DebugSessionSummary>('debug.start', input);
}

export async function stopDebugSession(sessionId: string): Promise<void> {
  await apiCall('debug.stop', { sessionId });
}

export function activeDebugSessionForProject(
  sessions: DebugSessionSummary[],
  projectId: number,
): DebugSessionSummary | undefined {
  return sessions
    .filter((session) => session.projectId === projectId && !['terminated', 'error'].includes(session.state))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}
