import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  Boxes,
  FolderKanban,
  Plus,
  Search,
  Users,
  Trash2,
  Copy,
  ExternalLink,
  FolderOpen,
  LayoutTemplate,
} from 'lucide-react';
import { Panel, PanelGroup, type ImperativePanelHandle } from 'react-resizable-panels';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { formatDay } from '../../lib/datetime.js';
import { RailButton, RailContainer } from '../../components/chrome/index.js';
import {
  WorkbenchPanelHeader,
  WorkbenchResizeHandle,
  WorkbenchShell,
  WorkbenchSurface,
} from '../../components/workbench/index.js';
import { useContextMenu, type ContextMenuItem } from '../../components/ui/context-menu.js';
import { useApi } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { TemplateBuilderModal } from './TemplateBuilderModal.js';
import { TemplateListPanel } from './TemplateListPanel.js';
import { NewCompanyDialog } from './NewCompanyDialog.js';
import { buildAgentsDefaultUrl } from './routing.js';
import { CompanySessionView } from './CompanySessionView.js';
import type { CompanyCatalogView, CompanySessionWorkbenchSlots } from './company-workbench-slots.js';

interface CompanySession {
  id: string;
  name: string;
  status: string;
  template_id: number | null;
  runtime_kind?: 'company' | 'app_studio';
  app_session_id?: string | null;
  created_at: string;
}

const COMPANY_CATALOG_VIEW_KEY = 'mcp-ide:company.catalogView';

export function AgentsTab() {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const routeParams = useParams<{ rootId?: string }>();
  const { data: sessions, refetch: refetchSessions } = useApi<CompanySession[]>('/company/sessions');
  const { data: templates } = useApi<Array<{ id: number }>>('/company/templates');
  // Selected session is URL-driven: the `:rootId` segment of
  // `/company/sessions/:rootId/...`. At `/agents` it's null.
  const selectedSessionId = routeParams.rootId?.trim() || null;
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [sidebarView, setSidebarView] = useState<CompanyCatalogView>(() => {
    if (typeof window === 'undefined') return 'sessions';
    return window.localStorage.getItem(COMPANY_CATALOG_VIEW_KEY) === 'templates' ? 'templates' : 'sessions';
  });
  const [agentsSidebarOpen, setAgentsSidebarOpen] = useState(selectedSessionId == null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CompanySession | null>(null);
  const catalogPanelRef = useRef<ImperativePanelHandle>(null);
  const [sessionRailHost, setSessionRailHost] = useState<HTMLDivElement | null>(null);

  const selectedSession = sessions?.find((s) => s.id === selectedSessionId);
  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLocaleLowerCase();
    if (!query) return sessions ?? [];
    return (sessions ?? []).filter((session) =>
      `${session.name} ${session.status} ${session.runtime_kind === 'app_studio' ? 'app' : 'company'}`.toLocaleLowerCase().includes(query),
    );
  }, [sessionQuery, sessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(COMPANY_CATALOG_VIEW_KEY, sidebarView);
    } catch {
      // Persistence is a convenience; private browsing can disable it.
    }
  }, [sidebarView]);

  useEffect(() => {
    if (agentsSidebarOpen) catalogPanelRef.current?.expand();
    else catalogPanelRef.current?.collapse();
  }, [agentsSidebarOpen, selectedSessionId]);

  const toggleCatalog = useCallback((view: CompanyCatalogView) => {
    if (sidebarView === view) {
      setAgentsSidebarOpen((open) => !open);
      return;
    }
    setSidebarView(view);
    setAgentsSidebarOpen(true);
  }, [sidebarView]);

  function selectSession(id: string) {
    navigate(buildAgentsDefaultUrl(id));
    if (typeof window !== 'undefined' && window.innerWidth < 768) setAgentsSidebarOpen(false);
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const target = sessions?.find((s) => s.id === id) ?? null;
    if (target) setDeleteTarget(target);
  }

  async function handleDuplicate(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const res = await fetch(`/api/company/sessions/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json() as { session: CompanySession };
    refetchSessions();
    selectSession(data.session.id);
  }

  const catalogPanel = (
    <WorkbenchSurface className="flex h-full flex-col rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
      <WorkbenchPanelHeader
        title={sidebarView === 'sessions' ? t('sessions') : t('templates')}
        icon={sidebarView === 'sessions' ? Users : LayoutTemplate}
        actions={
          <button
            type="button"
            onClick={() => sidebarView === 'sessions' ? setShowNewCompany(true) : setShowNewTemplate(true)}
            aria-label={sidebarView === 'sessions' ? t('newCompany') : t('template.newTemplate')}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        }
        onClose={() => setAgentsSidebarOpen(false)}
        closeLabel={t('catalog.collapse')}
      />

      {sidebarView === 'sessions' ? (
        <>
          <div className="border-b border-[var(--workbench-border)] p-1.5">
            <label className="flex h-7 items-center gap-1.5 rounded border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-muted-foreground focus-within:border-[var(--workbench-focus)]">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <input
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder={t('catalog.filterCompanies')}
                className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
            {filteredSessions.length === 0 && (
              <div className="px-3 py-8 text-center">
                <Users className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
                <p className="text-[11px] font-medium text-foreground">
                  {sessionQuery ? t('catalog.noCompanyFound') : t('noSessions')}
                </p>
                {!sessionQuery && (
                  <button
                    type="button"
                    onClick={() => setShowNewCompany(true)}
                    className="mt-2 text-[11px] text-primary hover:underline"
                  >
                    {t('newCompany')}
                  </button>
                )}
              </div>
            )}
            {filteredSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={selectedSessionId === session.id}
                onSelect={() => selectSession(session.id)}
                onDuplicate={(event) => handleDuplicate(event, session.id)}
                onDelete={(event) => handleDelete(event, session.id)}
              />
            ))}
          </div>
          <div className="flex h-7 items-center border-t border-[var(--workbench-border)] px-2 text-[10px] text-muted-foreground">
            {t('catalog.companyCount', { shown: filteredSessions.length, total: sessions?.length ?? 0 })}
          </div>
        </>
      ) : (
        <TemplateListPanel onNewTemplate={() => setShowNewTemplate(true)} />
      )}
    </WorkbenchSurface>
  );

  const sessionWorkbenchSlots: CompanySessionWorkbenchSlots = {
    leftRailHost: sessionRailHost,
    catalog: {
      open: agentsSidebarOpen,
      activeView: sidebarView,
      sessionCount: sessions?.length,
      templateCount: templates?.length,
      onToggle: toggleCatalog,
      onOpenChange: setAgentsSidebarOpen,
    },
    catalogPanel,
  };

  return (
    <WorkbenchShell>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {selectedSession ? (
          <div ref={setSessionRailHost} className="contents" />
        ) : (
          <RailContainer side="left" aria-label={t('catalog.navigationLabel')}>
            <RailButton
              icon={Users}
              label={t('sessions')}
              role="toggle"
              active={agentsSidebarOpen && sidebarView === 'sessions'}
              onClick={() => toggleCatalog('sessions')}
              badge={sessions?.length}
            />
            <RailButton
              icon={LayoutTemplate}
              label={t('templates')}
              role="toggle"
              active={agentsSidebarOpen && sidebarView === 'templates'}
              onClick={() => toggleCatalog('templates')}
              badge={templates?.length}
            />
            <div className="mt-auto pb-1">
              <RailButton
                icon={Plus}
                label={t('newCompany')}
                role="toggle"
                active={showNewCompany}
                onClick={() => setShowNewCompany(true)}
              />
            </div>
          </RailContainer>
        )}

        {selectedSession ? (
          <div className="min-w-0 flex-1">
            <CompanySessionView
              key={selectedSession.id}
              sessionId={selectedSession.id}
              sessionName={selectedSession.name}
              sessionStatus={selectedSession.status}
              runtimeKind={selectedSession.runtime_kind ?? 'company'}
              appSessionId={selectedSession.app_session_id ?? null}
              workbenchSlots={sessionWorkbenchSlots}
            />
          </div>
        ) : (
          <div className="min-w-0 flex-1 p-1.5">
            <PanelGroup direction="horizontal" autoSaveId="mcp-company-catalog-layout" className="min-h-0 min-w-0">
              <Panel
                ref={catalogPanelRef}
                order={1}
                defaultSize={22}
                minSize={16}
                maxSize={34}
                collapsible
                collapsedSize={0}
                onCollapse={() => setAgentsSidebarOpen(false)}
                onExpand={() => setAgentsSidebarOpen(true)}
              >
                <div className="h-full min-h-0">{catalogPanel}</div>
              </Panel>

              <WorkbenchResizeHandle
                direction="horizontal"
                disabled={!agentsSidebarOpen}
                className={!agentsSidebarOpen ? 'w-0 cursor-default' : undefined}
              />

              <Panel order={2} minSize={42}>
                <WorkbenchSurface className="h-full rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)]">
                  <CompanyHome
                    sessions={sessions ?? []}
                    templateCount={templates?.length ?? 0}
                    onCreateCompany={() => setShowNewCompany(true)}
                    onCreateTemplate={() => {
                      setSidebarView('templates');
                      setAgentsSidebarOpen(true);
                      setShowNewTemplate(true);
                    }}
                    onOpenSession={selectSession}
                  />
                </WorkbenchSurface>
              </Panel>
            </PanelGroup>
          </div>
        )}
      </div>

      {/* Modals */}
      {showNewTemplate && (
        <TemplateBuilderModal
          onClose={() => setShowNewTemplate(false)}
          onSaved={() => {}}
        />
      )}
      {showNewCompany && (
        <NewCompanyDialog
          onClose={() => setShowNewCompany(false)}
          onCreated={(id) => {
            refetchSessions();
            selectSession(id);
          }}
        />
      )}
      {deleteTarget && (
        <DeleteCompanyDialog
          session={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            if (selectedSessionId === deleteTarget.id) navigate('/agents');
            setDeleteTarget(null);
            refetchSessions();
          }}
        />
      )}
    </WorkbenchShell>
  );
}

function CompanyHome({
  sessions,
  templateCount,
  onCreateCompany,
  onCreateTemplate,
  onOpenSession,
}: {
  sessions: CompanySession[];
  templateCount: number;
  onCreateCompany: () => void;
  onCreateTemplate: () => void;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useTranslation('agents');
  const running = sessions.filter((session) => session.status === 'running').length;
  const recent = sessions.slice(0, 5);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkbenchPanelHeader
        title={t('catalog.title')}
        icon={Users}
        actions={
          <Button size="sm" className="h-6 gap-1 px-2 text-[10px]" onClick={onCreateCompany}>
            <Plus className="h-3 w-3" /> {t('newCompany')}
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <section className="grid gap-3 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,.75fr)]">
            <div className="relative overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface)] p-5">
              <div className="absolute right-0 top-0 h-40 w-40 rounded-full bg-violet-500/8 blur-3xl" />
              <div className="relative max-w-2xl">
                <div className="mb-3 grid h-9 w-9 place-items-center rounded-md bg-violet-500/12 text-violet-400">
                  <Boxes className="h-5 w-5" />
                </div>
                <h1 className="text-lg font-semibold text-foreground">{t('catalog.heroTitle')}</h1>
                <p className="mt-1.5 max-w-xl text-xs leading-5 text-muted-foreground">
                  {t('catalog.heroDescription')}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" className="h-8 gap-1.5" onClick={onCreateCompany}>
                    <Plus className="h-3.5 w-3.5" /> {t('catalog.createCompany')}
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onCreateTemplate}>
                    <LayoutTemplate className="h-3.5 w-3.5" /> {t('catalog.createTemplate')}
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
              <Metric label={t('catalog.companies')} value={sessions.length} icon={Users} />
              <Metric label={t('catalog.running')} value={running} icon={Activity} tone="success" />
              <Metric label={t('templates')} value={templateCount} icon={LayoutTemplate} />
            </div>
          </section>

          <section className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,.8fr)]">
            <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
              <div className="flex h-9 items-center gap-2 border-b border-[var(--workbench-border)] px-3">
                <FolderKanban className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-xs font-semibold">{t('catalog.recentCompanies')}</h2>
                <span className="ml-auto text-[10px] text-muted-foreground">{t('catalog.totalCount', { count: sessions.length })}</span>
              </div>
              <div className="p-1.5">
                {recent.length === 0 ? (
                  <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                    {t('catalog.emptyRecent')}
                  </div>
                ) : recent.map((session) => (
                  <button
                    type="button"
                    key={session.id}
                    onClick={() => onOpenSession(session.id)}
                    className="group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[var(--workbench-hover)]"
                  >
                    <span className="grid h-7 w-7 place-items-center rounded bg-[var(--workbench-raised)] text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 truncate text-[11px] font-medium text-foreground">
                        <span className="truncate">{session.name}</span>
                        {session.runtime_kind === 'app_studio' && (
                          <Badge variant="outline" className="h-4 px-1 text-[8px] text-violet-400">{t('company.appBadge')}</Badge>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <StatusBadge status={session.status} />
                        {formatDay(session.created_at)}
                      </span>
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface)]">
              <div className="flex h-9 items-center gap-2 border-b border-[var(--workbench-border)] px-3">
                <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-xs font-semibold">{t('catalog.recommendedFlow')}</h2>
              </div>
              <div className="space-y-0 p-3">
                <FlowStep number="1" title={t('catalog.flow.blueprintTitle')} description={t('catalog.flow.blueprintDescription')} />
                <FlowStep number="2" title={t('catalog.flow.projectsTitle')} description={t('catalog.flow.projectsDescription')} />
                <FlowStep number="3" title={t('catalog.flow.masterTitle')} description={t('catalog.flow.masterDescription')} last />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone = 'default',
}: {
  label: string;
  value: number;
  icon: typeof Users;
  tone?: 'default' | 'success';
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface)] px-3 py-2.5">
      <span className={cn(
        'grid h-7 w-7 place-items-center rounded bg-[var(--workbench-raised)] text-muted-foreground',
        tone === 'success' && 'bg-emerald-500/10 text-emerald-400',
      )}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span>
        <span className="block text-base font-semibold tabular-nums">{value}</span>
        <span className="block text-[10px] text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function FlowStep({ number, title, description, last = false }: { number: string; title: string; description: string; last?: boolean }) {
  return (
    <div className="relative flex gap-2.5 pb-4 last:pb-0">
      {!last && <span className="absolute left-3 top-6 h-full w-px bg-[var(--workbench-border)]" />}
      <span className="relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--workbench-border)] bg-[var(--workbench-raised)] text-[10px] font-semibold text-violet-400">
        {number}
      </span>
      <span className="pt-0.5">
        <span className="block text-[11px] font-medium text-foreground">{title}</span>
        <span className="block text-[10px] leading-4 text-muted-foreground">{description}</span>
      </span>
    </div>
  );
}

/**
 * One row of the company sessions list. Owns its own context menu
 * (right-click → "Open", "Open in new window", "Duplicate", "Delete")
 * so the menu items can reference `session` directly without prop
 * drilling. Lives at module scope so each row gets its OWN
 * `useContextMenu` hook — calling the hook inside the parent's `.map`
 * would violate Rules of Hooks because the iteration count is dynamic.
 */
interface SessionRowProps {
  session: CompanySession;
  selected: boolean;
  onSelect: () => void;
  onDuplicate: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}

function SessionRow({ session: s, selected, onSelect, onDuplicate, onDelete }: SessionRowProps) {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const isAppTeam = s.runtime_kind === 'app_studio';

  const items: ContextMenuItem[] = [
    {
      id: 'open',
      label: t('contextMenu.open', 'Open'),
      icon: FolderOpen,
      onSelect,
    },
  ];

  const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (electronAPI?.openInNewWindow) {
    items.push({
      id: 'open-new-window',
      label: t('contextMenu.openInNewWindow', 'Open in new window'),
      icon: ExternalLink,
      onSelect: () => {
        void electronAPI.openInNewWindow!(buildAgentsDefaultUrl(s.id), s.name);
      },
    });
  }

  if (isAppTeam && s.app_session_id != null) {
    items.push({
      id: 'open-app',
      label: t('company.openAppWorkflow'),
      icon: ExternalLink,
      separatorBefore: true,
      onSelect: () => navigate(`/apps/${s.app_session_id}`),
    });
  } else {
    items.push({
      id: 'duplicate',
      label: t('duplicateSession', 'Duplicate'),
      icon: Copy,
      separatorBefore: true,
      onSelect: () => {
        onDuplicate({ stopPropagation: () => undefined } as unknown as React.MouseEvent);
      },
    });
    items.push({
      id: 'delete',
      label: t('deleteSession', 'Delete'),
      icon: Trash2,
      destructive: true,
      onSelect: () => {
        onDelete({ stopPropagation: () => undefined } as unknown as React.MouseEvent);
      },
    });
  }

  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect();
      }}
      {...triggerProps}
      className={cn(
        'group w-full cursor-pointer rounded-md border border-transparent px-2 py-2 text-left text-xs transition-colors hover:border-[var(--workbench-border)] hover:bg-[var(--workbench-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus)]',
        selected && 'border-violet-500/30 bg-[var(--workbench-active)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn(
          'grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--workbench-raised)] text-muted-foreground',
          selected && 'text-violet-400',
        )}>
          <Users className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{s.name}</span>
        {isAppTeam && <Badge variant="outline" className="h-4 px-1 text-[8px] text-violet-400">{t('company.appBadge')}</Badge>}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isAppTeam && s.app_session_id != null ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => { event.stopPropagation(); navigate(`/apps/${s.app_session_id}`); }}
              className="cursor-pointer text-muted-foreground hover:text-primary"
              title={t('company.openAppWorkflow')}
            >
              <ExternalLink className="h-3 w-3" />
            </span>
          ) : (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={onDuplicate}
                className="text-muted-foreground hover:text-primary cursor-pointer"
                title={t('duplicateSession')}
              >
                <Copy className="h-3 w-3" />
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={onDelete}
                className="text-muted-foreground hover:text-destructive cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
              </span>
            </>
          )}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-1.5 pl-8">
        <StatusBadge status={s.status} />
        <span className="text-[10px] text-muted-foreground">
          {formatDay(s.created_at)}
        </span>
      </div>
      {Menu}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('agents');
  const colors: Record<string, string> = {
    idle: 'bg-muted text-muted-foreground',
    running: 'bg-warning/20 text-warning',
    completed: 'bg-success/20 text-success',
    error: 'bg-destructive/20 text-destructive',
    paused: 'bg-yellow-500/20 text-yellow-400',
  };
  const STATUS_KEYS: Record<string, string> = {
    idle: 'status.idle',
    running: 'status.running',
    completed: 'status.completed',
    error: 'status.error',
    paused: 'status.paused',
  };
  return (
    <Badge variant="outline" className={cn('text-[9px] px-1', colors[status])}>
      {t(STATUS_KEYS[status] ?? status)}
    </Badge>
  );
}

interface DeletePlan {
  project_paths: Array<{
    project_id: number;
    name: string;
    label: string | null;
    root_path: string;
    kind: 'owned' | 'external';
    removable: boolean;
  }>;
  node_modules_volumes: Array<{
    name: string;
    label: string;
    removable: boolean;
  }>;
}

function DeleteCompanyDialog({
  session,
  onClose,
  onDeleted,
}: {
  session: CompanySession;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [selectedVolumes, setSelectedVolumes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/company/sessions/${session.id}/delete-plan`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: DeletePlan) => {
        if (!cancelled) {
          setPlan(body);
          setSelectedPaths(new Set());
          setSelectedVolumes(new Set());
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  function togglePath(path: string) {
    setSelectedPaths((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleVolume(name: string) {
    setSelectedVolumes((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function submit() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/company/sessions/${session.id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          remove_project_paths: [...selectedPaths],
          remove_node_modules_volumes: [...selectedVolumes],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  const removablePaths = plan?.project_paths.filter((p) => p.removable) ?? [];
  const preservedPaths = plan?.project_paths.filter((p) => !p.removable) ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete company</DialogTitle>
          <DialogDescription>
            Containers are removed. Project folders are preserved unless selected below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          <div className="rounded border border-destructive/30 bg-destructive/5 p-2">
            <div className="font-medium text-destructive">{session.name}</div>
            <div className="text-muted-foreground mt-0.5">
              This removes the company session and its Podman/Docker containers.
            </div>
          </div>

          {loading && <div className="text-muted-foreground">Loading folders...</div>}

          {removablePaths.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Optional folders to remove
              </div>
              {removablePaths.map((item) => (
                <label key={item.root_path} className="flex items-start gap-2 rounded border p-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selectedPaths.has(item.root_path)}
                    onChange={() => togglePath(item.root_path)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium truncate">{item.label ?? item.name}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground break-all">
                      {item.root_path}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {(plan?.node_modules_volumes.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Optional dependency volumes
              </div>
              {plan!.node_modules_volumes.map((item) => (
                <label key={item.name} className="flex items-center gap-2 rounded border p-2">
                  <input
                    type="checkbox"
                    checked={selectedVolumes.has(item.name)}
                    onChange={() => toggleVolume(item.name)}
                  />
                  <span>
                    <span className="block font-medium">{item.label}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground">
                      {item.name}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          {preservedPaths.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Preserved external projects
              </div>
              {preservedPaths.map((item) => (
                <div key={item.root_path} className="rounded border bg-muted/30 p-2">
                  <div className="font-medium truncate">{item.label ?? item.name}</div>
                  <div className="font-mono text-[10px] text-muted-foreground break-all">
                    {item.root_path}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <div className="text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
