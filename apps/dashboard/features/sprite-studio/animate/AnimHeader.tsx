/**
 * Animation selector + creator header of the AnimatePanel: pick an existing
 * animation, or create one (from the local action catalog — name + fps + frame
 * count, custom names allowed) via a compact "+ Create" popover so the header
 * stays a single clean row. Deletion (frame pointers only — versions stay) and
 * GIF export live here too.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { useConfirm } from '../../../components/ui/dialog-provider.js';
import {
  ACTION_PRESETS, gifUrl, listActionPresets, type AnimLoopMode, type ActionPreset, type SpriteAnimation,
} from './api-anim.js';

const CUSTOM = '__custom__';
const selectCls = 'h-7 rounded border bg-background px-2 text-xs';

export function AnimHeader({
  animations,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
  onExport,
}: {
  animations: SpriteAnimation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (input: {
    name: string; fps: number; frames: number; loopMode: AnimLoopMode;
    actionKey: string; direction?: string; exportName: string;
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onExport?: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<string>(ACTION_PRESETS[0].action);
  const [customName, setCustomName] = useState('');
  const [fps, setFps] = useState(ACTION_PRESETS[0].fps);
  const [frames, setFrames] = useState(ACTION_PRESETS[0].frames);
  const [busy, setBusy] = useState(false);
  const [presets, setPresets] = useState<readonly ActionPreset[]>(ACTION_PRESETS);
  const [directions, setDirections] = useState<string[]>(['S', 'N', 'E', 'W', 'side']);
  const [direction, setDirection] = useState('');
  const [loopMode, setLoopMode] = useState<AnimLoopMode>(ACTION_PRESETS[0].loopMode);
  const [exportName, setExportName] = useState(ACTION_PRESETS[0].action);

  useEffect(() => {
    void listActionPresets().then((result) => {
      if (result.actions.length) setPresets(result.actions);
      if (result.directions.length) setDirections(result.directions);
    }).catch(() => { /* offline/backend skew: local fallback remains usable */ });
  }, []);

  const selected = animations.find((a) => a.id === selectedId) ?? null;
  const onAction = (v: string) => {
    setAction(v);
    const preset = presets.find((p) => p.action === v);
    if (preset) { setFps(preset.fps); setFrames(preset.frames); setLoopMode(preset.loopMode); setExportName(preset.action); }
  };

  const create = async () => {
    const name = action === CUSTOM ? customName.trim() : action;
    if (!name || busy) return;
    setBusy(true);
    try {
      await onCreate({
        name, fps, frames, loopMode, actionKey: action === CUSTOM ? name : action,
        direction: direction || undefined, exportName: exportName.trim() || name,
      });
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
        onChange={(e) => onSelect(e.target.value)}
        aria-label={t('animate.title')}
      >
        {animations.length === 0 && <option value="">{t('animate.none')}</option>}
        {animations.map((a) => (
          <option key={a.id} value={a.id}>{`${a.name} · ${a.frames.length}f @ ${a.fps}fps`}</option>
        ))}
      </select>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="default" className="h-8 gap-1 px-3 text-xs">
            <Plus className="h-3 w-3" /> {t('animate.create')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3 p-3">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t('animate.createTitle')}
          </div>
          <select className={`${selectCls} w-full`} value={action} onChange={(e) => onAction(e.target.value)} aria-label={t('animate.action')}>
            {presets.map((p) => (
              <option key={p.action} value={p.action}>{t(`animate.actions.${p.action}`)}</option>
            ))}
            <option value={CUSTOM}>{t('animate.custom')}</option>
          </select>
          {action === CUSTOM && (
            <Input className="h-7 w-full text-xs" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder={t('animate.customNamePlaceholder')} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{t('animate.direction')}</span>
              <select className={`${selectCls} w-full`} value={direction} onChange={(e) => setDirection(e.target.value)}>
                <option value="">{t('animate.dirNone')}</option>
                {directions.map((item) => <option key={item} value={item}>{t(`animate.dir.${item}`, { defaultValue: item })}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{t('animate.preview.loopMode')}</span>
              <select className={`${selectCls} w-full`} value={loopMode} onChange={(e) => setLoopMode(e.target.value as AnimLoopMode)}>
                <option value="loop">{t('animate.preview.loop')}</option>
                <option value="once">{t('animate.preview.once')}</option>
                <option value="pingpong">{t('animate.preview.pingpong')}</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-xs text-muted-foreground">
            <span>{t('animate.exportName')}</span>
            <Input className="h-8 w-full text-xs" value={exportName} onChange={(e) => setExportName(e.target.value)} placeholder={t('animate.exportNamePlaceholder')} />
          </label>
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-1 text-xs text-muted-foreground">
              {t('animate.fps')}
              <Input type="number" min={1} max={60} className="h-7 w-full text-xs" value={fps}
                onChange={(e) => setFps(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} />
            </label>
            <label className="flex flex-1 items-center gap-1 text-xs text-muted-foreground">
              {t('animate.frames')}
              <Input type="number" min={2} max={12} className="h-7 w-full text-xs" value={frames}
                onChange={(e) => setFrames(Math.max(2, Math.min(12, Number(e.target.value) || 2)))} />
            </label>
          </div>
          <Button size="sm" className="h-8 w-full gap-1 text-xs" disabled={busy || !exportName.trim() || (action === CUSTOM && !customName.trim())} onClick={() => void create()}>
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
            <Button size="sm" variant="default" className="h-8 gap-1 px-2 text-xs" onClick={onExport}>
              <Download className="h-3.5 w-3.5" /> {t('animate.exportAnimation')}
            </Button>
          )}
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
