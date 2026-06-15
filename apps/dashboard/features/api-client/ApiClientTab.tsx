/**
 * API client tab — an in-app Postman over the project's persisted collections.
 * Three resizable panes (collection list · request editor · response viewer)
 * plus a toolbar for the active environment. Mounted both in the project IDE
 * (ProjectView) and inside the company API tab.
 */
import { useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Loader2, Settings2, Download, Play } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { useApiClient } from './useApiClient.js';
import { CollectionList } from './CollectionList.js';
import { RequestEditor } from './RequestEditor.js';
import { ResponseViewer } from './ResponseViewer.js';
import { EnvEditor } from './EnvEditor.js';
import { ImportOpenApiDialog } from './ImportOpenApiDialog.js';
import { RegressionPanel } from './RegressionPanel.js';

export function ApiClientTab({ projectId }: { projectId: number }) {
  const c = useApiClient(projectId);
  const { state } = c;
  const [envOpen, setEnvOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [regressionOpen, setRegressionOpen] = useState(false);

  const onImported = async (collectionId: number) => {
    await c.refreshCollections();
    c.selectCollection(collectionId);
  };

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
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setImportOpen(true)}>
          <Download className="h-3.5 w-3.5" /> Import OpenAPI
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1" disabled={state.activeCollectionId == null} onClick={() => setRegressionOpen(true)}>
          <Play className="h-3.5 w-3.5" /> Run all
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
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setEnvOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" /> Environments
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId="mcp-api-client-horiz">
          <Panel defaultSize={22} minSize={14} maxSize={40}>
            <div className="h-full border-r overflow-hidden">
              <CollectionList
                collections={state.collections}
                requests={state.requests}
                activeCollectionId={state.activeCollectionId}
                activeRequestId={state.activeRequestId}
                onSelectCollection={c.selectCollection}
                onSelectRequest={c.selectRequest}
                onAddCollection={c.addCollection}
                onRemoveCollection={c.removeCollection}
                onAddRequest={c.addRequest}
                onRemoveRequest={c.removeRequest}
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
            />
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel defaultSize={34} minSize={20}>
            <div className="h-full border-l overflow-hidden">
              <ResponseViewer
                response={state.response}
                error={state.error}
                sending={state.sending}
                verifiedStatus={activeRequest?.verified ? activeRequest.expected_status : null}
                onMarkVerified={activeRequest ? (status) => c.verifyRequest(activeRequest.id, status) : undefined}
              />
            </div>
          </Panel>
        </PanelGroup>
      </div>

      <EnvEditor
        projectId={projectId}
        environments={state.environments}
        open={envOpen}
        onOpenChange={setEnvOpen}
        onChanged={c.refreshEnvironments}
      />
      <ImportOpenApiDialog
        projectId={projectId}
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
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
