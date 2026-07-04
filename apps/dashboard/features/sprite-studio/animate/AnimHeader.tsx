/**
 * Animation selector + creator header of the AnimatePanel: pick an existing
 * animation, or create one (from the local action catalog — name + fps + frame
 * count, custom names allowed) via a compact "+ Create" popover so the header
 * stays a single clean row. Deletion (frame pointers only — versions stay) and
 * GIF export live here too.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import { ACTION_PRESETS, gifUrl, type SpriteAnimation } from './api-anim.js';

const CUSTOM = '__custom__';
const selectCls = 'h-7 rounded border bg-background px-2 text-xs';

export function AnimHeader({
  animations,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: {
  animations: SpriteAnimation[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: (input: { name: string; fps: number; frames: number }) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const { t } = useTranslation('spriteStudio');
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<string>(ACTION_PRESETS[0].action);
  const [customName, setCustomName] = useState('');
  const [fps, setFps] = useState(ACTION_PRESETS[0].fps);
  const [frames, setFrames] = useState(ACTION_PRESETS[0].frames);
  const [busy, setBusy] = useState(false);

  const selected = animations.find((a) => a.id === selectedId) ?? null;
  const onAction = (v: string) => {
    setAction(v);
    const preset = ACTION_PRESETS.find((p) => p.action === v);
    if (preset) { setFps(preset.fps); setFrames(preset.frames); }
  };

  const create = async () => {
    const name = action === CUSTOM ? customName.trim() : action;
    if (!name || busy) return;
    setBusy(true);
    try {
      await onCreate({ name, fps, frames });
      setCustomName('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const ok = await confirm({
      title: t('animate.deleteTitle'),
      description: t('animate.deleteBody', { name: selected.name }),
      confirmLabel: t('animate.deleteConfirm'),
      variant: 'destructive',
    });
    if (ok) await onDelete(selected.id);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {t('animate.title')}
      </span>
      <select
        className={selectCls}
        value={selectedId ?? ''}
        onChange={(e) => onSelect(Number(e.target.value))}
        aria-label={t('animate.title')}
      >
        {animations.length === 0 && <option value="">{t('animate.none')}</option>}
        {animations.map((a) => (
          <option key={a.id} value={a.id}>{`${a.name} · ${a.frames.length}f @ ${a.fps}fps`}</option>
        ))}
      </select>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]">
            <Plus className="h-3 w-3" /> {t('animate.create')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 space-y-2 p-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('animate.createTitle')}
          </div>
          <select className={`${selectCls} w-full`} value={action} onChange={(e) => onAction(e.target.value)} aria-label={t('animate.action')}>
            {ACTION_PRESETS.map((p) => (
              <option key={p.action} value={p.action}>{t(`animate.actions.${p.action}`)}</option>
            ))}
            <option value={CUSTOM}>{t('animate.custom')}</option>
          </select>
          {action === CUSTOM && (
            <Input className="h-7 w-full text-xs" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder={t('animate.customNamePlaceholder')} />
          )}
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-1 text-[10px] text-muted-foreground">
              {t('animate.fps')}
              <Input type="number" min={1} max={60} className="h-7 w-full text-xs" value={fps}
                onChange={(e) => setFps(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
            </label>
            <label className="flex flex-1 items-center gap-1 text-[10px] text-muted-foreground">
              {t('animate.frames')}
              <Input type="number" min={2} max={12} className="h-7 w-full text-xs" value={frames}
                onChange={(e) => setFrames(Math.max(2, Math.min(12, Number(e.target.value) || 2)))} />
            </label>
          </div>
          <Button size="sm" className="h-7 w-full gap-1 text-[11px]" disabled={busy || (action === CUSTOM && !customName.trim())} onClick={() => void create()}>
            <Plus className="h-3 w-3" /> {busy ? t('animate.creating') : t('animate.create')}
          </Button>
        </PopoverContent>
      </Popover>

      {selected && (
        <>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-1.5 text-[11px] text-red-400 hover:bg-red-500/15 hover:text-red-400" onClick={() => void remove()}>
            <Trash2 className="h-3 w-3" /> {t('animate.delete')}
          </Button>
          {selected.frames.length > 0 && (
            <a href={gifUrl(selected.id)} download={`${selected.name}.gif`}>
              <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-[11px]">
                <Download className="h-3 w-3" /> {t('animate.exportGif')}
              </Button>
            </a>
          )}
        </>
      )}
    </div>
  );
}
