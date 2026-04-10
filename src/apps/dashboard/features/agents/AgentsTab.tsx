import React, { useState } from 'react';
import { Plus, Users, FileText, Trash2, Edit2, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Badge } from '../../components/ui/badge.js';
import { useApi, apiDelete } from '../../hooks/useApi.js';
import { cn } from '../../lib/utils.js';
import { TemplateBuilderModal } from './TemplateBuilderModal.js';
import { TemplateListPanel } from './TemplateListPanel.js';
import { NewCompanyDialog } from './NewCompanyDialog.js';
import { CompanySessionView } from './CompanySessionView.js';

interface CompanySession {
  id: number;
  name: string;
  status: string;
  template_id: number | null;
  created_at: string;
}

type SidebarView = 'sessions' | 'templates';

export function AgentsTab() {
  const { data: sessions, refetch: refetchSessions } = useApi<CompanySession[]>('/company/sessions');
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [showNewCompany, setShowNewCompany] = useState(false);
  const [sidebarView, setSidebarView] = useState<SidebarView>('sessions');

  const selectedSession = sessions?.find((s) => s.id === selectedSessionId);

  async function handleDelete(e: React.MouseEvent, id: number) {
    e.stopPropagation();
    await apiDelete(`/company/sessions/${id}`);
    if (selectedSessionId === id) setSelectedSessionId(null);
    refetchSessions();
  }

  return (
    <div className="flex h-[calc(100vh-7rem)]">
      {/* Sidebar */}
      <div className="w-64 border-r flex flex-col bg-card">
        {/* Top actions */}
        <div className="p-3 border-b space-y-2">
          <Button
            variant="default"
            size="sm"
            className="w-full justify-start"
            onClick={() => setShowNewCompany(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-2" />
            New Company
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
            Sessions
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
            Templates
          </button>
        </div>

        {/* Sidebar content */}
        <div className="flex-1 overflow-y-auto">
          {sidebarView === 'sessions' && (
            <>
              {(!sessions || sessions.length === 0) && (
                <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                  No company sessions yet.
                </p>
              )}
              {sessions?.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedSessionId(s.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setSelectedSessionId(s.id)}
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

      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        {selectedSession ? (
          <CompanySessionView
            sessionId={selectedSession.id}
            sessionName={selectedSession.name}
            sessionStatus={selectedSession.status}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Users className="h-16 w-16 opacity-20 mb-4" />
            <h3 className="text-sm font-medium mb-1">Company Agents Mode</h3>
            <p className="text-xs max-w-md text-center">
              Create a team of AI agents with distinct roles to collaborate on your projects.
              Each agent can use a different AI model. The Master orchestrates, subordinates execute.
            </p>
            <Button
              variant="default"
              size="sm"
              className="mt-4"
              onClick={() => setShowNewCompany(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-2" />
              Create Your First Company
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
  const colors: Record<string, string> = {
    idle: 'bg-muted text-muted-foreground',
    running: 'bg-warning/20 text-warning',
    completed: 'bg-success/20 text-success',
    error: 'bg-destructive/20 text-destructive',
    paused: 'bg-yellow-500/20 text-yellow-400',
  };
  return (
    <Badge variant="outline" className={cn('text-[9px] px-1', colors[status])}>
      {status}
    </Badge>
  );
}
