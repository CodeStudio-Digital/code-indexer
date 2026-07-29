import { Suspense, lazy, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, FileEdit, Image as ImageIcon, LayoutPanelLeft, Loader2 } from 'lucide-react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { OpenFile } from '../../../state/workspace.js';
import { cn } from '../../../lib/utils.js';
import { useEnsureFileContent } from './useEnsureFileContent.js';

const MonacoMount = lazy(() =>
  import('./MonacoMount.js').then((module) => ({ default: module.MonacoMount })),
);

type SvgMode = 'edit' | 'preview' | 'split';
const STORAGE_KEY_PREFIX = 'mcp-ide:svg-mode:';

function loadMode(filePath: string): SvgMode {
  if (typeof window === 'undefined') return 'preview';
  try {
    const value = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${filePath}`);
    if (value === 'edit' || value === 'preview' || value === 'split') return value;
  } catch {
    // Storage is only a convenience; preview still works when it is blocked.
  }
  return 'preview';
}

function saveMode(filePath: string, mode: SvgMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${filePath}`, mode);
  } catch {
    // Ignore private-mode/storage policy failures.
  }
}

export function SvgView({ file }: { file: OpenFile }) {
  const { t } = useTranslation('workspace');
  const [mode, setMode] = useState<SvgMode>(() => loadMode(file.path));
  useEnsureFileContent(file);

  const changeMode = (next: SvgMode) => {
    setMode(next);
    saveMode(file.path, next);
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-7 shrink-0 border-b bg-card/40 flex items-center px-2 gap-0.5 text-[10.5px]">
        <ModeButton icon={FileEdit} label={t('editorPreview.edit')} active={mode === 'edit'} onClick={() => changeMode('edit')} />
        <ModeButton icon={Eye} label={t('editorPreview.preview')} active={mode === 'preview'} onClick={() => changeMode('preview')} />
        <ModeButton icon={LayoutPanelLeft} label={t('editorPreview.split')} active={mode === 'split'} onClick={() => changeMode('split')} />
        <span className="ml-auto inline-flex items-center gap-1 font-mono text-muted-foreground/70 text-[10px]">
          <ImageIcon className="h-3 w-3" />
          {file.path.split('/').pop()}
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {mode === 'edit' ? (
          <SvgEditorSurface file={file} />
        ) : mode === 'preview' ? (
          <SvgPreview source={file.content} fileName={file.path.split('/').pop() ?? file.path} />
        ) : (
          <PanelGroup
            direction="horizontal"
            autoSaveId={`mcp-svg-split-${file.projectId}-${file.path}`}
            className="h-full min-w-0"
          >
            <Panel id="svg-source" order={1} defaultSize={50} minSize={20} className="min-w-0">
              <SvgEditorSurface file={file} />
            </Panel>
            <PanelResizeHandle className="w-1.5 bg-border/70 hover:bg-primary/60 transition-colors cursor-col-resize" />
            <Panel id="svg-preview" order={2} defaultSize={50} minSize={20} className="min-w-0">
              <SvgPreview source={file.content} fileName={file.path.split('/').pop() ?? file.path} />
            </Panel>
          </PanelGroup>
        )}
      </div>
    </div>
  );
}

function SvgEditorSurface({ file }: { file: OpenFile }) {
  const { t } = useTranslation('workspace');
  return (
    <div className="relative h-full min-w-0 min-h-0 overflow-hidden">
      <Suspense
        fallback={
          <div className="absolute inset-0 grid place-items-center text-[11px] text-muted-foreground gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t('editorPreview.loadingEditor')}
          </div>
        }
      >
        <MonacoMount file={file} />
      </Suspense>
    </div>
  );
}

function SvgPreview({ source, fileName }: { source: string | null; fileName: string }) {
  const { t } = useTranslation('workspace');
  const previewUrl = useBlobUrl(source, 'image/svg+xml');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setInvalid(false), [previewUrl]);

  return (
    <div
      className="h-full w-full overflow-auto p-5 grid place-items-center"
      style={{
        backgroundColor: 'hsl(var(--muted))',
        backgroundImage:
          'linear-gradient(45deg, hsl(var(--border)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--border)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--border)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--border)) 75%)',
        backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
        backgroundSize: '20px 20px',
      }}
    >
      {source === null || (!previewUrl && !invalid) ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('mediaPreview.preparing')}
        </div>
      ) : invalid ? (
        <div className="max-w-sm text-center text-sm text-muted-foreground">
          <p className="text-foreground font-medium">{t('mediaPreview.invalidSvg')}</p>
          <p className="mt-1 text-xs">{t('mediaPreview.invalidSvgHint')}</p>
        </div>
      ) : (
        <img
          src={previewUrl ?? undefined}
          alt={fileName}
          draggable={false}
          onError={() => setInvalid(true)}
          className="block max-h-full max-w-full object-contain drop-shadow-md select-none"
        />
      )}
    </div>
  );
}

function useBlobUrl(content: string | null, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (content === null || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(new Blob([content], { type }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [content, type]);
  return url;
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
