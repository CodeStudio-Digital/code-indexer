/**
 * API client tab — an in-app Postman over the project's persisted collections.
 * Three resizable panes (collection list · request editor · response viewer)
 * plus a toolbar for the active environment. Mounted both in the project IDE
 * (ProjectView) and inside the company API tab.
 */
import { useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Loader2, Settings2, Download, Upload, Play, ChevronDown, Plus, Library } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../components/ui/dropdown-menu.js';
import { toast, prompt } from '../../components/ui/prompt-dialog.js';
import { useApiClient } from './useApiClient.js';
import { SubTabs, type SubTabDef } from './SubTabs.js';
import { downloadJson } from './download.js';
import * as api from './api.js';
import { CollectionList } from './CollectionList.js';
import { CollectionsDialog } from './CollectionsDialog.js';
import { RequestEditor } from './RequestEditor.js';
import { ResponseViewer } from './ResponseViewer.js';
import { RequestTimeline } from './RequestTimeline.js';
import { EnvEditor } from './EnvEditor.js';
import { EnvManagerDialog } from './EnvManagerDialog.js';
import { ImportOpenApiDialog } from './ImportOpenApiDialog.js';
import { ImportCurlDialog } from './ImportCurlDialog.js';
import { CodeDialog } from './CodeDialog.js';
import { RegressionPanel } from './RegressionPanel.js';

const RESP_TABS = [
  { id: 'response' as const, label: 'Response' },
  { id: 'history' as const, label: 'History' },
];

export function ApiClientTab({ projectId }: { projectId: number }) {
  const c = useApiClient(projectId);
  const { state } = c;
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [envEditorOpen, setEnvEditorOpen] = useState(false);
  const [envEditId, setEnvEditId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [curlOpen, setCurlOpen] = useState(false);
  const [regressionOpen, setRegressionOpen] = useState(false);
  const [respTab, setRespTab] = useState<'response' | 'history'>('response');
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeRid, setCodeRid] = useState<number | null>(null);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const openEnvEditor = (id: number | null) => { setEnvManagerOpen(false); setEnvEditId(id); setEnvEditorOpen(true); };

  const newCollection = async () => {
    const n = await prompt({ title: 'New collection', placeholder: 'Collection name' });
    if (n?.trim()) await c.addCollection(n.trim());
  };

  const onImported = async (collectionId: number) => {
    await c.refreshCollections();
    c.selectCollection(collectionId);
  };

  const onCurlImported = async (collectionId: number, requestId: number) => {
    await c.refreshCollections();
    c.selectCollection(collectionId);
    c.reloadRequests();
    c.selectRequest(requestId);
  };

  // Used by the curl-import dialog when there's no collection yet.
  const ensureCollection = async (): Promise<number> => {
    if (state.activeCollectionId != null) return state.activeCollectionId;
    const col = await api.createCollection(projectId, 'Imported');
    await c.refreshCollections();
    c.selectCollection(col.id);
    return col.id;
  };

  const exportCollection = async (format: 'postman' | 'openapi') => {
    if (state.activeCollectionId == null) {
      toast.error('Export failed', { description: 'Select a collection first.' });
      return;
    }
    try {
      const doc = await api.exportCollection(projectId, state.activeCollectionId, format);
      const filename = `collection.${format === 'openapi' ? 'openapi.json' : 'postman.json'}`;
      downloadJson(filename, doc);
      toast.success('Exported', { description: filename });
    } catch (e) {
      toast.error('Export failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const openCode = (rid: number) => { setCodeRid(rid); setCodeOpen(true); };

  const activeRequest = useMemo(
    () => state.requests.find((r) => r.id === state.activeRequestId) ?? null,
    [state.requests, state.activeRequestId],
  );
  const selectedEnv = useMemo(
    () => state.environments.find((e) => e.id === state.selectedEnvId) ?? null,
    [state.environments, state.selectedEnvId],
  );

  if (state.loading) {
    return <div className="h-full flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="h-10 flex items-center gap-2 px-3 border-b text-xs">
        <span className="font-medium">API</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1">
              <Download className="h-3.5 w-3.5" /> Import <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => setImportOpen(true)}>OpenAPI / Swagger</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCurlOpen(true)}>cURL / bash</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1" disabled={state.activeCollectionId == null}>
              <Upload className="h-3.5 w-3.5" /> Export <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void exportCollection('postman')}>Postman v2.1</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportCollection('openapi')}>OpenAPI 3.1</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" className="h-7 gap-1" disabled={state.activeCollectionId == null} onClick={() => setRegressionOpen(true)}>
          <Play className="h-3.5 w-3.5" /> Run all
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void newCollection()}>
          <Plus className="h-3.5 w-3.5" /> New collection
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setCollectionsOpen(true)}>
          <Library className="h-3.5 w-3.5" /> Collections
        </Button>
        <span className="ml-auto text-muted-foreground">Env</span>
        <select
          className="text-xs bg-background border rounded px-2 py-1 max-w-[180px]"
          value={state.selectedEnvId ?? ''}
          onChange={(e) => c.selectEnv(Number(e.target.value))}
        >
          {state.environments.length === 0 && <option value="">No environments</option>}
          {state.environments.map((e) => <option key={e.id} value={e.id}>{e.name}{e.is_default ? ' ★' : ''}</option>)}
        </select>
        <Button size="sm" variant="outline" className="h-7 w-7 p-0" title="New environment" onClick={() => openEnvEditor(null)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setEnvManagerOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" /> Environments
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId={`mcp-api-client-horiz-${projectId}`}>
          <Panel defaultSize={22} minSize={14} maxSize={40}>
            <div className="h-full border-r overflow-hidden">
              <CollectionList
                collections={state.collections}
                requests={state.requests}
                activeCollectionId={state.activeCollectionId}
                activeRequestId={state.activeRequestId}
                onSelectCollection={c.selectCollection}
                onSelectRequest={c.selectRequest}
                onAddRequest={c.addRequest}
                onRemoveRequest={c.removeRequest}
                onDuplicate={c.duplicateRequest}
                onAddFolder={c.addFolder}
                onRenameFolder={c.renameFolder}
                onRemoveFolder={c.removeFolder}
                onMoveRequest={c.moveRequest}
                onReorder={c.reorderRequests}
                onBulkMove={c.bulkMove}
                onBulkDelete={c.bulkDelete}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel minSize={28}>
            <RequestEditor
              request={activeRequest}
              baseUrl={selectedEnv?.base_url ?? ''}
              sending={state.sending}
              onSave={c.saveRequest}
              onSend={c.send}
              onOpenCode={openCode}
            />
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel defaultSize={34} minSize={20}>
            <div className="h-full border-l overflow-hidden flex flex-col">
              <SubTabs tabs={RESP_TABS} active={respTab} onChange={setRespTab} className="shrink-0" />
              <div className="flex-1 min-h-0">
                {respTab === 'response' ? (
                  <ResponseViewer
                    response={state.response}
                    error={state.error}
                    sending={state.sending}
                    verifiedStatus={activeRequest?.verified ? activeRequest.expected_status : null}
                    onMarkVerified={activeRequest ? (status) => c.verifyRequest(activeRequest.id, status) : undefined}
                  />
                ) : (
                  <RequestTimeline
                    projectId={projectId}
                    requestId={state.activeRequestId}
                    refreshToken={state.response}
                  />
                )}
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <CollectionsDialog
        collections={state.collections}
        activeCollectionId={state.activeCollectionId}
        open={collectionsOpen}
        onOpenChange={setCollectionsOpen}
        onSelect={c.selectCollection}
        onRename={c.renameCollection}
        onDelete={c.removeCollection}
      />
      <EnvManagerDialog
        environments={state.environments}
        selectedEnvId={state.selectedEnvId}
        open={envManagerOpen}
        onOpenChange={setEnvManagerOpen}
        onSelect={c.selectEnv}
        onEdit={openEnvEditor}
        onDelete={c.removeEnvironment}
        onNew={() => openEnvEditor(null)}
      />
      <EnvEditor
        projectId={projectId}
        environments={state.environments}
        open={envEditorOpen}
        onOpenChange={setEnvEditorOpen}
        onChanged={c.refreshEnvironments}
        editId={envEditId}
      />
      <ImportOpenApiDialog
        projectId={projectId}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
      />
      <ImportCurlDialog
        projectId={projectId}
        collectionId={state.activeCollectionId}
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImported={onCurlImported}
        ensureCollection={ensureCollection}
      />
      <CodeDialog
        projectId={projectId}
        requestId={codeRid}
        envId={state.selectedEnvId}
        open={codeOpen}
        onOpenChange={setCodeOpen}
      />
      <RegressionPanel
        projectId={projectId}
        collectionId={state.activeCollectionId}
        envId={state.selectedEnvId}
        open={regressionOpen}
        onOpenChange={setRegressionOpen}
        onRequestsChanged={c.reloadRequests}
      />
    </div>
  );
}
