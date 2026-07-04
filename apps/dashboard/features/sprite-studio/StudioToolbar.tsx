/**
 * Studio toolbar — segmented Generate|Edit mode switch (ModeBtn pattern from
 * ApiClientTab), the active-asset crumb, and placeholder undo/redo + Export
 * controls. Undo/redo wire to the EditorEngine in M3; Export becomes a
 * dialog in M6 — the buttons reserve the layout so nothing shifts later.
 */
import { useTranslation } from 'react-i18next';
import { ChevronRight, Download, Redo2, Undo2 } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import type { StudioMode } from './types.js';

export function StudioToolbar({
  mode,
  onMode,
  assetName,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onExport,
}: {
  mode: StudioMode;
  onMode: (mode: StudioMode) => void;
  /** Active asset's name for the crumb; null → placeholder text. */
  assetName: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Absent (M1/M2) → the Export button renders disabled. */
  onExport?: () => void;
}) {
  const { t } = useTranslation('spriteStudio');

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2 text-xs">
      <div className="flex items-center gap-1 rounded bg-muted/40 p-0.5">
        <ModeBtn active={mode === 'generate'} onClick={() => onMode('generate')}>
          {t('toolbar.generate')}
        </ModeBtn>
        <ModeBtn active={mode === 'edit'} onClick={() => onMode('edit')}>
          {t('toolbar.edit')}
        </ModeBtn>
        <ModeBtn active={mode === 'animate'} onClick={() => onMode('animate')}>
          {t('toolbar.animate')}
        </ModeBtn>
      </div>
      <span className="h-4 w-px bg-border" />
      <div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
        <ChevronRight className="h-3 w-3 shrink-0" />
        {assetName ? (
          <span className="truncate font-medium text-foreground">{assetName}</span>
        ) : (
          <span className="truncate">{t('toolbar.noAsset')}</span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          disabled={!canUndo}
          onClick={onUndo}
          title={t('toolbar.undo')}
          aria-label={t('toolbar.undo')}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          disabled={!canRedo}
          onClick={onRedo}
          title={t('toolbar.redo')}
          aria-label={t('toolbar.redo')}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <span className="h-4 w-px bg-border" />
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1"
        disabled={!onExport}
        onClick={onExport}
        title={t('toolbar.exportSoon')}
      >
        <Download className="h-3.5 w-3.5" /> {t('toolbar.export')}
      </Button>
    </div>
  );
}

/** Segmented mode switch button (pattern: ApiClientTab's ModeBtn). */
function ModeBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded transition-colors ${active ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {children}
    </button>
  );
}
