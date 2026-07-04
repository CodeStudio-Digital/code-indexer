/**
 * New-asset modal — name, category (grouped select) and canvas size (preset
 * or custom W×H). Uses the repo's Dialog primitives (same composition as
 * api-client/SaveRequestDialog.tsx).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImagePlus } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { CANVAS_PRESETS, CATEGORY_GROUPS, type SpriteCategory } from '../types.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Studio default canvas size (preselected preset when it matches). */
  defaultSize?: { width: number; height: number };
  onCreate: (input: { name: string; category: SpriteCategory; width: number; height: number }) => Promise<void>;
}

const CUSTOM = 'custom';

export function NewAssetDialog({ open, onOpenChange, defaultSize, onCreate }: Props) {
  const { t } = useTranslation('spriteStudio');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<SpriteCategory>('character');
  const [preset, setPreset] = useState<string>(String(defaultSize?.width ?? 32));
  const [width, setWidth] = useState(defaultSize?.width ?? 32);
  const [height, setHeight] = useState(defaultSize?.height ?? 32);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const w = defaultSize?.width ?? 32;
    const h = defaultSize?.height ?? 32;
    setName('');
    setCategory('character');
    setWidth(w);
    setHeight(h);
    setPreset(w === h && CANVAS_PRESETS.includes(w) ? String(w) : CUSTOM);
    setError(null);
  }, [open, defaultSize?.width, defaultSize?.height]);

  const onPreset = (v: string) => {
    setPreset(v);
    if (v !== CUSTOM) {
      const n = Number(v);
      setWidth(n);
      setHeight(n);
    }
  };

  const valid = name.trim() !== '' && width > 0 && height > 0;

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), category, width, height });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImagePlus className="h-4 w-4" /> {t('newAsset.title')}
          </DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('newAsset.name')}</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newAsset.namePlaceholder')} className="h-8 text-sm" autoFocus />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('newAsset.category')}</span>
          <select className="h-8 rounded border bg-background px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value as SpriteCategory)}>
            {CATEGORY_GROUPS.map((g) => (
              <optgroup key={g.id} label={t(g.labelKey)}>
                {g.categories.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('newAsset.size')}</span>
            <select className="h-8 rounded border bg-background px-2 text-sm" value={preset} onChange={(e) => onPreset(e.target.value)}>
              {CANVAS_PRESETS.map((p) => <option key={p} value={String(p)}>{`${p}x${p}`}</option>)}
              <option value={CUSTOM}>{t('newAsset.custom')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('newAsset.width')}</span>
            <Input type="number" min={1} max={2048} disabled={preset !== CUSTOM} value={width} onChange={(e) => setWidth(Number(e.target.value))} className="h-8 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('newAsset.height')}</span>
            <Input type="number" min={1} max={2048} disabled={preset !== CUSTOM} value={height} onChange={(e) => setHeight(Number(e.target.value))} className="h-8 text-sm" />
          </label>
        </div>
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('newAsset.cancel')}</Button>
          <Button size="sm" disabled={busy || !valid} onClick={() => void create()}>
            {busy ? t('newAsset.creating') : t('newAsset.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
