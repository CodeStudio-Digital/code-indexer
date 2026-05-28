import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Plus,
  Users,
  FileText,
  Trash2,
  Edit2,
  ChevronRight,
  ChevronLeft,
  PanelLeft,
  PanelLeftClose,
  Copy,
  ExternalLink,
  FolderOpen,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
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
// BuilderView is a smart wrapper: when the session was created with a
// `builder.stack`, it renders the split chat+preview layout; otherwise
// it delegates transparently to CompanySessionView. Routing through it
// means AgentsTab doesn't need to branch on session mode.
import { BuilderView } from '../builder/BuilderView.js';

interface CompanySession {
  id: number;
  name: string;
  status: string;
  template_id: number | null;
  created_at: string;
}

type SidebarView = 'sessions' | 'templates';

export function AgentsTab() {
  const { t } = useTranslation('agents');
  const navigate = useNavigate();
  const routeParams = useParams<{ rootId?: string }>();
  const { data: sessions, refetch: refetchSessions } = useApi<CompanySession[]>('/company/sessions');
  // Selected session is URL-driven: the `:rootId` segment of
  // `/company/sessions/:rootId/...`. At `/agents` it's null.
  const selectedSessionId = routeParams.rootId != null ? Number(routeParams.rootId) : null;
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('sessions');
  const [agentsSidebarOpen, setAgentsSidebarOpen] = useState(selectedSessionId == null);
  const [deleteTarget, setDeleteTarget] = useState<CompanySession | null>(null);

  const selectedSession = sessions?.find((s) => s.id === selectedSessionId);

  function selectSession(id: number) {
    navigate(buildAgentsDefaultUrl(id));
    setAgentsSidebarOpen(false);
  }

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    const target = sessions?.find((s) => s.id === id) ?? null;
    if (target) setDeleteTarget(target);
  }

  async function handleDuplicate(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    const res = await fetch(`/api/company/sessions/${id}/duplicate`, { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json() as { session: CompanySession };
    refetchSessions();
    selectSession(data.session.id);
  }

  return (
    // h-full (not 100dvh) because AppShell's <main> already gives us
    // viewport height minus the 36px topbar. Using 100dvh here pushed
    // the inner SessionHeader off-screen behind the global header.
    <div className="flex h-full">
      {/* Sidebar — full-width on mobile when open, hidden otherwise */}
      <div className={cn(
        'border-r flex flex-col bg-card flex-shrink-0',
        agentsSidebarOpen ? 'flex w-full md:w-64' : 'hidden',
      )}>
        {/* Top actions */}
        <div className="p-3 border-b space-y-2">
          <Button
            variant="default"
            size="sm"
            className="w-full justify-start"
            onClick={() => setShowNewCompany(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-2" />
            {t('newCompany')}
          </Button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b text-xs">
          <button
            onClick={() => setSidebarView('sessions')}
            className={cn(
              'flex-1 py-2 text-center transition-colors',
              sidebarView === 'sessions'
                ? 'border-b-2 border-primary text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('sessions')}
          </button>
          <button
            onClick={() => setSidebarView('templates')}
            className={cn(
              'flex-1 py-2 text-center transition-colors',
              sidebarView === 'templates'
                ? 'border-b-2 border-primary text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('templates')}
          </button>
        </div>

        {/* Sidebar content */}
        <div className="flex-1 overflow-y-auto">
          {sidebarView === 'sessions' && (
            <>
              {(!sessions || sessions.length === 0) && (
                <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                  {t('noSessions')}
                </p>
              )}
              {sessions?.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={selectedSessionId === s.id}
                  onSelect={() => selectSession(s.id)}
                  onDuplicate={(e) => handleDuplicate(e, s.id)}
                  onDelete={(e) => handleDelete(e, s.id)}
                />
              ))}
            </>
          )}

          {sidebarView === 'templates' && (
            <TemplateListPanel onNewTemplate={() => setShowNewTemplate(true)} />
          )}
        </div>
      </div>

      {/* Main content — hidden on mobile when sidebar is open */}
      <div className={cn(
        'overflow-hidden flex flex-col',
        agentsSidebarOpen ? 'hidden md:flex md:flex-1' : 'flex flex-1',
      )}>
        {/* Empty-state top bar: only when no session is selected. When
            a session IS selected, the sessions-list toggle is rendered
            inside `SessionHeader` instead — that lets us collapse two
            stacked top bars into one. */}
        {!selectedSession && (
          <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
            <button
              onClick={() => setAgentsSidebarOpen((v) => !v)}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={agentsSidebarOpen ? 'Fechar painel' : 'Abrir painel'}
            >
              {agentsSidebarOpen
                ? <PanelLeftClose className="h-4 w-4" />
                : <PanelLeft className="h-4 w-4" />
              }
            </button>
            <span className="text-xs text-muted-foreground">{t('sessions')}</span>
          </div>
        )}

        {/* Mobile back button */}
        {selectedSession && (
            <button
                className="md:hidden flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground border-b hover:bg-muted transition-colors shrink-0"
                onClick={() => setAgentsSidebarOpen(true)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {t('sessions')}
            </button>
        )}

        {selectedSession ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <BuilderView
              key={selectedSession.id}
              sessionId={selectedSession.id}
              sessionName={selectedSession.name}
              sessionStatus={selectedSession.status}
              sessionsListOpen={agentsSidebarOpen}
              onToggleSessionsList={() => setAgentsSidebarOpen((v) => !v)}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Users className="h-16 w-16 opacity-20 mb-4" />
            <h3 className="text-sm font-medium mb-1">{t('companyMode.title')}</h3>
            <p className="text-xs max-w-md text-center">
              {t('companyMode.description')}
            </p>
            <Button
              variant="default"
              size="sm"
              className="mt-4"
              onClick={() => setShowNewCompany(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-2" />
              {t('companyMode.createFirst')}
            </Button>
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

  items.push({
    id: 'duplicate',
    label: t('duplicateSession', 'Duplicate'),
    icon: Copy,
    separatorBefore: true,
    onSelect: () => {
      // Synthesize a MouseEvent-shaped object — onDuplicate only reads
      // stopPropagation, so a noop stub is enough.
      onDuplicate({
        stopPropagation: () => undefined,
      } as unknown as React.MouseEvent);
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
        'w-full text-left px-3 py-2.5 border-b text-xs hover:bg-muted/50 transition-colors group cursor-pointer',
        selected && 'bg-muted',
      )}
    >
      <div className="flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium truncate flex-1">{s.name}</span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <span
            role="button"
            tabIndex={0}
            onClick={onDuplicate}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onDuplicate(e as unknown as React.MouseEvent);
              }
            }}
            className="text-muted-foreground hover:text-primary cursor-pointer"
            title={t('duplicateSession')}
          >
            <Copy className="h-3 w-3" />
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={onDelete}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                onDelete(e as unknown as React.MouseEvent);
              }
            }}
            className="text-muted-foreground hover:text-destructive cursor-pointer"
          >
            <Trash2 className="h-3 w-3" />
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-1">
        <StatusBadge status={s.status} />
        <span className="text-[10px] text-muted-foreground">
          {new Date(s.created_at).toLocaleDateString()}
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
