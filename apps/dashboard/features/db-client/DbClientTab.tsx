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
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useDbClient } from './useDbClient.js';
import { ConnectionTree } from './tree/ConnectionTree.js';
import { QueryConsole } from './query/QueryConsole.js';
import { ConnectionDialog } from './dialogs/ConnectionDialog.js';
import type { DbConnection } from './types.js';

export function DbClientTab({ projectId }: { projectId: number }) {
  const { t } = useTranslation('dbClient');
  const db = useDbClient(projectId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);

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
      </div>

      <div className="min-h-0 flex-1">
        <PanelGroup direction="horizontal" autoSaveId={`mcp-db-client-${projectId}`}>
          <Panel defaultSize={24} minSize={14} maxSize={42}>
            <ConnectionTree db={db} onAdd={openAdd} onEdit={openEdit} />
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-accent" />
          <Panel minSize={40}>
            <QueryConsole projectId={projectId} connectionId={db.activeConnectionId} />
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
    </div>
  );
}
