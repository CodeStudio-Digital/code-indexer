/**
 * Docs Studio — author + organize a collection's documentation, with a LIVE
 * preview (the same DocShell that powers the published site). Three panes:
 * doc tree · authoring · preview. Reads the project's ApiClientStore via the
 * studio hook; saves on blur.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import {
  Loader2, FileText, Palette, BookText, Plus, Trash2, ChevronRight,
  PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { prompt, confirm } from '../../../components/ui/prompt-dialog.js';
import { useDocsStudio } from './use-docs-studio.js';
import { loadDocsStudioUi, saveDocsStudioUi } from './docs-studio-ui-state.js';
import { OverviewEditor, BrandingEditor, GuidePageEditor } from './DocEditors.js';
import { EndpointEditor } from './EndpointEditor.js';
import { DocShell } from '../doc-shell/DocShell.js';
import { METHOD_COLOR } from '../collection/row-format.js';
import { ApiClientSelect } from '../ApiClientSelect.js';

type Sel = { kind: 'overview' } | { kind: 'branding' } | { kind: 'guide'; id: number } | { kind: 'endpoint'; id: number };

export function DocsStudioView({ projectId }: { projectId: number }) {
  const { t } = useTranslation('apiClient');
  const c = useDocsStudio(projectId);
  const { state } = c;
  const [sel, setSel] = useState<Sel>({ kind: 'overview' });

  // Two minimizable regions: AUTHORING (tree + editor, hidden as one unit since
  // the editor follows the tree selection) and PREVIEW. Each panel is the source
  // of truth for its chevron via onCollapse/onExpand; the booleans seed the
  // initial sizes + persist. Toggles guard against hiding everything.
  const authoringRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);
  const [ui] = useState(() => {
    const u = loadDocsStudioUi(projectId);
    // Never restore into a fully blank layout.
    return u.authoringCollapsed && u.rightCollapsed ? { ...u, rightCollapsed: false } : u;
  });
  const [authoringCollapsed, setAuthoringCollapsed] = useState(ui.authoringCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(ui.rightCollapsed);

  const toggleAuthoring = () => {
    if (authoringCollapsed) { authoringRef.current?.expand(); return; }
    rightRef.current?.expand(); // keep preview visible so the layout isn't blank
    authoringRef.current?.collapse();
  };
  const togglePreview = () => {
    if (rightCollapsed) { rightRef.current?.expand(); return; }
    authoringRef.current?.expand();
    rightRef.current?.collapse();
  };

  const groups = useMemo(() => {
    const map = new Map<string, typeof state.requests>();
    for (const r of state.requests) { const f = (r.folder ?? '').trim(); if (!map.has(f)) map.set(f, []); map.get(f)!.push(r); }
    return map;
  }, [state.requests]);

  if (state.loading) return <div className="h-full grid place-items-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (state.collections.length === 0) return <div className="h-full grid place-items-center text-xs text-muted-foreground">{t('docs.noCollections')}</div>;

  const addGuide = async () => { const title = await prompt({ title: t('docs.newGuide'), placeholder: t('docs.guideTitlePlaceholder') }); if (title?.trim()) void c.createPage(title.trim()); };
  const delGuide = async (pid: number) => { if (await confirm({ title: t('docs.deleteGuideConfirm'), tone: 'destructive' })) void c.deletePage(pid); };

  const treeBtn = (label: string, icon: React.ReactNode, on: boolean, onClick: () => void) => (
    <button type="button" onClick={onClick}
      className={cn('w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs', on ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/50')}>
      {icon}<span className="truncate">{label}</span>
    </button>
  );

  return (
    <div className="flex flex-col h-full bg-card">
      <div className="h-10 shrink-0 border-b flex items-center gap-2 px-3 text-xs">
        <BookText className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{t('docs.title')}</span>
        <ApiClientSelect
          value={state.activeCollectionId == null ? '' : String(state.activeCollectionId)}
          onValueChange={(value) => { if (!value) return; setSel({ kind: 'overview' }); c.selectCollection(Number(value)); }}
          options={state.collections.map((collection) => ({ value: String(collection.id), label: collection.name }))}
          ariaLabel={t('collectionsDialog.title')}
          triggerClassName="w-[220px]"
        />
        {state.error && <span className="text-red-500 truncate">{state.error}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <HeaderToggle
            title={t(authoringCollapsed ? 'docs.showTree' : 'docs.hideTree')}
            onClick={toggleAuthoring}
            icon={authoringCollapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
          />
          <HeaderToggle
            title={t(rightCollapsed ? 'docs.showPreview' : 'docs.hidePreview')}
            onClick={togglePreview}
            icon={rightCollapsed ? <PanelRightOpen className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" autoSaveId={`mcp-docs-studio-outer-${projectId}`}>
          {/* AUTHORING region: tree + editor collapse together (editor follows tree). */}
          <Panel
            ref={authoringRef}
            order={1}
            defaultSize={authoringCollapsed ? 0 : rightCollapsed ? 100 : 62}
            minSize={32}
            collapsible
            collapsedSize={0}
            onCollapse={() => { setAuthoringCollapsed(true); saveDocsStudioUi(projectId, { authoringCollapsed: true }); }}
            onExpand={() => { setAuthoringCollapsed(false); saveDocsStudioUi(projectId, { authoringCollapsed: false }); }}
          >
            <PanelGroup direction="horizontal" autoSaveId={`mcp-docs-studio-inner-${projectId}`}>
              <Panel defaultSize={30} minSize={18} maxSize={48}>
                <div className="h-full border-r overflow-auto p-2 space-y-0.5">
                  {treeBtn(t('docs.overview'), <FileText className="h-3.5 w-3.5 shrink-0" />, sel.kind === 'overview', () => setSel({ kind: 'overview' }))}
                  {treeBtn(t('docs.branding'), <Palette className="h-3.5 w-3.5 shrink-0" />, sel.kind === 'branding', () => setSel({ kind: 'branding' }))}
                  <div className="flex items-center justify-between pt-2 pb-0.5 px-1">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('docs.guides')}</span>
                    <button type="button" className="text-muted-foreground hover:text-foreground" title={t('docs.newGuide')} onClick={() => void addGuide()}><Plus className="h-3.5 w-3.5" /></button>
                  </div>
                  {state.pages.map((p) => (
                    <div key={p.id} className="group/g flex items-center">
                      {treeBtn(p.title, <BookText className="h-3.5 w-3.5 shrink-0" />, sel.kind === 'guide' && sel.id === p.id, () => setSel({ kind: 'guide', id: p.id }))}
                      <button type="button" className="opacity-0 group-hover/g:opacity-100 px-1 text-muted-foreground hover:text-red-500" onClick={() => void delGuide(p.id)}><Trash2 className="h-3 w-3" /></button>
                    </div>
                  ))}
                  <div className="pt-2 pb-0.5 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t('docs.endpoints')}</div>
                  {[...groups.entries()].map(([folder, reqs]) => (
                    <div key={folder || '_top'}>
                      {folder && <div className="px-2 pt-1 text-[10px] text-muted-foreground/80 flex items-center gap-1"><ChevronRight className="h-3 w-3" />{folder}</div>}
                      {reqs.map((r) => (
                        <button key={r.id} type="button" onClick={() => setSel({ kind: 'endpoint', id: r.id })}
                          className={cn('w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs', sel.kind === 'endpoint' && sel.id === r.id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50')}>
                          <span className={cn('font-mono text-[9px] font-semibold w-9 shrink-0', METHOD_COLOR[r.method] ?? '')}>{r.method}</span>
                          <span className="truncate">{r.name}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </Panel>
              <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
              <Panel defaultSize={70} minSize={40}>
                {state.collection && renderEditor()}
              </Panel>
            </PanelGroup>
          </Panel>
          <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors" />
          <Panel
            ref={rightRef}
            order={2}
            defaultSize={rightCollapsed ? 0 : authoringCollapsed ? 100 : 38}
            minSize={24}
            collapsible
            collapsedSize={0}
            onCollapse={() => { setRightCollapsed(true); saveDocsStudioUi(projectId, { rightCollapsed: true }); }}
            onExpand={() => { setRightCollapsed(false); saveDocsStudioUi(projectId, { rightCollapsed: false }); }}
          >
            <div className="h-full border-l overflow-hidden">
              {state.model ? <DocShell model={state.model} /> : <div className="h-full grid place-items-center text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>}
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );

  function renderEditor() {
    if (!state.collection) return null;
    if (sel.kind === 'overview') return <OverviewEditor collection={state.collection} onSave={c.saveCollectionDocs} />;
    if (sel.kind === 'branding') return <BrandingEditor collection={state.collection} onSave={c.saveCollectionDocs} />;
    if (sel.kind === 'guide') {
      const page = state.pages.find((p) => p.id === sel.id);
      return page ? <GuidePageEditor page={page} onSave={c.updatePage} /> : <Empty t={t} />;
    }
    if (sel.kind === 'endpoint') {
      const r = state.requests.find((x) => x.id === sel.id);
      return r ? <EndpointEditor projectId={projectId} request={r} onSaveDoc={c.saveRequestDoc} /> : <Empty t={t} />;
    }
    return <Empty t={t} />;
  }
}

function Empty({ t }: { t: (k: string) => string }) {
  return <div className="h-full grid place-items-center text-xs text-muted-foreground">{t('docs.selectNode')}</div>;
}

function HeaderToggle({ title, icon, onClick }: { title: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
    >
      {icon}
    </button>
  );
}
