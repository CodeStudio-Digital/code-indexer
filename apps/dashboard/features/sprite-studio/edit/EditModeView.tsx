/**
 * EditModeView — the center surface for the editor mode. Composes the tool
 * rail, contextual options bar, the canvas host, the AI-inpaint bar and the
 * status bar around one EditorEngine drawn from the module registry (so it
 * survives route unmounts). On asset change it fetches the active version PNG
 * and loads it into the engine only when the engine is still empty.
 *
 * Props the parent (SpriteStudioView orchestrator) must pass:
 *   projectId     number                    — IDE project id (engine-registry key part)
 *   asset         SpriteAsset               — the asset being edited
 *   activeVersion AssetVersion | null       — version to load (null → blank doc)
 *   onSaveEdited  (blob: Blob) => void|Promise<void>
 *                                           — receives the exported PNG on Save
 *   onInpaint?    (mask: Blob, prompt: string) => void|Promise<void>
 *                                           — optional; absent → AI bar shows "coming soon"
 *   onEngineReady? (engine: EditorEngine | null) => void
 *                                           — optional; fires with the resolved engine so the
 *                                             inspector's edit cards can operate on the same instance
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FilePlus2, Loader2, Maximize, Redo2, RotateCcw, Save, Undo2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { HoverLabelButton } from '../../../components/ui/hover-label-button.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { versionFileUrl } from '../api.js';
import { EditorEngine } from '../engine/EditorEngine.js';
import { engineKey, getOrCreateEngine, peekEngine } from '../engine/engine-registry.js';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../sprite-studio-ui-state.js';
import { spriteEditorActions, useSpriteEditorStore } from '../store/editor-store.js';
import type { ToolOptions } from '../tools/tool-types.js';
import type { AssetVersion, SpriteAsset } from '../types.js';
import { AiEditBar } from './AiEditBar.js';
import { CanvasStatusBar } from './CanvasStatusBar.js';
import { EditorCanvas } from './EditorCanvas.js';
import { ToolOptionsBar } from './ToolOptionsBar.js';
import { ToolRail } from './ToolRail.js';
import { useEditorShortcuts } from './useEditorShortcuts.js';

/** Fetch a version PNG as a decoded HTMLImageElement (blob URL, revoked after). */
async function loadImage(url: string): Promise<HTMLImageElement> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blobUrl = URL.createObjectURL(await res.blob());
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = blobUrl;
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function EditModeView({
  projectId,
  asset,
  activeVersion,
  onSaveEdited,
  onSaveOverwrite,
  overwritePrimary = false,
  onInpaint,
  onEngineReady,
}: {
  projectId: number;
  asset: SpriteAsset;
  activeVersion: AssetVersion | null;
  onSaveEdited: (blob: Blob) => void | Promise<void>;
  /** Overwrite the loaded version's file in place. Present whenever there's a
   *  version to save over. */
  onSaveOverwrite?: (blob: Blob) => void | Promise<void>;
  /** Focused edit session → overwrite is the primary save (no confirm). In the
   *  normal editor it's a muted secondary and prompts before mutating (it can
   *  rewrite a version shared by several timeline frames). */
  overwritePrimary?: boolean;
  onInpaint?: (maskBlob: Blob, prompt: string) => void | Promise<void>;
  onEngineReady?: (engine: EditorEngine | null) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [gridOn, setGridOn] = useState(true);

  const canUndo = useSpriteEditorStore((s) => s.canUndo);
  const canRedo = useSpriteEditorStore((s) => s.canRedo);

  // Resolve (or create) the engine for this asset and load the active version.
  // Reload rules: (a) empty doc always loads; (b) a DIFFERENT version loads
  // only when there are no unsaved edits (undo/redo stacks empty) — the
  // version list is how you flip between revisions; (c) reloadNonce forces it
  // (the "reload version" button, which discards edits by design).
  useEffect(() => {
    let alive = true;
    let attached: EditorEngine | null = null;
    const versionId = activeVersion?.id ?? null;
    // One engine per IMAGE (version) — editor tabs are per-image, so two
    // frames of the same asset are independent docs with independent undo.
    const key = engineKey(projectId, asset.id, versionId);
    // Cross-asset selection still loading its versions: activeVersion is
    // transiently null while the asset HAS a current version — creating a
    // blank 'new' engine here would flash an empty doc and leak it. BUT if a
    // blank engine with real content already exists (a dirty new-asset doc),
    // attach it instead of hiding it forever behind the spinner.
    if (versionId == null && asset.currentVersionId != null && (peekEngine(key)?.doc.layers.length ?? 0) === 0) {
      setEngine(null);
      onEngineReady?.(null);
      return;
    }
    (async () => {
      const img = versionId != null
        ? await loadImage(versionFileUrl(projectId, versionId, activeVersion?.contentHash)).catch(() => null)
        : null;
      if (!alive) return;
      const w = img?.naturalWidth || asset.width;
      const h = img?.naturalHeight || asset.height;
      const e = getOrCreateEngine(key, () => new EditorEngine(w, h));

      const hasEdits = e.history.canUndo || e.history.canRedo;
      const wantsThisVersion = versionId != null && e.loadedVersionId !== versionId;
      const shouldLoad = e.doc.layers.length === 0 || (wantsThisVersion && !hasEdits);

      if (shouldLoad) {
        if (img) {
          e.loadFromImage(img, versionId);
          setLoadFailed(false);
        } else if (versionId == null) {
          // Genuinely new asset (no versions yet) → blank canvas.
          if (e.doc.layers.length === 0) e.doc.addLayer('Background');
          setLoadFailed(false);
        } else {
          // A version exists but its PNG failed to load: do NOT cache an
          // empty doc as if it were the sprite — surface the failure.
          setLoadFailed(true);
        }
      }
      // Bridge engine summaries into the zustand store while mounted.
      e.setSummaryListener((sum) => spriteEditorActions().applyEngineSummary(sum));
      // Eyedropper picks land in the store (swatches + recent colors); the
      // store→engine color bridge below closes the loop back to painting.
      e.setColorPickListener((hex) => spriteEditorActions().setFgColor(hex));
      // Apply the persisted pixel-grid preference on (re)mount.
      const grid = loadSpriteStudioUi(projectId)?.gridEnabled ?? true;
      e.overlays.setEnabled('pixel-grid', grid);
      setGridOn(grid);
      attached = e;
      setEngine(e);
      onEngineReady?.(e);
    })();
    return () => {
      alive = false;
      onEngineReady?.(null);
      // Drop THIS engine's listeners into the shared store — otherwise every
      // previously-attached (per-version) engine keeps writing summaries into
      // the store, and a stale engine's mutation clobbers the active tab's.
      if (attached) {
        attached.setSummaryListener(null);
        attached.setColorPickListener(null);
      }
    };
  }, [projectId, asset.id, asset.width, asset.height, asset.currentVersionId, activeVersion?.id, onEngineReady]);

  // SINGLE store→engine bridge for colors AND tool options: any change made
  // anywhere reaches the engine, and — crucially — a (re)attached engine is
  // SEEDED from the store. The store survives closing/reopening the editor,
  // but a fresh engine starts at its own defaults: without this seed the bar
  // showed the persisted tolerance while the tool acted as if it were zero
  // until the user dragged a slider (which forced the first sync).
  useEffect(() => {
    if (!engine) return;
    const apply = (s: { fgColor: string; bgColor: string; toolOptions: ToolOptions }) => {
      engine.setColors({ fg: s.fgColor, bg: s.bgColor });
      engine.setToolOptions(s.toolOptions);
    };
    apply(useSpriteEditorStore.getState());
    return useSpriteEditorStore.subscribe((s) => apply(s));
  }, [engine]);

  // Explicit "reload version" — the escape hatch out of ANY bad editor state.
  // Discards unsaved edits by design (the button says so).
  const reloadVersion = async () => {
    const versionId = activeVersion?.id;
    if (!engine || versionId == null) return;
    try {
      const img = await loadImage(versionFileUrl(projectId, versionId, activeVersion?.contentHash));
      engine.loadFromImage(img, versionId);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  };

  useEditorShortcuts(containerRef, engine);

  const save = async (mode: 'new' | 'overwrite') => {
    if (!engine || saving) return;
    // Overwrite is destructive (rewrites the version file in place, affecting
    // every timeline frame that references it) and not version-undoable — so
    // outside a focused session, confirm before doing it.
    if (mode === 'overwrite' && !overwritePrimary) {
      const ok = await confirm({
        title: t('edit.overwriteConfirmTitle'),
        description: t('edit.overwriteConfirmBody'),
        confirmLabel: t('edit.overwrite'),
        tone: 'destructive',
      });
      if (!ok) return;
    }
    setSaving(true);
    // Snapshot the clean point at CLICK time: the canvas stays interactive
    // during the async upload, so strokes painted meanwhile must stay dirty.
    const mark = engine.historyMark;
    try {
      const blob = await engine.exportPngBlob();
      if (mode === 'overwrite' && onSaveOverwrite) await onSaveOverwrite(blob);
      else await onSaveEdited(blob);
      // Clean the doc at the CLICK-time mark: the dot clears and closing stops
      // nagging, while the undo stack survives. For save-as-new this also lets
      // onSaved retire the old-version tab (its content lives in the new
      // version now); strokes painted mid-save keep a newer top → stay dirty.
      engine.markSaved(mark);
    } finally {
      setSaving(false);
    }
  };

  const toggleGrid = () => {
    if (!engine) return;
    const next = !gridOn;
    setGridOn(next);
    engine.overlays.setEnabled('pixel-grid', next);
    engine.invalidate();
    saveSpriteStudioUi(projectId, { gridEnabled: next });
  };

  if (!engine) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div ref={containerRef} tabIndex={-1} className="flex h-full min-h-0 flex-col outline-none">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-muted/10 px-2">
        <Button
          size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={!canUndo}
          onClick={() => engine.undo()} title={t('toolbar.undo')} aria-label={t('toolbar.undo')}
        >
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={!canRedo}
          onClick={() => engine.redo()} title={t('toolbar.redo')} aria-label={t('toolbar.redo')}
        >
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Button
          size="sm" variant="ghost" className="h-6 w-6 p-0"
          onClick={() => engine.fitToView()} title={t('edit.fit')} aria-label={t('edit.fit')}
        >
          <Maximize className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm" variant="ghost" className="h-6 px-1 text-[10px] tabular-nums"
          onClick={() => engine.zoomTo100()} title={t('edit.zoom100')} aria-label={t('edit.zoom100')}
        >
          1:1
        </Button>
        {activeVersion != null && (
          <HoverLabelButton
            icon={RotateCcw}
            label={t('edit.reloadVersion')}
            className="h-6"
            onClick={() => void reloadVersion()}
          />
        )}
        {loadFailed && (
          <span className="flex items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" /> {t('edit.loadFailed')}
          </span>
        )}
        {/* Save affordances — icon + hover-label (git-style). Overwrite is
            available whenever there's a version to save over; "save as new"
            always appends. */}
        {onSaveOverwrite ? (
          // In a focused session overwrite is the primary action; in the normal
          // editor "save as new" is the safe primary and overwrite is a muted
          // (confirmed) secondary.
          <div className="ml-auto flex items-center gap-1">
            <HoverLabelButton
              icon={Save} label={t('edit.overwrite')}
              tone={overwritePrimary ? 'primary' : 'default'} className="h-6"
              busy={saving} onClick={() => void save('overwrite')}
            />
            <HoverLabelButton
              icon={FilePlus2} label={t('edit.saveAsNew')}
              tone={overwritePrimary ? 'default' : 'primary'} className="h-6"
              busy={saving} onClick={() => void save('new')}
            />
          </div>
        ) : (
          <HoverLabelButton
            icon={Save} label={t('edit.save')} tone="primary" className="ml-auto h-6"
            busy={saving} onClick={() => void save('new')}
          />
        )}
      </div>
      <ToolOptionsBar engine={engine} />
      <div className="flex min-h-0 flex-1">
        <ToolRail />
        <EditorCanvas engine={engine} />
      </div>
      <AiEditBar engine={engine} onInpaint={onInpaint} />
      <CanvasStatusBar gridOn={gridOn} onToggleGrid={toggleGrid} engine={engine} />
    </div>
  );
}
