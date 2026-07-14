/**
 * Studio toolbar — segmented Generate|Edit mode switch (ModeBtn pattern from
 * ApiClientTab), the active-asset crumb, and placeholder undo/redo + Export
 * controls. Undo/redo wire to the EditorEngine in M3; Export becomes a
 * dialog in M6 — the buttons reserve the layout so nothing shifts later.
 */
import { useTranslation } from 'react-i18next';
import { Brush, ChevronRight, Download, Film, Redo2, Sparkles, Undo2, type LucideIcon } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import type { StudioMode } from './types.js';

export function StudioToolbar({
  mode,
  onMode,
  assetName,
  contextLabel,
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
  /** Animation/frame breadcrumb appended after the active asset. */
  contextLabel?: string | null;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Absent (M1/M2) → the Export button renders disabled. */
  onExport?: () => void;
}) {
  const { t } = useTranslation('spriteStudio');

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-1.5 text-xs">
      <div className="flex h-full items-stretch" role="tablist" aria-label={t('title')}>
        <ModeBtn icon={Sparkles} active={mode === 'generate'} onClick={() => onMode('generate')}>
          {t('toolbar.generate')}
        </ModeBtn>
        <ModeBtn icon={Brush} active={mode === 'edit'} onClick={() => onMode('edit')}>
          {t('toolbar.edit')}
        </ModeBtn>
        <ModeBtn icon={Film} active={mode === 'animate'} onClick={() => onMode('animate')}>
          {t('toolbar.animate')}
        </ModeBtn>
      </div>
      <span className="h-4 w-px bg-[var(--workbench-border)]" />
      <div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
        <ChevronRight className="h-3 w-3 shrink-0" />
        {assetName ? (
          <>
            <span className="truncate font-medium text-foreground">{assetName}</span>
            {contextLabel && <><ChevronRight className="h-3 w-3 shrink-0" /><span className="truncate text-foreground">{contextLabel}</span></>}
          </>
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
      <span className="h-4 w-px bg-[var(--workbench-border)]" />
      <Button
        size="sm"
        variant="outline"
        className="h-6 gap-1 border-[var(--workbench-border)] bg-[var(--workbench-surface)]"
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
function ModeBtn({
  icon: Icon,
  active,
  onClick,
  children,
}: {
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex h-full items-center gap-1.5 px-2.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${active ? 'bg-[var(--workbench-surface)] font-medium text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:bg-violet-400' : 'text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground'}`}
    >
      <Icon className={`h-3.5 w-3.5 ${active ? 'text-violet-400' : ''}`} />
      {children}
    </button>
  );
}
