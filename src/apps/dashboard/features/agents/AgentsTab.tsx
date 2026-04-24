import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Users, FileText, Trash2, Edit2, ChevronRight, ChevronLeft, PanelLeft, PanelLeftClose } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { useApi, apiDelete } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import { TemplateBuilderModal } from './TemplateBuilderModal.js';
import { TemplateListPanel } from './TemplateListPanel.js';
import { NewCompanyDialog } from './NewCompanyDialog.js';
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
  const { data: sessions, refetch: refetchSessions } = useApi<CompanySession[]>('/company/sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('sessions');
  const [agentsSidebarOpen, setAgentsSidebarOpen] = useState(true);

  const selectedSession = sessions?.find((s) => s.id === selectedSessionId);

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    await apiDelete(`/company/sessions/${id}`);
    if (selectedSessionId === id) setSelectedSessionId(null);
    refetchSessions();
  }

  return (
    <div className="flex h-[calc(100vh-6rem)]">
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
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelectedSessionId(s.id); setAgentsSidebarOpen(false); }}
                  onKeyDown={(e) => e.key === 'Enter' && (setSelectedSessionId(s.id), setAgentsSidebarOpen(false))}
                  className={cn(
                    'w-full text-left px-3 py-2.5 border-b text-xs hover:bg-muted/50 transition-colors group cursor-pointer',
                    selectedSessionId === s.id && 'bg-muted',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="font-medium truncate flex-1">{s.name}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => handleDelete(e as unknown as React.MouseEvent, s.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); handleDelete(e as unknown as React.MouseEvent, s.id); } }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive cursor-pointer"
                    >
                      <Trash2 className="h-3 w-3" />
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <StatusBadge status={s.status} />
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>
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
        {/* Top bar with toggle button */}
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
          {selectedSession && (
            <span className="text-xs text-muted-foreground truncate">{selectedSession.name}</span>
          )}
          {!selectedSession && (
            <span className="text-xs text-muted-foreground">{t('sessions')}</span>
          )}
        </div>

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
              sessionId={selectedSession.id}
              sessionName={selectedSession.name}
              sessionStatus={selectedSession.status}
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
            setSelectedSessionId(id);
          }}
        />
      )}
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
