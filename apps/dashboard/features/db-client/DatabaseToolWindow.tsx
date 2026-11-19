import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Bot, Clock3, Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button.js';
import { Combobox } from '../../components/ui/combobox.js';
import { WorkbenchPanelHeader } from '../../components/workbench/WorkbenchChrome.js';
import { useWorkspaceLayout } from '../../state/workspace-layout.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { ConnectionDialog } from './dialogs/ConnectionDialog.js';
import { CsvImportDialog } from './dialogs/CsvImportDialog.js';
import { DatabaseToolTabs, type DatabaseTool } from './DatabaseRail.js';
import { QueryAuxPanel } from './query/QueryAuxPanel.js';
import { ConnectionTree } from './tree/ConnectionTree.js';
import { useDbClient, type UseDbClient } from './useDbClient.js';
import { WorkAreaTabBar } from './workarea/WorkAreaTabBar.js';
import type { DbConnection, WorkTab } from './types.js';

const DatabaseEditorStack = lazy(() =>
  import('./DatabaseEditorView.js').then((module) => ({ default: module.DatabaseEditorStack })),
);

function buildDatabaseSpecialistPrompt(projectName: string, conn: DbConnection): string {
  const target = [
    `Conexao alvo: ${conn.label}`,
    `Motor: ${conn.engine}`,
    conn.database_name ? `Banco/schema padrao: ${conn.database_name}` : null,
    conn.host ? `Host: ${conn.host}${conn.port ? `:${conn.port}` : ''}` : null,
    conn.file_path ? `Arquivo: ${conn.file_path}` : null,
    conn.is_read_only ? 'Conexao marcada como somente leitura.' : 'Trate qualquer escrita como bloqueada ate autorizacao explicita.',
  ].filter(Boolean).join('\n');

  return [
    'Atue como especialista em banco de dados deste projeto.',
    'Fale em portugues simples e objetivo e explique tabelas, campos, relacionamentos, consultas e riscos.',
    'Comece com db_list, confirme a conexao alvo e use db_schema de forma paginada e seletiva.',
    'Use db_query somente para leituras seguras; para MongoDB ou Redis, use db_command.',
    'Antes de qualquer escrita, explique o comando e o impacto e aguarde minha aprovacao explicita.',
    `Projeto: ${projectName}`,
    target,
  ].join('\n');
}

export function DatabaseToolWindow({
  projectId,
  workspaceId = projectId,
  projectName,
  host,
  editorHost,
  embeddedEditor = false,
}: {
  projectId: number;
  workspaceId?: number | null;
  projectName: string;
  host: HTMLDivElement | null;
  /** Optional center-surface host used by workbenches outside ProjectView. */
  editorHost?: HTMLDivElement | null;
  /** Keep database tabs inside `editorHost` instead of the global IDE editor. */
  embeddedEditor?: boolean;
}) {
  const { t } = useTranslation('dbClient');
  const dbRef = useRef<UseDbClient | null>(null);
  const openDatabaseTab = useWorkspaceStore((state) => state.openDatabaseTab);
  const onOpenWorkTab = useCallback((workTab: WorkTab) => {
    if (embeddedEditor || workspaceId == null) return;
    const db = dbRef.current;
    const connection = db?.connections.find((item) => item.id === workTab.connectionId);
    openDatabaseTab({
      kind: 'database',
      projectId: workspaceId,
      connectionProjectId: workspaceId === projectId ? undefined : projectId,
      path: `database:${workTab.id}`,
      title: workTab.title || t('tabs.query') + (workTab.seq ? ` ${workTab.seq}` : ''),
      workTab,
      engine: connection?.engine,
      suggestions: db?.treeSuggestions(workTab.connectionId) ?? [],
    });
  }, [embeddedEditor, openDatabaseTab, projectId, workspaceId, t]);
  const db = useDbClient(projectId, { onOpenWorkTab });
  dbRef.current = db;

  const [tool, setTool] = useState<DatabaseTool>('connections');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);
  const [auxTick, setAuxTick] = useState(0);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');

  const activeConnection = db.connections.find((connection) => connection.id === db.activeConnectionId) ?? null;
  const specialistConnection = db.connections.find((connection) => String(connection.id) === selectedConnectionId)
    ?? activeConnection
    ?? db.connections[0]
    ?? null;
  const connectionOptions = useMemo(() => db.connections.map((connection) => ({
    value: String(connection.id),
    label: connection.label,
    hint: connection.engine,
    description: connection.database_name ?? connection.host ?? connection.file_path ?? undefined,
  })), [db.connections]);

  useEffect(() => {
    if (specialistConnection && selectedConnectionId !== String(specialistConnection.id)) {
      setSelectedConnectionId(String(specialistConnection.id));
    } else if (!specialistConnection && selectedConnectionId) {
      setSelectedConnectionId('');
    }
  }, [selectedConnectionId, specialistConnection]);

  useEffect(() => {
    const onDatabaseChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: number; schema?: string }>).detail;
      if (detail?.connectionId != null) db.invalidateTables(detail.connectionId, detail.schema);
    };
    const onQuerySaved = () => setAuxTick((value) => value + 1);
    window.addEventListener('mcp:database-changed', onDatabaseChanged);
    window.addEventListener('mcp:database-query-saved', onQuerySaved);
    return () => {
      window.removeEventListener('mcp:database-changed', onDatabaseChanged);
      window.removeEventListener('mcp:database-query-saved', onQuerySaved);
    };
  }, [db.invalidateTables]);

  const openFromAux = (sql: string) => {
    if (db.activeConnectionId != null) db.openQueryTab(db.activeConnectionId, undefined, sql);
  };
  const openSpecialist = () => {
    if (!specialistConnection) return;
    useWorkspaceLayout.getState().setActiveRight('chat');
    const prompt = buildDatabaseSpecialistPrompt(projectName, specialistConnection);
    // The right dock may be mounting for the first time. Deliver on the next
    // browser task so EditorChatRail has installed its request listener.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('mcp:editor-chat-prompt', {
        detail: {
          prompt,
          newSession: true,
          title: t('specialist.sessionTitle', { name: specialistConnection.label }),
          agent: 'app_db',
        },
      }));
    }, 0);
  };

  const content = (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
      <DatabaseToolTabs
        active={tool}
        connectionCount={db.connections.length}
        historyDisabled={db.activeConnectionId == null}
        onToggle={setTool}
      />
      <div className="min-h-0 min-w-0 flex-1">
        {tool === 'connections' ? (
          <ConnectionTree
            db={db}
            onAdd={() => { setEditing(null); setDialogOpen(true); }}
            onEdit={(connection) => { setEditing(connection); setDialogOpen(true); }}
          />
        ) : tool === 'specialist' ? (
          <div className="flex h-full flex-col">
            <WorkbenchPanelHeader title={t('rail.specialist')} icon={Bot} />
            <div className="space-y-3 p-3">
              <Combobox
                value={specialistConnection ? String(specialistConnection.id) : ''}
                onChange={setSelectedConnectionId}
                options={connectionOptions}
                placeholder={t('specialist.selectConnection')}
                searchPlaceholder={t('specialist.searchConnection')}
                emptyLabel={t('specialist.noConnections')}
                className="h-7"
              />
              <Button size="sm" className="h-7 w-full gap-1.5 text-xs" disabled={!specialistConnection} onClick={openSpecialist}>
                <Bot className="h-3.5 w-3.5" />
                {t('specialist.open')}
              </Button>
              {specialistConnection && (
                <div className="rounded border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] p-2 text-[11px] text-muted-foreground">
                  <div className="font-medium text-foreground">{specialistConnection.label}</div>
                  <div>{specialistConnection.engine}</div>
                  <div className="truncate">{specialistConnection.database_name ?? specialistConnection.host ?? specialistConnection.file_path}</div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <WorkbenchPanelHeader title={tool === 'history' ? t('aux.history') : t('aux.saved')} icon={tool === 'history' ? Clock3 : Bookmark} />
            <div className="min-h-0 flex-1">
              <QueryAuxPanel
                projectId={projectId}
                connectionId={db.activeConnectionId}
                refreshKey={auxTick}
                onOpenQuery={openFromAux}
                view={tool}
              />
            </div>
          </div>
        )}
      </div>
      {db.error && (
        <div className="absolute inset-x-0 bottom-0 z-10 border-t border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-400" title={db.error}>
          {db.error}
        </div>
      )}
    </div>
  );

  const embeddedTabs = useMemo(() => embeddedEditor ? db.workTabs.map((workTab) => {
    const connection = db.connections.find((item) => item.id === workTab.connectionId);
    return {
      kind: 'database' as const,
      projectId,
      path: `database:${projectId}:${workTab.id}`,
      title: workTab.title || t('tabs.query') + (workTab.seq ? ` ${workTab.seq}` : ''),
      workTab,
      engine: connection?.engine,
      suggestions: db.treeSuggestions(workTab.connectionId),
    };
  }) : [], [db.connections, db.treeSuggestions, db.workTabs, embeddedEditor, projectId, t]);
  const embeddedActivePath = db.activeTabId ? `database:${projectId}:${db.activeTabId}` : null;
  const editorContent = (
    <div className="flex h-full min-h-0 flex-col bg-[var(--workbench-surface)]">
      <WorkAreaTabBar db={db} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {embeddedTabs.length > 0 ? (
          <Suspense fallback={<div className="h-full bg-[var(--workbench-surface)]" />}>
            <DatabaseEditorStack tabs={embeddedTabs} activePath={embeddedActivePath} />
          </Suspense>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-2 text-muted-foreground">
              <Database className="h-7 w-7 opacity-60" />
              <p className="text-sm font-medium text-foreground">{t('title')}</p>
              <p className="text-xs leading-relaxed">{t('tabs.empty')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {host && createPortal(content, host)}
      {embeddedEditor && editorHost && createPortal(editorContent, editorHost)}
      {dialogOpen && (
        <ConnectionDialog
          open
          projectId={projectId}
          existing={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={() => void db.refresh(editing?.id)}
        />
      )}
      {db.importRequest && (
        <CsvImportDialog
          open
          connKey={db.importRequest.connKey}
          schema={db.importRequest.schema}
          table={db.importRequest.table}
          onClose={db.clearImportRequest}
          onDone={() => db.invalidateTables(db.importRequest!.connectionId, db.importRequest!.schema)}
        />
      )}
    </>
  );
}
