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
import { AlertTriangle, Loader2, Maximize, Redo2, RotateCcw, Save, Undo2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { versionFileUrl } from '../api.js';
import { EditorEngine } from '../engine/EditorEngine.js';
import { engineKey, getOrCreateEngine } from '../engine/engine-registry.js';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../sprite-studio-ui-state.js';
import { spriteEditorActions, useSpriteEditorStore } from '../store/editor-store.js';
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
  onInpaint,
  onEngineReady,
}: {
  projectId: number;
  asset: SpriteAsset;
  activeVersion: AssetVersion | null;
  onSaveEdited: (blob: Blob) => void | Promise<void>;
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
    const key = engineKey(projectId, asset.id);
    const versionId = activeVersion?.id ?? null;
    (async () => {
      const img = versionId != null
        ? await loadImage(versionFileUrl(projectId, versionId)).catch(() => null)
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
      setEngine(e);
      onEngineReady?.(e);
    })();
    return () => {
      alive = false;
      onEngineReady?.(null);
      // Detach happens inside EditorCanvas; just drop the summary bridge.
    };
  }, [projectId, asset.id, asset.width, asset.height, activeVersion?.id, onEngineReady]);

  // SINGLE store→engine color bridge: any color set anywhere (palette swatch,
  // options-bar picker, X-swap, eyedropper writing back) reaches the engine.
  // Callsites no longer need to remember to call engine.setColors themselves.
  useEffect(() => {
    if (!engine) return;
    const apply = (s: { fgColor: string; bgColor: string }) =>
      engine.setColors({ fg: s.fgColor, bg: s.bgColor });
    apply(useSpriteEditorStore.getState());
    return useSpriteEditorStore.subscribe((s) => apply(s));
  }, [engine]);

  // Explicit "reload version" — the escape hatch out of ANY bad editor state.
  // Discards unsaved edits by design (the button says so).
  const reloadVersion = async () => {
    const versionId = activeVersion?.id;
    if (!engine || versionId == null) return;
    try {
      const img = await loadImage(versionFileUrl(projectId, versionId));
      engine.loadFromImage(img, versionId);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  };

  useEditorShortcuts(containerRef, engine);

  const save = async () => {
    if (!engine || saving) return;
    setSaving(true);
    try {
      const blob = await engine.exportPngBlob();
      await onSaveEdited(blob);
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
          <Button
            size="sm" variant="ghost" className="h-6 gap-1"
            onClick={() => void reloadVersion()}
            title={t('edit.reloadVersionHint')}
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t('edit.reloadVersion')}
          </Button>
        )}
        {loadFailed && (
          <span className="flex items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" /> {t('edit.loadFailed')}
          </span>
        )}
        <Button
          size="sm" variant="outline" className="ml-auto h-6 gap-1"
          disabled={saving} onClick={() => void save()} title={t('edit.save')}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {t('edit.save')}
        </Button>
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
