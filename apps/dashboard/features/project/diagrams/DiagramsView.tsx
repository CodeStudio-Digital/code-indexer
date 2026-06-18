/**
 * Diagrams workspace — the full-area surface behind the "Diagrams" left-rail
 * destination (mirrors how the Preview tab fills the content area). A sidebar
 * selector of every `.drawio` file (with a "+" to add one) + the chosen diagram
 * on the full canvas.
 *
 * Reuses the shared DrawioFrame + the diagram-io write-back helper, so editing
 * here autosaves to the file just like the chat panel and the editor tab
 * (export lives inside the draw.io UI itself). Listens for
 * `coder:diagram_changed` so an agent-created diagram (saved anywhere) shows up
 * and is selected live.
 */
import { useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from 'react-resizable-panels';
import { PanelLeftClose, PanelLeftOpen, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiCall } from '../../../lib/api-client.js';
import { Button } from '../../../components/ui/button.js';
import { DrawioFrame } from '../../chat/right-panel/diagram/DrawioFrame.js';
import { saveDiagramXml } from '../../chat/right-panel/diagram/diagram-io.js';
import { DiagramList, useDiagramFiles } from './DiagramList.js';

// New diagrams land alongside the ones the agent writes (its DIAGRAMS_DIR is
// also 'diagrams') so manual + agent diagrams share one folder and one list.
const DIAGRAMS_DIR = 'diagrams';

/** Minimal valid `.drawio` — an empty page with the two implicit layer cells. */
const STARTER_XML =
  '<mxfile host="codestudio"><diagram name="Page-1">' +
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" ' +
  'connect="1" arrows="1" fold="1" page="1" pageScale="1" math="0" shadow="0">' +
  '<root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>';

export function DiagramsView({ projectId }: { projectId: number }) {
  const { t } = useTranslation(['chat']);
  const [refreshTick, setRefreshTick] = useState(0);
  const { files } = useDiagramFiles(projectId, refreshTick);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const listPanelRef = useRef<ImperativePanelHandle>(null);
  const [listCollapsed, setListCollapsed] = useState(false);

  // Auto-select the first diagram once the list loads.
  useEffect(() => {
    if (!selectedPath && files.length > 0) setSelectedPath(files[0].path);
  }, [files, selectedPath]);

  // Load the selected diagram's XML from disk.
  useEffect(() => {
    if (!selectedPath) {
      setXml(null);
      return;
    }
    let cancelled = false;
    void apiCall<{ content?: string }>('files.read', { projectId, path: selectedPath })
      .then((res) => {
        if (!cancelled && res && typeof res.content === 'string') setXml(res.content);
      })
      .catch(() => {
        /* deleted/unreadable — leave the last render up */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, projectId]);

  // Live: the agent created/updated a diagram anywhere → refresh the list and
  // jump to it (the event carries the fresh XML, so no extra fetch needed).
  useEffect(() => {
    const onChanged = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string; xml?: string };
      if (!d?.path) return;
      setRefreshTick((n) => n + 1);
      setSelectedPath(d.path);
      if (typeof d.xml === 'string') setXml(d.xml);
    };
    window.addEventListener('coder:diagram_changed', onChanged);
    return () => window.removeEventListener('coder:diagram_changed', onChanged);
  }, []);

  const onChange = (next: string): void => {
    if (selectedPath) void saveDiagramXml(projectId, selectedPath, next).catch(() => {});
  };

  // "+" — create a fresh diagram under `diagrams/` (files.write mkdir -p's the
  // folder), then open the blank canvas ready to draw. Auto-names to avoid a
  // collision; rename later from the file tree.
  const handleCreate = async (): Promise<void> => {
    const taken = new Set(files.map((f) => f.name.toLowerCase()));
    let fileName = 'untitled.drawio';
    for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `untitled-${n}.drawio`;
    const path = `${DIAGRAMS_DIR}/${fileName}`;
    try {
      await apiCall('files.write', { projectId, path, content: STARTER_XML });
    } catch {
      return;
    }
    setRefreshTick((x) => x + 1);
    setSelectedPath(path);
    setXml(STARTER_XML);
  };

  const name = selectedPath ? selectedPath.replace(/^.*\//, '') : '';

  return (
    <div className="flex h-full min-h-0">
      <PanelGroup direction="horizontal" autoSaveId="mcp-diagrams-view" className="min-h-0 flex-1">
        <Panel
          id="diagram-list"
          ref={listPanelRef}
          order={1}
          defaultSize={20}
          minSize={14}
          maxSize={34}
          collapsible
          collapsedSize={0}
          onCollapse={() => setListCollapsed(true)}
          onExpand={() => setListCollapsed(false)}
        >
          <DiagramList
            files={files}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
            onCreate={handleCreate}
          />
        </Panel>
        <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40" />
        <Panel id="diagram-canvas" order={2} defaultSize={80} className="min-w-0">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() =>
                  listCollapsed ? listPanelRef.current?.expand() : listPanelRef.current?.collapse()
                }
                title={t(listCollapsed ? 'chat:diagrams.expandList' : 'chat:diagrams.collapseList')}
              >
                {listCollapsed ? (
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                ) : (
                  <PanelLeftClose className="h-3.5 w-3.5" />
                )}
              </Button>
              {selectedPath && (
                <>
                  <Workflow className="h-3.5 w-3.5 text-violet-300" />
                  <span className="truncate font-mono text-xs text-muted-foreground" title={selectedPath}>
                    {name}
                  </span>
                </>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {selectedPath ? (
                <DrawioFrame xml={xml} title={name} onChange={onChange} onSave={onChange} />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {t('chat:diagrams.pick')}
                </div>
              )}
            </div>
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
