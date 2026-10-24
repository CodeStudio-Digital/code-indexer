/**
 * DiagramPanel — the chat-side draw.io surface. Hosts the shared DrawioFrame
 * in the wide right panel, fed by the session-keyed diagram store (the SSE
 * handler writes the XML the agent just produced). Editor edits autosave back
 * to the `.drawio` file; the toolbar exports SVG/PNG next to it.
 *
 * Toolbar exports are explicit user actions. Agent exports are owned by the
 * executor; replayed chat events never command this editor to write images.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Workflow } from 'lucide-react';
import { Button } from '../../../../components/ui/button.js';
import { DrawioFrame, type DrawioFrameHandle } from './DrawioFrame.js';
import { getDiagram, subscribeDiagram, setDiagramXml, type DiagramState } from './diagram-store.js';
import { saveDiagramXml, saveDiagramExport } from './diagram-io.js';
import type { DrawioExportFormat } from './drawio-embed.js';

export function DiagramPanel({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: number | null;
}) {
  const { t } = useTranslation(['chat']);
  const [state, setState] = useState<DiagramState | null>(() => getDiagram(sessionId));
  const frameRef = useRef<DrawioFrameHandle>(null);

  // Subscribe to the session's diagram store.
  useEffect(() => {
    setState(getDiagram(sessionId));
    return subscribeDiagram(sessionId, () => setState(getDiagram(sessionId)));
  }, [sessionId]);

  const path = state?.path ?? null;

  const handleChange = (xml: string): void => {
    if (!projectId || !path) return;
    // Keep the store in sync (no-op on identical content) and persist.
    setDiagramXml(sessionId, path, xml);
    void saveDiagramXml(projectId, path, xml).catch(() => {
      /* transient — the editor keeps the in-memory copy */
    });
  };

  const handleExport = (dataUrl: string, format: DrawioExportFormat): void => {
    if (!projectId || !path) return;
    void saveDiagramExport(projectId, path, dataUrl, format).catch(() => {
      /* best-effort image write */
    });
  };

  if (!state) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <Workflow className="h-8 w-8 opacity-40" />
        <p>{t('chat:diagram.empty', 'No diagram open. Ask the draw.io agent to create one — it appears here live.')}</p>
      </div>
    );
  }

  const name = path ? path.replace(/^.*\//, '').replace(/\.drawio$/i, '') : 'diagram';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        <span className="truncate font-mono text-xs text-muted-foreground" title={path ?? ''}>{name}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
            onClick={() => frameRef.current?.exportDiagram('svg')} disabled={!projectId}>
            <Download className="mr-1 h-3.5 w-3.5" /> SVG
          </Button>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
            onClick={() => frameRef.current?.exportDiagram('png')} disabled={!projectId}>
            <Download className="mr-1 h-3.5 w-3.5" /> PNG
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DrawioFrame
          ref={frameRef}
          xml={state.xml}
          title={name}
          onChange={handleChange}
          onSave={handleChange}
          onExport={handleExport}
        />
      </div>
    </div>
  );
}
