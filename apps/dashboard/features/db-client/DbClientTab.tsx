/**
 * Database client tab — a per-project DataGrip × phpMyAdmin surface.
 *
 * P0 layout: left = connection tree (lazy schema browse), center = a minimal
 * query console for the active connection. The full work-area tabs (query
 * consoles + data grid + structure editor) arrive in P1–P3. Mirrors the
 * api-client shell (resizable panes, self-contained hook, project-keyed mount).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '../../lib/utils.js';
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

export function DbClientTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation('dbClient');
  const db = useDbClient(projectId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);
  const [auxOpen, setAuxOpen] = useState(false);
  const [auxTick, setAuxTick] = useState(0);

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

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-9 items-center gap-2 border-b px-3 text-xs">
        <span className="font-medium">{t('title')}</span>
        <span className="text-muted-foreground">
          {activeConn ? `· ${activeConn.label}` : `· ${t('toolbar.noConnection')}`}
        </span>
        {db.error && <span className="ml-auto truncate text-red-400" title={db.error}>{db.error}</span>}
        <button
          className={cn('ml-auto rounded p-1 hover:bg-muted', auxOpen ? 'text-foreground' : 'text-muted-foreground', db.error && 'ml-2')}
          title={t('aux.panel')}
          onClick={() => setAuxOpen((o) => !o)}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
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
      </div>

      {dialogOpen && (
        <ConnectionDialog
          open={dialogOpen}
          projectId={projectId}
          existing={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={() => void db.refresh()}
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
