import type { OpenDatabaseTab } from '../../state/workspace.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { cn } from '../../lib/utils.js';
import { DataGridTab } from './data/DataGridTab.js';
import { DocumentsTab } from './data/DocumentsTab.js';
import { KeyValueTab } from './data/KeyValueTab.js';
import { QueryConsole } from './query/QueryConsole.js';
import { ErDiagramTab } from './structure/ErDiagramTab.js';
import { SchemaDiffTab } from './structure/SchemaDiffTab.js';
import { TableStructureEditor } from './structure/TableStructureEditor.js';

export function DatabaseEditorView({ tab }: { tab: OpenDatabaseTab }) {
  const updateDatabaseTab = useWorkspaceStore((state) => state.updateDatabaseTab);
  const work = tab.workTab;
  const connectionProjectId = tab.connectionProjectId ?? tab.projectId;
  // DatabaseEditorStack normally gives every tab its own retained component
  // instance. Keep the child keyed as a defensive boundary for standalone
  // consumers that replace a descriptor in place.
  const viewKey = tab.path;
  const notifyChanged = () => {
    window.dispatchEvent(new CustomEvent('mcp:database-changed', {
      detail: { connectionId: work.connectionId, schema: work.schema },
    }));
  };

  if (work.kind === 'documents' && work.table) {
    return <DocumentsTab key={viewKey} connKey={work.connKey} database={work.database} collection={work.table} />;
  }
  if (work.kind === 'keyvalue') {
    return <KeyValueTab key={viewKey} connKey={work.connKey} db={work.database ?? '0'} />;
  }
  if (work.kind === 'data' && work.table) {
    return <DataGridTab key={viewKey} connKey={work.connKey} schema={work.schema ?? ''} table={work.table} engine={tab.engine} />;
  }
  if (work.kind === 'er') {
    return <ErDiagramTab key={viewKey} connKey={work.connKey} schema={work.schema} />;
  }
  if (work.kind === 'schema-diff' && work.schema) {
    return <SchemaDiffTab key={viewKey} projectId={connectionProjectId} sourceConnKey={work.connKey} sourceSchema={work.schema} />;
  }
  if (work.kind === 'structure') {
    return (
      <TableStructureEditor
        key={viewKey}
        connKey={work.connKey}
        engine={tab.engine}
        schema={work.schema}
        table={work.table || undefined}
        onApplied={notifyChanged}
      />
    );
  }
  return (
    <QueryConsole
      key={viewKey}
      projectId={connectionProjectId}
      connectionId={work.connectionId}
      connKey={work.connKey}
      suggestions={tab.suggestions}
      engine={tab.engine}
      schema={work.schema}
      initialSql={work.initialSql}
      onSaved={() => window.dispatchEvent(new CustomEvent('mcp:database-query-saved'))}
      onSqlChange={(sql) => updateDatabaseTab(tab.projectId, tab.path, { workTab: { ...work, initialSql: sql, dirty: sql.length > 0 } })}
    />
  );
}

/**
 * Retained database editor surfaces.
 *
 * Database grids carry expensive, user-visible state (rows, filters, scroll,
 * pagination, pending edits and SQL). Keeping every open tab mounted avoids a
 * refetch/flicker on tab switches while the stable path key prevents state from
 * leaking between tables. Hidden panes use visibility rather than display:none
 * so virtual grids keep their measured viewport.
 */
export function DatabaseEditorStack({
  tabs,
  activePath,
}: {
  tabs: OpenDatabaseTab[];
  activePath: string | null;
}) {
  return (
    <>
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        return (
          <div
            key={tab.path}
            aria-hidden={!active}
            data-database-editor-path={tab.path}
            className={cn(
              'absolute inset-0',
              active ? 'visible z-10' : 'invisible pointer-events-none z-0',
            )}
          >
            <DatabaseEditorView tab={tab} />
          </div>
        );
      })}
    </>
  );
}
