import { Suspense, lazy, useMemo, useState } from 'react';
import {
  Eye,
  FileCode2,
  FileEdit,
  Home,
  LayoutPanelLeft,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { OpenFile } from '../../../state/workspace.js';
import { cn } from '../../../lib/utils.js';
import {
  buildHtmlPreviewDocument,
  projectPreviewDirectoryUrl,
  projectPreviewRootUrl,
} from './html-preview.js';
import { useEnsureFileContent } from './useEnsureFileContent.js';

const MonacoMount = lazy(() =>
  import('./MonacoMount.js').then((module) => ({ default: module.MonacoMount })),
);

type HtmlMode = 'edit' | 'preview' | 'split';
const STORAGE_KEY_PREFIX = 'mcp-ide:html-mode:';

function loadMode(filePath: string): HtmlMode {
  if (typeof window === 'undefined') return 'preview';
  try {
    const value = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${filePath}`);
    if (value === 'edit' || value === 'preview' || value === 'split') return value;
  } catch {
    // Preview remains available when storage is unavailable.
  }
  return 'preview';
}

function saveMode(filePath: string, mode: HtmlMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${filePath}`, mode);
  } catch {
    // Per-file mode persistence is optional.
  }
}

export function HtmlView({ file }: { file: OpenFile }) {
  const [mode, setMode] = useState<HtmlMode>(() => loadMode(file.path));
  const [scriptsEnabled, setScriptsEnabled] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  useEnsureFileContent(file);

  const changeMode = (next: HtmlMode) => {
    setMode(next);
    saveMode(file.path, next);
  };
  const previewVisible = mode !== 'edit';

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-7 shrink-0 border-b bg-card/40 flex items-center px-2 gap-0.5 text-[10.5px]">
        <ModeButton icon={FileEdit} label="Edit" active={mode === 'edit'} onClick={() => changeMode('edit')} />
        <ModeButton icon={Eye} label="Preview" active={mode === 'preview'} onClick={() => changeMode('preview')} />
        <ModeButton icon={LayoutPanelLeft} label="Split" active={mode === 'split'} onClick={() => changeMode('split')} />
        {previewVisible && (
          <>
            <span className="mx-1 h-3.5 w-px bg-border" />
            <button
              type="button"
              onClick={() => setPreviewRevision((revision) => revision + 1)}
              title="Return to the opened page"
              className="h-5 inline-flex items-center gap-1 px-1.5 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Home className="h-3 w-3" />
              <span>Home</span>
            </button>
            <button
              type="button"
              onClick={() => setScriptsEnabled((enabled) => !enabled)}
              title={scriptsEnabled ? 'Disable JavaScript in preview' : 'Enable JavaScript in the isolated preview'}
              className={cn(
                'h-5 inline-flex items-center gap-1 px-1.5 rounded transition-colors',
                scriptsEnabled
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {scriptsEnabled ? <ShieldAlert className="h-3 w-3" /> : <ShieldCheck className="h-3 w-3" />}
              <span>Scripts {scriptsEnabled ? 'on' : 'off'}</span>
            </button>
          </>
        )}
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-muted-foreground/70 text-[10px]">
          <FileCode2 className="h-3 w-3" />
          {file.path.split('/').pop()}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {mode === 'edit' ? (
          <HtmlEditorSurface file={file} />
        ) : mode === 'preview' ? (
          <HtmlPreview file={file} scriptsEnabled={scriptsEnabled} revision={previewRevision} />
        ) : (
          <PanelGroup
            direction="horizontal"
            autoSaveId={`mcp-html-split-${file.projectId}-${file.path}`}
            className="h-full min-w-0"
          >
            <Panel id="html-source" order={1} defaultSize={50} minSize={20} className="min-w-0">
              <HtmlEditorSurface file={file} />
            </Panel>
            <PanelResizeHandle className="w-1.5 bg-border/70 hover:bg-primary/60 transition-colors cursor-col-resize" />
            <Panel id="html-preview" order={2} defaultSize={50} minSize={20} className="min-w-0">
              <HtmlPreview file={file} scriptsEnabled={scriptsEnabled} revision={previewRevision} />
            </Panel>
          </PanelGroup>
        )}
      </div>
    </div>
  );
}

function HtmlEditorSurface({ file }: { file: OpenFile }) {
  return (
    <div className="relative h-full min-w-0 min-h-0 overflow-hidden">
      <Suspense
        fallback={
          <div className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading editor…
          </div>
        }
      >
        <MonacoMount file={file} />
      </Suspense>
    </div>
  );
}

function HtmlPreview({
  file,
  scriptsEnabled,
  revision,
}: {
  file: OpenFile;
  scriptsEnabled: boolean;
  revision: number;
}) {
  const document = useMemo(
    () => file.content === null ? null : buildHtmlPreviewDocument(
      file.content,
      projectPreviewDirectoryUrl(file.projectId, file.path),
      projectPreviewRootUrl(file.projectId),
    ),
    [file.content, file.projectId, file.path],
  );

  if (document === null) {
    return (
      <div className="h-full grid place-items-center text-xs text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading HTML…
      </div>
    );
  }

  return (
    <iframe
      key={`${file.projectId}:${file.path}:${revision}:${scriptsEnabled ? 'scripts' : 'static'}`}
      srcDoc={document}
      title={`HTML preview: ${file.path}`}
      sandbox={scriptsEnabled ? 'allow-scripts' : ''}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
    />
  );
}

function ModeButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-5 inline-flex items-center gap-1 px-1.5 rounded text-[10.5px] transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}
