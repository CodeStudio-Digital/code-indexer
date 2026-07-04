/**
 * Layer list (inspector edit card slot / editor rail). Reads engine.doc.layers
 * directly and drives the document's mutators (add/remove/reorder/visibility/
 * opacity), calling engine.invalidate() after each so the compositor repaints.
 * The document layer API is not reactive, so a local counter forces a re-read
 * after every mutation. Single-layer docs are the common MVP case; the list
 * still works for N layers if more are ever added.
 */
import { memo, useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Combine, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { EditorEngine } from '../engine/EditorEngine.js';
import type { Layer } from '../engine/engine-types.js';
import { useSpriteEditorStore } from '../store/editor-store.js';

export function LayerList({ engine }: { engine: EditorEngine }) {
  const { t } = useTranslation('spriteStudio');
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // Engine-summary layer count: re-reads doc.layers when undo/redo of a
  // flatten (or any snapshot restore) changes the list OUTSIDE this component.
  useSpriteEditorStore((s) => s.layerCount);
  const doc = engine.doc;
  // Top layer first (compositor draws bottom→top, users think top→bottom).
  const ordered = [...doc.layers].reverse();

  const act = (fn: () => void) => { fn(); engine.invalidate(); bump(); };

  /** Merge all layers into one Background layer — undoable snapshot command.
   *  Companion of the multi-layer resize refusal ("flatten first"). */
  const flatten = () => act(() => {
    if (doc.layers.length < 2) return;
    const before = doc.snapshot();
    const merged = doc.flatten();
    for (const l of [...doc.layers]) doc.removeLayer(l.id); // keeps dirty bookkeeping clean
    doc.addLayer('Background', merged);
    engine.history.pushSnapshot(before, doc.snapshot(), 'Flatten');
  });

  return (
    <div className="space-y-1 rounded border p-2">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="flex-1">{t('layers.title')}</span>
        <button
          type="button"
          disabled={doc.layers.length < 2}
          onClick={flatten}
          title={t('layers.flatten')}
          aria-label={t('layers.flatten')}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <Combine className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => act(() => doc.addLayer())}
          title={t('layers.add')}
          aria-label={t('layers.add')}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
      {ordered.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground">{t('layers.empty')}</div>
      ) : (
        <div className="space-y-px">
          {ordered.map((layer, i) => (
            <LayerRow
              key={layer.id}
              layer={layer}
              active={layer.id === doc.activeLayerId}
              canMoveUp={i > 0}
              canMoveDown={i < ordered.length - 1}
              canDelete={doc.layers.length > 1}
              onSelect={() => act(() => { doc.activeLayerId = layer.id; })}
              onToggle={() => act(() => doc.setVisible(layer.id, !layer.visible))}
              onOpacity={(v) => act(() => doc.setOpacity(layer.id, v))}
              onDelete={() => act(() => doc.removeLayer(layer.id))}
              onUp={() => act(() => doc.reorderLayer(layer.id, doc.layers.indexOf(layer) + 1))}
              onDown={() => act(() => doc.reorderLayer(layer.id, doc.layers.indexOf(layer) - 1))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const LayerRow = memo(function LayerRow({
  layer, active, canMoveUp, canMoveDown, canDelete,
  onSelect, onToggle, onOpacity, onDelete, onUp, onDown,
}: {
  layer: Layer; active: boolean;
  canMoveUp: boolean; canMoveDown: boolean; canDelete: boolean;
  onSelect: () => void; onToggle: () => void; onOpacity: (v: number) => void;
  onDelete: () => void; onUp: () => void; onDown: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex items-center gap-1 rounded px-1 py-1 text-[11px]',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
      )}
    >
      <button
        type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }}
        title={layer.visible ? t('layers.hide') : t('layers.show')}
        aria-label={layer.visible ? t('layers.hide') : t('layers.show')}
        className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        {layer.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      </button>
      <span className="min-w-0 flex-1 truncate">{layer.name}</span>
      <input
        type="range" min={0} max={100} value={Math.round(layer.opacity * 100)}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onOpacity(Number(e.target.value) / 100)}
        title={t('layers.opacity')} aria-label={t('layers.opacity')}
        className="h-1 w-12 cursor-pointer accent-primary"
      />
      <button
        type="button" disabled={!canMoveUp} onClick={(e) => { e.stopPropagation(); onUp(); }}
        title={t('layers.moveUp')} aria-label={t('layers.moveUp')}
        className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <button
        type="button" disabled={!canMoveDown} onClick={(e) => { e.stopPropagation(); onDown(); }}
        title={t('layers.moveDown')} aria-label={t('layers.moveDown')}
        className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      <button
        type="button" disabled={!canDelete} onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title={t('layers.delete')} aria-label={t('layers.delete')}
        className="flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-red-400 disabled:opacity-30"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
});
