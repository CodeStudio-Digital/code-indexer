/**
 * Left mini rail of the editor — one icon button per tool. Reads/writes
 * editor-store.activeTool (selectors, not props) so switching tools never
 * re-renders the canvas host. Native `title` (perf rule: no Radix Tooltip in
 * hot lists); buttons are memoized so only the two affected buttons repaint on
 * a selection change.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brush, Circle, Eraser, MousePointer2, PaintBucket, Pipette, Move,
  Slash, Sparkles, Square, SquareDashedMousePointer, Wand2,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { useSpriteEditorStore } from '../store/editor-store.js';
import type { ToolId } from '../tools/tool-types.js';

type IconType = React.ComponentType<{ className?: string }>;

/** Ordered rail entries; the labelKey resolves under the `tool.` namespace. */
const RAIL: ReadonlyArray<{ id: ToolId; Icon: IconType; labelKey: string }> = [
  { id: 'pointer', Icon: MousePointer2, labelKey: 'tool.pointer' },
  { id: 'brush', Icon: Brush, labelKey: 'tool.brush' },
  { id: 'eraser', Icon: Eraser, labelKey: 'tool.eraser' },
  { id: 'magic-eraser', Icon: Sparkles, labelKey: 'tool.magicEraser' },
  { id: 'fill', Icon: PaintBucket, labelKey: 'tool.fill' },
  { id: 'line', Icon: Slash, labelKey: 'tool.line' },
  { id: 'shape-rect', Icon: Square, labelKey: 'tool.shapeRect' },
  { id: 'shape-ellipse', Icon: Circle, labelKey: 'tool.shapeEllipse' },
  { id: 'select-rect', Icon: SquareDashedMousePointer, labelKey: 'tool.selectRect' },
  { id: 'select-wand', Icon: Wand2, labelKey: 'tool.selectWand' },
  { id: 'eyedropper', Icon: Pipette, labelKey: 'tool.eyedropper' },
  { id: 'move', Icon: Move, labelKey: 'tool.move' },
];

export function ToolRail() {
  const activeTool = useSpriteEditorStore((s) => s.activeTool);
  const setActiveTool = useSpriteEditorStore((s) => s.setActiveTool);
  return (
    <div className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-r bg-muted/20 py-1.5">
      {RAIL.map(({ id, Icon, labelKey }) => (
        <ToolButton
          key={id}
          id={id}
          Icon={Icon}
          labelKey={labelKey}
          active={activeTool === id}
          onSelect={setActiveTool}
        />
      ))}
    </div>
  );
}

const ToolButton = memo(function ToolButton({
  id,
  Icon,
  labelKey,
  active,
  onSelect,
}: {
  id: ToolId;
  Icon: IconType;
  labelKey: string;
  active: boolean;
  onSelect: (id: ToolId) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const label = t(labelKey);
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
});
