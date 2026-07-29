import { useCallback, useMemo, useState } from 'react';
import { Panel, PanelGroup } from 'react-resizable-panels';
import {
  WorkbenchResizeHandle,
  WorkbenchShell,
  WorkbenchSurface,
} from '../../../components/workbench/index.js';
import AgentChat from '../AgentChat.js';
import type { AgentChatWorkbenchSlots } from '../types.js';
import { usePortalHost } from '../../../hooks/usePortalHost.js';

interface GlobalSessionWorkbenchProps {
  initialSessionId?: string;
}

/**
 * Focused global-sessions workspace using the same container grammar as a
 * project: session list on the left, conversation in the center, contextual
 * panel on the right and the session activity rail at the outer edge.
 */
export function GlobalSessionWorkbench({ initialSessionId }: GlobalSessionWorkbenchProps) {
  const [sessionsHostRef, sessionsHost] = usePortalHost<HTMLDivElement>();
  const [rightPanelHostRef, rightPanelHost] = usePortalHost<HTMLDivElement>();
  const [rightRailHostRef, rightRailHost] = usePortalHost<HTMLDivElement>();
  const [sessionState, setSessionState] = useState({
    hasSession: initialSessionId != null,
    rightPanelOpen: false,
  });

  const handleSessionStateChange = useCallback((next: { hasSession: boolean; rightPanelOpen: boolean }) => {
    setSessionState((current) =>
      current.hasSession === next.hasSession && current.rightPanelOpen === next.rightPanelOpen ? current : next,
    );
  }, []);

  const workbenchSlots = useMemo<AgentChatWorkbenchSlots>(() => ({
    sessionsHost,
    rightPanelHost,
    rightRailHost,
    onSessionStateChange: handleSessionStateChange,
  }), [handleSessionStateChange, rightPanelHost, rightRailHost, sessionsHost]);

  return (
    <WorkbenchShell>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-1.5">
          <PanelGroup direction="horizontal" autoSaveId="mcp-global-sessions-workbench">
            <Panel id="global-sessions-list" order={1} defaultSize={20} minSize={14} maxSize={34} className="min-w-0">
              <WorkbenchSurface className="h-full">
                <div ref={sessionsHostRef} className="h-full min-h-0 overflow-hidden" />
              </WorkbenchSurface>
            </Panel>
            <WorkbenchResizeHandle direction="horizontal" />
            <Panel id="global-session-conversation" order={2} minSize={38} className="min-w-0">
              <WorkbenchSurface className="h-full">
                <AgentChat mode="global" initialSessionId={initialSessionId} workbenchSlots={workbenchSlots} />
              </WorkbenchSurface>
            </Panel>
            {sessionState.hasSession && sessionState.rightPanelOpen && (
              <>
                <WorkbenchResizeHandle direction="horizontal" />
                <Panel id="global-session-context" order={3} defaultSize={24} minSize={18} maxSize={42} className="min-w-0">
                  <WorkbenchSurface className="h-full">
                    <div ref={rightPanelHostRef} className="h-full min-h-0 overflow-hidden" />
                  </WorkbenchSurface>
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
        {sessionState.hasSession && <div ref={rightRailHostRef} className="contents" />}
      </div>
    </WorkbenchShell>
  );
}
