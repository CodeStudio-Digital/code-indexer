/**
 * Database client tab — a per-project DataGrip × phpMyAdmin surface.
 *
 * P0 layout: left = connection tree (lazy schema browse), center = a minimal
 * query console for the active connection. The full work-area tabs (query
 * consoles + data grid + structure editor) arrive in P1–P3. Mirrors the
 * api-client shell (resizable panes, self-contained hook, project-keyed mount).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, PanelRight } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../../components/ui/button.js';
import { Combobox } from '../../components/ui/combobox.js';
import { cn } from '../../lib/utils.js';
import { AppStudioChatRail } from '../app-studio/AppStudioChatRail.js';
import {
  AppStudioSpecAgentLauncher,
  type AppStudioSpecAgentConfig,
} from '../app-studio/AppStudioSpecAgentLauncher.js';
import { useDbClient } from './useDbClient.js';
import { ConnectionTree } from './tree/ConnectionTree.js';
import { QueryConsole } from './query/QueryConsole.js';
import { QueryAuxPanel } from './query/QueryAuxPanel.js';
import { DataGridTab } from './data/DataGridTab.js';
import { DocumentsTab } from './data/DocumentsTab.js';
import { KeyValueTab } from './data/KeyValueTab.js';
import { TableStructureEditor } from './structure/TableStructureEditor.js';
import { ErDiagramTab } from './structure/ErDiagramTab.js';
import { WorkAreaTabBar } from './workarea/WorkAreaTabBar.js';
import { ConnectionDialog } from './dialogs/ConnectionDialog.js';
import { CsvImportDialog } from './dialogs/CsvImportDialog.js';
import type { DbConnection, DbEngine, WorkTab } from './types.js';

function buildProjectDbSpecialistPrompt(projectName: string, conn: DbConnection): string {
  const target = [
    `Conexao alvo: ${conn.label}`,
    `Motor: ${conn.engine}`,
    conn.database_name ? `Banco/schema padrao: ${conn.database_name}` : null,
    conn.host ? `Host: ${conn.host}${conn.port ? `:${conn.port}` : ''}` : null,
    conn.file_path ? `Arquivo: ${conn.file_path}` : null,
    conn.group_name ? `Grupo: ${conn.group_name}` : null,
    conn.is_read_only ? 'Marcada como somente leitura na tela de bancos.' : 'A conexao pode permitir escrita; trate tudo como read-only ate eu autorizar.',
  ].filter(Boolean).join('\n');

  return [
    'Atue como especialista em banco de dados deste projeto.',
    'Fale em portugues simples e objetivo, explicando tabelas, campos, relacionamentos e riscos como se eu fosse uma pessoa leiga.',
    'Use apenas ferramentas de banco quando possivel: db_list, db_schema, db_query e db_command. Se este projeto tambem for App Studio, voce pode usar as ferramentas app_* apenas para entender ou propor ajustes de spec.',
    'Comece chamando db_list e confirme que a conexao abaixo existe. Depois use db_schema sem table apenas para obter o catalogo paginado. Use search para reduzir candidatos e db_schema com table para detalhar somente as tabelas relevantes; nunca carregue o schema inteiro de uma vez.',
    'Para SQL relacional, use db_query para consultas seguras de leitura. Para MongoDB ou Redis, use db_command. Antes de qualquer escrita, explique o comando e o impacto; a execucao sera bloqueada ate minha aprovacao explicita, mesmo se o chat estiver em modo autonomo.',
    'Ajude a encontrar: tabelas principais, chaves primarias, FKs ausentes, tabelas sem uso aparente, dados inconsistentes, oportunidades de indice, duplicidade e consultas uteis para auditoria.',
    `Projeto: ${projectName}`,
    target,
  ].join('\n');
}

export function DbClientTab({ projectId, projectName = `Project ${projectId}` }: { projectId: number; projectName?: string }) {
  const { t } = useTranslation('dbClient');
  const db = useDbClient(projectId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);
  const [auxOpen, setAuxOpen] = useState(false);
  const [auxTick, setAuxTick] = useState(0);
  const [selectedSpecialistConnectionId, setSelectedSpecialistConnectionId] = useState('');
  const [dbLaunchPrompt, setDbLaunchPrompt] = useState<string | null>(null);
  const [pendingDbPrompt, setPendingDbPrompt] = useState<string | null>(null);
  const [dbAgentConfig, setDbAgentConfig] = useState<AppStudioSpecAgentConfig | null>(null);
  const [dbAgentOpen, setDbAgentOpen] = useState(false);
  const [dbLaunchId, setDbLaunchId] = useState(0);

  function openFromAux(sql: string): void {
    if (db.activeConnectionId != null) db.openQueryTab(db.activeConnectionId, undefined, sql);
  }

  function openAdd(): void {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(conn: DbConnection): void {
    setEditing(conn);
    setDialogOpen(true);
  }

  const activeConn = db.connections.find((c) => c.id === db.activeConnectionId) ?? null;
  const specialistConn =
    db.connections.find((c) => String(c.id) === selectedSpecialistConnectionId) ?? activeConn ?? db.connections[0] ?? null;
  const specialistSessionTitle = specialistConn
    ? t('specialist.sessionTitle', { name: specialistConn.label })
    : t('specialist.sessionTitleFallback');
  const connectionOptions = useMemo(
    () => db.connections.map((conn) => ({
      value: String(conn.id),
      label: conn.label,
      hint: conn.engine,
      description: conn.database_name ?? conn.host ?? conn.file_path ?? undefined,
    })),
    [db.connections],
  );

  useEffect(() => {
    if (db.connections.length === 0) {
      if (selectedSpecialistConnectionId) setSelectedSpecialistConnectionId('');
      return;
    }
    if (selectedSpecialistConnectionId && db.connections.some((conn) => String(conn.id) === selectedSpecialistConnectionId)) {
      return;
    }
    setSelectedSpecialistConnectionId(String(activeConn?.id ?? db.connections[0].id));
  }, [activeConn?.id, db.connections, selectedSpecialistConnectionId]);

  const openDbSpecialist = () => {
    if (!specialistConn) return;
    setDbLaunchPrompt(buildProjectDbSpecialistPrompt(projectName, specialistConn));
  };

  const launchDbAgent = (config: AppStudioSpecAgentConfig) => {
    if (dbLaunchPrompt === null) return;
    setDbAgentConfig(config);
    setPendingDbPrompt(dbLaunchPrompt.trim() ? dbLaunchPrompt : null);
    setDbLaunchId((n) => n + 1);
    setDbAgentOpen(true);
    setDbLaunchPrompt(null);
  };

  return (
    <div className="flex h-full flex-col bg-card">
      <AppStudioSpecAgentLauncher
        kind="db"
        open={dbLaunchPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setDbLaunchPrompt(null);
        }}
        onLaunch={launchDbAgent}
      />
      <div className="flex h-9 items-center gap-2 border-b px-3 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-medium">{t('title')}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {activeConn ? `· ${activeConn.label}` : `· ${t('toolbar.noConnection')}`}
          </span>
          {db.error && <span className="min-w-0 truncate text-red-400" title={db.error}>{db.error}</span>}
        </div>
        {db.connections.length > 0 && (
          <>
            <div className="w-44 sm:w-56">
              <Combobox
                value={specialistConn ? String(specialistConn.id) : ''}
                onChange={setSelectedSpecialistConnectionId}
                options={connectionOptions}
                placeholder={t('specialist.selectConnection')}
                searchPlaceholder={t('specialist.searchConnection')}
                emptyLabel={t('specialist.noConnections')}
                className="h-7"
                contentClassName="min-w-[18rem]"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              disabled={!specialistConn}
              onClick={openDbSpecialist}
              title={t('specialist.open')}
            >
              <Bot className="h-3.5 w-3.5" />
              {t('specialist.open')}
            </Button>
          </>
        )}
        <button
          className={cn('rounded p-1 hover:bg-muted', auxOpen ? 'text-foreground' : 'text-muted-foreground')}
          title={t('aux.panel')}
          onClick={() => setAuxOpen((o) => !o)}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId={`mcp-db-client-specialist-${projectId}`}>
          <Panel id="db-client-main" order={1} minSize={45}>
            <PanelGroup direction="horizontal" autoSaveId={`mcp-db-client-${projectId}`}>
              <Panel defaultSize={24} minSize={14} maxSize={42}>
                <ConnectionTree db={db} onAdd={openAdd} onEdit={openEdit} />
              </Panel>
              <PanelResizeHandle className="w-px bg-border hover:bg-accent" />
              <Panel minSize={40}>
                <PanelGroup direction="horizontal">
                  <Panel minSize={30}>
                    <div className="flex h-full flex-col">
                      <WorkAreaTabBar db={db} />
                      <div className="relative min-h-0 flex-1">
                        {db.workTabs.length === 0 && (
                          <div className="grid h-full place-items-center px-6 text-center text-xs text-muted-foreground">
                            {t('tabs.empty')}
                          </div>
                        )}
                        {/* Keep-alive: every open tab stays mounted; only the active one
                            is shown (preserves SQL text + scroll, like the Monaco tabs). */}
                        {db.workTabs.map((tab) => (
                          <div
                            key={tab.id}
                            className="absolute inset-0"
                            style={{ display: tab.id === db.activeTabId ? 'block' : 'none' }}
                          >
                            <TabContent
                              tab={tab}
                              projectId={projectId}
                              engine={db.connections.find((c) => c.id === tab.connectionId)?.engine}
                              suggestions={db.treeSuggestions(tab.connectionId)}
                              onStructureApplied={() => db.invalidateTables(tab.connectionId, tab.schema)}
                              onSaved={() => setAuxTick((x) => x + 1)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </Panel>
                  {auxOpen && (
                    <>
                      <PanelResizeHandle className="w-px bg-border hover:bg-accent" />
                      <Panel defaultSize={26} minSize={16} maxSize={42}>
                        <QueryAuxPanel
                          projectId={projectId}
                          connectionId={db.activeConnectionId}
                          refreshKey={auxTick}
                          onOpenQuery={openFromAux}
                        />
                      </Panel>
                    </>
                  )}
                </PanelGroup>
              </Panel>
            </PanelGroup>
          </Panel>
          {dbAgentOpen && (
            <>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
              <Panel id="db-specialist-chat" order={2} defaultSize={30} minSize={20} maxSize={44} className="min-w-[320px]">
                <AppStudioChatRail
                  key={`project-db-${dbLaunchId}`}
                  projectId={projectId}
                  projectName={projectName}
                  mode="db"
                  initialPrompt={pendingDbPrompt}
                  initialConfig={dbAgentConfig}
                  sessionTitle={specialistSessionTitle}
                  onInitialPromptConsumed={() => setPendingDbPrompt(null)}
                  onCollapse={() => setDbAgentOpen(false)}
                />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {dialogOpen && (
        <ConnectionDialog
          open={dialogOpen}
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
    </div>
  );
}

/** Render a single work tab's content (query console / data grid / structure). */
function TabContent({
  tab,
  projectId,
  engine,
  suggestions,
  onStructureApplied,
  onSaved,
}: {
  tab: WorkTab;
  projectId: number;
  engine?: DbEngine;
  suggestions: string[];
  onStructureApplied: () => void;
  onSaved: () => void;
}) {
  if (tab.kind === 'documents' && tab.table) {
    return <DocumentsTab connKey={tab.connKey} database={tab.database} collection={tab.table} />;
  }
  if (tab.kind === 'keyvalue') {
    return <KeyValueTab connKey={tab.connKey} db={tab.database ?? '0'} />;
  }
  if (tab.kind === 'data' && tab.table) {
    return <DataGridTab connKey={tab.connKey} schema={tab.schema ?? ''} table={tab.table} engine={engine} />;
  }
  if (tab.kind === 'er') {
    return <ErDiagramTab connKey={tab.connKey} schema={tab.schema} />;
  }
  if (tab.kind === 'structure') {
    return (
      <TableStructureEditor
        connKey={tab.connKey}
        engine={engine}
        schema={tab.schema}
        table={tab.table || undefined}
        onApplied={onStructureApplied}
      />
    );
  }
  return (
    <QueryConsole
      projectId={projectId}
      connectionId={tab.connectionId}
      connKey={tab.connKey}
      suggestions={suggestions}
      engine={engine}
      schema={tab.schema}
      initialSql={tab.initialSql}
      onSaved={onSaved}
    />
  );
}
