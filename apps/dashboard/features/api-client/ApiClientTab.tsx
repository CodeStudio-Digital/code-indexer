/**
 * API client tab — an in-app Postman over the project's persisted collections.
 * Three resizable panes (collection list · request editor · response viewer)
 * plus a toolbar for the active environment. Mounted both in the project IDE
 * (ProjectView) and inside the company API tab.
 */
import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Loader2, Settings2, Download, Upload, Play, ChevronDown, Plus, Library, Globe, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../components/ui/dropdown-menu.js';
import { toast, prompt, confirm } from '../../components/ui/prompt-dialog.js';
import { useApiClient } from './useApiClient.js';
import { SubTabs } from './SubTabs.js';
import { downloadJson } from './download.js';
import * as api from './api.js';
import * as docsApi from './docs-studio/docs-studio-api.js';
import { parseRows } from './kv-grid/kv-utils.js';
import type { ApiRequest } from './types.js';
import { CollectionList } from './CollectionList.js';
import { CollectionsDialog } from './CollectionsDialog.js';
import { SaveRequestDialog } from './SaveRequestDialog.js';
import { RequestEditor } from './RequestEditor.js';
import { RequestTabBar } from './RequestTabBar.js';
import { ResponseViewer } from './ResponseViewer.js';
import { RequestTimeline } from './RequestTimeline.js';
import { EnvEditor } from './EnvEditor.js';
import { EnvManagerDialog } from './EnvManagerDialog.js';
import { ImportOpenApiDialog } from './ImportOpenApiDialog.js';
import { ImportCurlDialog } from './ImportCurlDialog.js';
import { CodeDialog } from './CodeDialog.js';
import { PublishDocsDialog } from './PublishDocsDialog.js';
import { CloudSyncDialog } from './CloudSyncDialog.js';
import { RegressionPanel } from './RegressionPanel.js';
import { jsonShape } from './ai/response-shape.js';

// Docs Studio lives INSIDE this tab (Client / Docs toggle), not as its own rail
// tab — lazy so its heavy deps (Scalar, Monaco) don't weigh on the client view.
const DocsStudioView = lazy(() => import('./docs-studio/DocsStudioView.js').then((m) => ({ default: m.DocsStudioView })));

const RESP_TABS = [
  { id: 'response' as const, labelKey: 'response' },
  { id: 'history' as const, labelKey: 'history' },
];

export function ApiClientTab({ projectId, docsAccess = false }: { projectId: number; docsAccess?: boolean }) {
  const { t } = useTranslation('apiClient');
  const c = useApiClient(projectId);
  const { state } = c;
  // Client = the Postman UI; Docs = the in-tab Documentation Studio. Only offered
  // when `docsAccess` (the project IDE); the company surface has its own toggle.
  const [view, setView] = useState<'client' | 'docs'>('client');
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
  const [publishDocsOpen, setPublishDocsOpen] = useState(false);
  const [cloudSyncOpen, setCloudSyncOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveDraftObj, setSaveDraftObj] = useState<ApiRequest | null>(null);
  const openEnvEditor = (id: number | null) => { setEnvManagerOpen(false); setEnvEditId(id); setEnvEditorOpen(true); };

  // Create a collection and return its id (for the Save-request modal).
  const createCollectionReturningId = async (name: string): Promise<number> => {
    const col = await api.createCollection(projectId, name);
    await c.refreshCollections();
    return col.id;
  };

  const newCollection = async () => {
    const n = await prompt({ title: t('toolbar.newCollection'), placeholder: t('toolbar.collectionNamePlaceholder') });
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
    const col = await api.createCollection(projectId, t('toolbar.importedCollectionName'));
    await c.refreshCollections();
    c.selectCollection(col.id);
    return col.id;
  };

  const exportCollection = async (format: 'postman' | 'openapi') => {
    if (state.activeCollectionId == null) {
      toast.error(t('toolbar.exportFailed'), { description: t('toolbar.selectCollectionFirst') });
      return;
    }
    try {
      const doc = await api.exportCollection(projectId, state.activeCollectionId, format);
      const filename = `collection.${format === 'openapi' ? 'openapi.json' : 'postman.json'}`;
      downloadJson(filename, doc);
      toast.success(t('toolbar.exported'), { description: filename });
    } catch (e) {
      toast.error(t('toolbar.exportFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const openCode = (rid: number) => { setCodeRid(rid); setCodeOpen(true); };

  // The draft is a tab now — switching tabs/requests never discards it; only an
  // explicit close (the tab X or the editor's discard button) confirms when dirty.
  const dirty = state.draftRequest != null && state.draftDirty;
  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    return confirm({ title: t('toolbar.discardConfirmTitle'), description: t('toolbar.discardConfirmBody'), tone: 'destructive' });
  }, [dirty, t]);
  const discardDraftGuarded = useCallback(async () => { if (await confirmDiscard()) c.discardDraft(); }, [confirmDiscard, c.discardDraft]);
  // Closing a tab: the draft (negative id) routes through the discard confirm; a
  // saved request closes immediately (it persists on blur — nothing to lose).
  const closeTabGuarded = useCallback((id: number) => { if (id < 0) void discardDraftGuarded(); else c.closeTab(id); }, [discardDraftGuarded, c.closeTab]);

  // Context-menu bulk closes. If the action would discard the unsaved draft,
  // confirm once first; a saved request persists on blur, so it closes freely.
  const draftId = state.draftRequest?.id ?? null;
  const runBulkClose = useCallback(async (willDiscardDraft: boolean, run: () => void) => {
    if (willDiscardDraft && !(await confirmDiscard())) return;
    run();
  }, [confirmDiscard]);
  const onCloseOthers = useCallback((id: number) =>
    void runBulkClose(dirty && draftId != null && id !== draftId, () => c.closeOtherTabs(id)),
    [runBulkClose, dirty, draftId, c.closeOtherTabs]);
  const onCloseRight = useCallback((id: number) => {
    const di = draftId != null ? state.openTabIds.indexOf(draftId) : -1;
    void runBulkClose(dirty && di > state.openTabIds.indexOf(id), () => c.closeTabsToRight(id));
  }, [runBulkClose, dirty, draftId, state.openTabIds, c.closeTabsToRight]);
  const onCloseLeft = useCallback((id: number) => {
    const di = draftId != null ? state.openTabIds.indexOf(draftId) : -1;
    void runBulkClose(dirty && di >= 0 && di < state.openTabIds.indexOf(id), () => c.closeTabsToLeft(id));
  }, [runBulkClose, dirty, draftId, state.openTabIds, c.closeTabsToLeft]);
  const onCloseAllTabs = useCallback(() => void runBulkClose(dirty, () => c.closeAllTabs()), [runBulkClose, dirty, c.closeAllTabs]);

  const activeRequest = useMemo(
    () => state.requests.find((r) => r.id === state.activeRequestId) ?? null,
    [state.requests, state.activeRequestId],
  );
  // Active tab: a negative active id = the draft; otherwise the saved request.
  const isDraft = state.activeRequestId != null && state.activeRequestId < 0 && state.draftRequest != null;
  const editing = isDraft ? state.draftRequest : activeRequest;
  const selectedEnv = useMemo(
    () => state.environments.find((e) => e.id === state.selectedEnvId) ?? null,
    [state.environments, state.selectedEnvId],
  );
  // Privacy-safe shape (keys+types, never values) of the last response — context
  // for the AI script bar so it can write asserts without leaking tokens/secrets.
  const responseShape = useMemo(() => (state.response ? jsonShape(state.response.body) : undefined), [state.response]);

  // Capture the current response as a documentation example (saved-request only).
  // The server re-redacts on write, so secrets in the live response never persist.
  const saveExample = useCallback(async () => {
    const resp = state.response;
    if (!resp || !activeRequest) return;
    const name = await prompt({ title: t('toolbar.saveExampleTitle'), placeholder: t('toolbar.saveExamplePlaceholder'), defaultValue: String(resp.status) });
    if (name == null) return;
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(resp.headers)) respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    const reqHeaders: Record<string, string> = {};
    for (const r of parseRows(activeRequest.headers_json)) if (r.enabled && r.key) reqHeaders[r.key] = r.value;
    const capture = {
      name: name.trim() || 'Example',
      req: { method: activeRequest.method, url: resp.url, headers: reqHeaders, body: activeRequest.body_json, bodyKind: activeRequest.body_kind },
      resp: { status: resp.status, statusText: resp.statusText, headers: respHeaders, body: resp.body, contentType: respHeaders['content-type'] ?? null, size: resp.size ?? null },
    };
    try {
      const ex = await docsApi.createExample(projectId, activeRequest.id, { name: capture.name, capture });
      toast.success(t('toolbar.exampleSaved'), { description: ex.redaction_count > 0 ? t('toolbar.exampleRedacted', { count: ex.redaction_count }) : undefined });
    } catch (e) {
      toast.error(t('toolbar.exampleSaveFailed'), { description: e instanceof Error ? e.message : String(e) });
    }
  }, [state.response, activeRequest, projectId, t]);

  return (
    <div className="flex flex-col h-full bg-card">
      {docsAccess && (
        <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b text-xs">
          <ModeBtn active={view === 'client'} onClick={() => setView('client')}>{t('mode.client')}</ModeBtn>
          <ModeBtn active={view === 'docs'} onClick={() => setView('docs')}>{t('mode.docs')}</ModeBtn>
        </div>
      )}
      {docsAccess && view === 'docs' ? (
        <div className="flex-1 min-h-0">
          <Suspense fallback={<div className="h-full grid place-items-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
            <DocsStudioView projectId={projectId} />
          </Suspense>
        </div>
      ) : state.loading ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : (
      <>
      <div className="h-10 flex items-center gap-2 px-3 border-b text-xs">
        <span className="font-medium">API</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1">
              <Download className="h-3.5 w-3.5" /> {t('toolbar.import')} <ChevronDown className="h-3 w-3" />
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
              <Upload className="h-3.5 w-3.5" /> {t('toolbar.export')} <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => void exportCollection('postman')}>Postman v2.1</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportCollection('openapi')}>OpenAPI 3.1</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPublishDocsOpen(true)}><Globe className="h-3.5 w-3.5 mr-2" /> {t('toolbar.publishDocs')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="outline" className="h-7 gap-1" disabled={state.activeCollectionId == null} onClick={() => setRegressionOpen(true)}>
          <Play className="h-3.5 w-3.5" /> {t('toolbar.runAll')}
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void newCollection()}>
          <Plus className="h-3.5 w-3.5" /> {t('toolbar.newCollection')}
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setCollectionsOpen(true)}>
          <Library className="h-3.5 w-3.5" /> {t('toolbar.collections')}
        </Button>
        <span className="ml-auto text-muted-foreground">{t('toolbar.env')}</span>
        <select
          className="text-xs bg-background border rounded px-2 py-1 max-w-[180px]"
          value={state.selectedEnvId ?? ''}
          onChange={(e) => c.selectEnv(Number(e.target.value))}
        >
          {state.environments.length === 0 && <option value="">{t('toolbar.noEnvironments')}</option>}
          {state.environments.map((e) => <option key={e.id} value={e.id}>{e.name}{e.is_default ? ' ★' : ''}</option>)}
        </select>
        <Button size="sm" variant="outline" className="h-7 w-7 p-0" title={t('toolbar.newEnvironment')} onClick={() => openEnvEditor(null)}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" className="h-7 w-7 p-0" title={t('toolbar.sync')} onClick={() => setCloudSyncOpen(true)}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => setEnvManagerOpen(true)}>
          <Settings2 className="h-3.5 w-3.5" /> {t('toolbar.environments')}
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId={`mcp-api-client-horiz-${projectId}`}>
          <Panel defaultSize={22} minSize={14} maxSize={40}>
            <div className="h-full border-r overflow-hidden">
              <CollectionList
                projectId={projectId}
                collections={state.collections}
                requests={state.requests}
                activeCollectionId={state.activeCollectionId}
                activeRequestId={state.activeRequestId}
                onSelectCollection={c.selectCollection}
                onSelectRequest={c.selectRequest}
                onNewRequest={c.newDraft}
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
            <div className="flex flex-col h-full">
              <RequestTabBar
                requests={state.requests}
                draftRequest={state.draftRequest}
                draftDirty={state.draftDirty}
                openTabIds={state.openTabIds}
                activeRequestId={state.activeRequestId}
                onActivate={c.selectRequest}
                onClose={closeTabGuarded}
                onCloseOthers={onCloseOthers}
                onCloseRight={onCloseRight}
                onCloseLeft={onCloseLeft}
                onCloseAll={onCloseAllTabs}
              />
              <div className="flex-1 min-h-0">
                <RequestEditor
                  request={editing}
                  isDraft={isDraft}
                  baseUrl={selectedEnv?.base_url ?? ''}
                  sending={state.sending}
                  responseShape={responseShape}
                  onSave={(rid, p) => (isDraft ? c.updateDraft(p) : c.saveRequest(rid, p))}
                  onSend={c.send}
                  onSendDraft={c.sendDraft}
                  onSaveDraft={(d) => { setSaveDraftObj(d); setSaveOpen(true); }}
                  onDiscardDraft={discardDraftGuarded}
                  onOpenCode={openCode}
                  onAssist={(payload) => api.scriptAssist(projectId, payload)}
                />
              </div>
            </div>
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel defaultSize={34} minSize={20}>
            <div className="h-full border-l overflow-hidden flex flex-col">
              <SubTabs tabs={RESP_TABS.map((tab) => ({ id: tab.id, label: t(`toolbar.${tab.labelKey}`) }))} active={respTab} onChange={setRespTab} className="shrink-0" />
              <div className="flex-1 min-h-0">
                {respTab === 'response' ? (
                  <ResponseViewer
                    response={state.response}
                    error={state.error}
                    sending={state.sending}
                    verifiedStatus={activeRequest?.verified ? activeRequest.expected_status : null}
                    onMarkVerified={activeRequest ? (status) => c.verifyRequest(activeRequest.id, status) : undefined}
                    onSaveExample={state.response && activeRequest && !isDraft ? saveExample : undefined}
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
      <SaveRequestDialog
        projectId={projectId}
        open={saveOpen}
        onOpenChange={setSaveOpen}
        collections={state.collections}
        draftName={saveDraftObj?.name ?? t('toolbar.untitledRequest')}
        onSave={(cid, folder, name) => saveDraftObj && c.saveDraft(saveDraftObj, cid, folder, name)}
        onCreateCollection={createCollectionReturningId}
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
      <PublishDocsDialog
        projectId={projectId}
        collectionId={state.activeCollectionId}
        collectionName={state.collections.find((col) => col.id === state.activeCollectionId)?.name ?? t('toolbar.importedCollectionName')}
        open={publishDocsOpen}
        onOpenChange={setPublishDocsOpen}
      />
      <CloudSyncDialog projectId={projectId} open={cloudSyncOpen} onOpenChange={setCloudSyncOpen} />
      <RegressionPanel
        projectId={projectId}
        collectionId={state.activeCollectionId}
        envId={state.selectedEnvId}
        open={regressionOpen}
        onOpenChange={setRegressionOpen}
        onRequestsChanged={c.reloadRequests}
      />
      </>
      )}
    </div>
  );
}

/** Segmented Client / Docs switch shown in the API tab when docs access is on. */
function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded transition-colors ${active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {children}
    </button>
  );
}
