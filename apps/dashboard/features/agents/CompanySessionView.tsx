import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useApi } from '../../hooks/useApi.js';
import { useCompanyStream } from '../../hooks/useCompanyStream.js';
import { useCompanySiblings } from '../../hooks/useCompanySiblings.js';
import { useProviders } from '../../hooks/useProviders.js';
import { providerSupportsThinking } from '../chat/composer/provider-caps.js';
import type { AgentAttachment } from '../../hooks/agent-stream/types.js';
import type { MasterPrompt } from '@mcp/company/types.js';
import { AgentSessionModal } from './AgentSessionModal.js';
import { MasterComposer } from './MasterComposer.js';
import { FrontTabsBar } from './FrontTabsBar.js';
import { ResetSessionDialog } from './ResetSessionDialog.js';
import type { RoleConfig, SkillDef } from './RoleEditModal.js';
import { ConnectionPhaseStrip } from './ConnectionPhaseStrip.js';
import { MasterStatusBanner } from './MasterStatusBanner.js';
import { SessionStalledBanner } from './SessionStalledBanner.js';
import { MasterPhaseIndicator } from './session-view/MasterPhaseIndicator.js';
import { ZoneLayout } from './zones/ZoneLayout.js';
import { DEFAULT_TAB_FOR_ZONE, type Zone } from './zones/types.js';
import { buildAgentsUrl, parseAgentsParams } from './routing.js';
import { AgentsSidebar } from './session-view/AgentsSidebar.js';
import { SessionHeader } from './session-view/SessionHeader.js';
import { NewRoleDialog } from './session-view/NewRoleDialog.js';
import { parseConfig } from './session-view/types.js';
import { SidebarRail, type SidePanel } from './preview-sidebar/SidebarRail.js';
import { SidebarPanels } from './preview-sidebar/SidebarPanels.js';
import { useResizableWidth } from '../../hooks/useResizableWidth.js';
import type {
  AvailableProject,
  PersistedAgentRun,
  SessionProject,
} from './session-view/types.js';

interface CompanySessionViewProps {
  sessionId: number;
  sessionName: string;
  sessionStatus: string;
  /**
   * Outer-app sessions-list sidebar toggle (owned by `AgentsTab`).
   * When provided, `SessionHeader` renders a button that controls it
   * — letting us merge the AgentsTab top bar into SessionHeader and
   * show only one bar.
   */
  sessionsListOpen?: boolean;
  onToggleSessionsList?: () => void;
}

interface SessionFullData {
  session: {
    id: number;
    name: string;
    status: string;
    config_json: string;
    template_id: number | null;
    last_user_message?: string | null;
    /** P15c — set when boot recovery flipped this session to `paused`. */
    recovered_at?: string | null;
    recovered_reason?: string | null;
  };
  projects: SessionProject[];
  agentRuns: PersistedAgentRun[];
  recentBoard: Array<{
    id: number;
    author_role: string;
    agent_run_id: number | null;
    kind: string;
    content: string;
    mentions_json: string;
    created_at: string;
  }>;
  /**
   * Pending + recently-resolved master prompts (ask_user / submit_plan).
   * Used to rehydrate `stream.masterPrompts` on first load so a tab that
   * opens with the master already blocked on a question shows the card
   * immediately (no SSE event needed). Backed by the
   * `getCompanySessionFull` route's `masterPrompts` field.
   */
  masterPrompts?: MasterPrompt[];
}

export function CompanySessionView({
  sessionId,
  sessionName,
  sessionStatus,
  sessionsListOpen,
  onToggleSessionsList,
}: CompanySessionViewProps) {
  const { t } = useTranslation('agents');

  // Multi-front (migration 067): the URL identifies the ROOT session
  // (parent of the tab tree). The active tab can be the parent itself
  // ("Main") or any non-archived child. `useCompanyStream` is mounted
  // on the active id, so switching tabs gives us a clean stream of
  // that sub-session's board / agents / prompts.
  const siblings = useCompanySiblings(sessionId);
  const activeSessionId = siblings.activeSessionId ?? sessionId;
  const stream = useCompanyStream(activeSessionId);
  const { data: sessionData, refetch } = useApi<SessionFullData>(
    `/company/sessions/${activeSessionId}`,
  );

  // URL drives zone + tab + active front. `parseAgentsParams` falls back
  // to safe defaults when the URL is incomplete or malformed.
  const routeParams = useParams<{
    rootId?: string;
    frontId?: string;
    zone?: string;
    tab?: string;
  }>();
  const navigate = useNavigate();
  const route = parseAgentsParams(routeParams, sessionId);
  const zone: Zone = route?.zone ?? 'work';
  const tab = route?.tab ?? DEFAULT_TAB_FOR_ZONE.work;
  const activeFrontId = route?.frontId ?? sessionId;
  const handleZoneTabChange = (nextZone: Zone, nextTab: string) => {
    navigate(buildAgentsUrl(sessionId, activeFrontId, nextZone, nextTab));
  };

  // Local UI state — only the bits that the shell coordinates across
  // its children (modal open/close, agent panel collapsed flag).
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  // Right-rail panel selection: `null` collapses the panel and shows
  // only the icon rail. The rail itself is always mounted; Preview is
  // gated on `builderMode` but Inbox / Env / Databases work for every
  // session.
  const [sidePanel, setSidePanel] = useState<SidePanel | null>('preview');
  // Drag-resizable width for whichever right panel is mounted. Width
  // is persisted globally — switching between Preview and Inbox keeps
  // the user's chosen size.
  const sidePanelSizer = useResizableWidth({
    defaultWidth: 448,
    minWidth: 280,
    maxWidth: 960,
    storageKey: 'agents.sidePanel.width',
  });
  const [modalSession, setModalSession] = useState<{
    coderSessionId: number;
    role: string;
    status: string;
  } | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [newRoleDraft, setNewRoleDraft] = useState<RoleConfig | null>(null);

  // Reference data for the sidebar and modals.
  const { data: allProjects } = useApi<AvailableProject[]>('/projects');
  const { data: skillsList } = useApi<{ skills: SkillDef[] }>('/admin/skills');
  const { providerOptions, getModelsForProvider, getDefaultModel } = useProviders();

  // Reset stream state when the active sub-session changes (tab switch
  // or explicit session change). Each sub-session has its own metaBus
  // and own state — re-mounting the hook on a fresh id does the rest.
  useEffect(() => {
    stream.reset();
  }, [activeSessionId]);

  // Hydrate pending master prompts from the initial fetch — a tab that
  // opens while the master is already blocked on `ask_user` would
  // otherwise show nothing until the user pokes the session.
  useEffect(() => {
    if (sessionData?.masterPrompts) {
      stream.hydrateMasterPrompts(sessionData.masterPrompts);
    }
  }, [sessionData?.masterPrompts]);

  // On mount, attempt ONE reattach if the session is already running.
  // We intentionally do NOT put stream.connected in the dep array —
  // it would create an infinite loop (reattach → 404 → connected=false
  // → effect fires → …).
  const reattachAttemptedRef = useRef(false);
  useEffect(() => {
    reattachAttemptedRef.current = false;
    if ((sessionStatus === 'running' || sessionStatus === 'paused') && !stream.connected) {
      reattachAttemptedRef.current = true;
      stream.reattach();
    }
    return () => {
      reattachAttemptedRef.current = false;
    };
  }, [sessionId, sessionStatus]);

  const subordinates = Array.from(stream.subordinateStates.values());
  const config = sessionData ? parseConfig(sessionData.session.config_json) : null;
  const masterProvider = (config?.master_provider as string | undefined) ?? null;
  const masterModel = (config?.master_model as string | undefined) ?? null;
  const masterSupportsThinking = providerSupportsThinking(masterProvider, providerOptions, masterModel);
  const builderMode = !!(
    config &&
    typeof config === 'object' &&
    'builder' in config &&
    (config as { builder?: unknown }).builder
  );

  // For non-builder sessions, the Preview icon is hidden — if the
  // default `'preview'` selection would point at a hidden icon, treat
  // it as collapsed. Explicit toggles later are respected.
  const sidePanelEffective: SidePanel | null =
    sidePanel === 'preview' && !builderMode ? null : sidePanel;
  const togglePanel = (panel: SidePanel) => {
    setSidePanel((cur) => (cur === panel ? null : panel));
  };

  // Session already has a run if status is not idle/draft — use sendMessage, not start.
  const sessionAlreadyRan =
    sessionStatus === 'running' ||
    sessionStatus === 'completed' ||
    sessionStatus === 'paused' ||
    sessionStatus === 'error';

  async function handleSend(
    text: string,
    attachments: AgentAttachment[],
    opts?: { thinking?: boolean },
  ) {
    if (!stream.connected && (sessionAlreadyRan || stream.started)) {
      await stream.resume(text, attachments, opts);
      refetch();
    } else if (!stream.started && !sessionAlreadyRan) {
      await stream.start(text, attachments, opts);
      refetch();
    } else {
      await stream.sendMessage(text, attachments, opts);
    }
  }

  function openAgentRun(agentRunId: number, role: string, status: string) {
    const persistedRun = sessionData?.agentRuns.find((r) => r.id === agentRunId);
    const coderSessionId = persistedRun?.coder_session_id;
    if (coderSessionId) {
      setModalSession({ coderSessionId, role, status });
    }
  }

  function openPersistedRun(coderSessionId: number, role: string, status: string) {
    setModalSession({ coderSessionId, role, status });
  }

  // Merge board from stream and persisted (initial REST fetch).
  const boardMessages = stream.boardMessages.length > 0
    ? stream.boardMessages
    : (sessionData?.recentBoard ?? []).map((b) => ({
        ...b,
        mentions: JSON.parse(b.mentions_json || '[]'),
      }));

  return (
    <div className="flex flex-col h-full">
      <SessionHeader
        sessionId={sessionId}
        sessionName={sessionName}
        sessionStatus={sessionStatus}
        reportedStatus={sessionData?.session.status}
        projects={sessionData?.projects}
        stream={stream}
        siblings={siblings}
        agentPanelOpen={agentPanelOpen}
        onToggleAgentPanel={() => setAgentPanelOpen((v) => !v)}
        sessionsListOpen={sessionsListOpen}
        onToggleSessionsList={onToggleSessionsList}
        recoveredAt={sessionData?.session.recovered_at ?? null}
        recoveredReason={sessionData?.session.recovered_reason ?? null}
        onResetClick={() => setResetDialogOpen(true)}
      />

      <div className="flex-1 flex overflow-hidden">
        <AgentsSidebar
          sessionId={sessionId}
          open={agentPanelOpen}
          config={config}
          projects={sessionData?.projects ?? []}
          allProjects={allProjects ?? null}
          persistedAgentRuns={sessionData?.agentRuns ?? []}
          subordinates={subordinates}
          stream={stream}
          providerOptions={providerOptions}
          getModelsForProvider={getModelsForProvider}
          getDefaultModel={getDefaultModel}
          refetch={refetch}
          onOpenAgentRun={openAgentRun}
          onOpenPersistedRun={openPersistedRun}
          onOpenNewRoleDialog={({ provider, model }) =>
            setNewRoleDraft({ role: '', provider, model, tier: 'navigate' })
          }
        />

        <div className="flex-1 flex flex-col overflow-hidden">
          <ConnectionPhaseStrip phase={stream.connectionPhase} />
          {stream.error && (
            <div className="mx-3 mt-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-destructive flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <p>{stream.error}</p>
            </div>
          )}

          <MasterStatusBanner
            endedAt={stream.masterEndedAt}
            unexpected={stream.masterEndedUnexpected}
            errorDetail={stream.masterErrorDetail}
          />

          <SessionStalledBanner
            stalledSinceMs={stream.sessionStalledSinceMs}
            onContinue={() =>
              stream.sendMessage(
                '[SYSTEM] Status check — any blockers? Update the board with current progress and pick up the next task.',
                [],
              )
            }
          />

          <MasterPhaseIndicator
            started={stream.started}
            masterState={stream.masterState}
            error={stream.error}
            masterAlive={stream.masterAlive}
            pendingMasterInboxCount={stream.pendingMasterInboxCount}
            onWakeMaster={() => void stream.wakeMaster()}
            t={t}
          />

          {/* Front tabs — visible across every zone so the user always
              has a way to switch between Main and child fronts. */}
          {siblings.parent && (
            <FrontTabsBar
              parent={siblings.parent}
              children={siblings.children}
              activeSessionId={siblings.activeSessionId}
              onSelect={siblings.setActiveSessionId}
              onCreate={siblings.createChild}
              onArchive={siblings.archiveChild}
              onRename={siblings.renameChild}
            />
          )}

          {/* Zone-based content area. Replaces the flat 12-tab strip; the
              outer zone selector (Work/Build/Data) plus each zone's inner
              tab strip live inside `<ZoneLayout>`. */}
          <ZoneLayout
            sessionId={sessionId}
            sessionName={sessionName}
            zone={zone}
            tab={tab}
            onZoneTabChange={handleZoneTabChange}
            stream={stream}
            boardMessages={boardMessages}
          />

          <div className="border-t p-3">
            <MasterComposer
              onSend={handleSend}
              placeholder={
                !stream.started && !sessionAlreadyRan
                  ? t('company.inputPlaceholder')
                  : t('company.inputPlaceholderMaster')
              }
              supportsThinking={masterSupportsThinking}
            />
          </div>
        </div>

        {/* Right drawer: drag-resizable content panel + always-on icon
            rail. Preview is gated on builder mode; Inbox / Env /
            Databases work for every session. Sub-sessions share the
            parent's sandbox so we always feed the ROOT session id.
            The width persists in localStorage and applies to every
            panel, not just Preview. */}
        {sidePanelEffective !== null && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={sidePanelSizer.startResize}
              className={cn(
                'w-1 cursor-col-resize shrink-0 transition-colors',
                sidePanelSizer.resizing
                  ? 'bg-primary/60'
                  : 'bg-border hover:bg-primary/40',
              )}
              title="Drag to resize"
            />
            <div
              style={{ width: sidePanelSizer.width }}
              className="border-l flex-shrink-0 overflow-hidden flex flex-col"
            >
              <SidebarPanels sessionId={sessionId} active={sidePanelEffective} />
            </div>
          </>
        )}
        <SidebarRail
          active={sidePanelEffective}
          onToggle={togglePanel}
          showPreview={builderMode}
        />
      </div>

      {modalSession && (
        <AgentSessionModal
          coderSessionId={modalSession.coderSessionId}
          role={modalSession.role}
          status={modalSession.status}
          onClose={() => setModalSession(null)}
        />
      )}

      {resetDialogOpen && (
        <ResetSessionDialog
          sessionId={sessionId}
          sessionName={sessionName}
          builderMode={builderMode}
          onClose={() => setResetDialogOpen(false)}
          onResetDone={() => {
            stream.reset();
            refetch();
          }}
        />
      )}

      {newRoleDraft && config && (
        <NewRoleDialog
          sessionId={sessionId}
          config={config}
          initialDraft={newRoleDraft}
          skills={skillsList?.skills ?? []}
          providerOptions={providerOptions}
          getModelsForProvider={getModelsForProvider}
          getDefaultModel={getDefaultModel}
          onClose={() => setNewRoleDraft(null)}
          onApplied={() => {
            refetch();
            setNewRoleDraft(null);
          }}
        />
      )}
    </div>
  );
}
